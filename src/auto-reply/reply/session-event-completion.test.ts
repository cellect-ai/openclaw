import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import {
  completionConfig,
  admitModelTurn,
} from "../../agents/bash-tools.lifecycle.test-support.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  clearRunFinalDeliveriesForTest,
  recordRunFinalDelivered,
} from "../../infra/run-final-deliveries.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueRequiredSystemEventEntry,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "./session-event-handoff.js";
import * as targets from "./session-event-target.js";

// mock-isolation: Only model inference is synthetic; occurrence custody, native
// reply admission, transcript settlement and silence handling use current owners.
vi.mock("../../agents/embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const model = vi.mocked(runEmbeddedAgent);
await Promise.all([
  import("../dispatch.js"),
  import("./get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);
afterEach(() => {
  clearRunFinalDeliveriesForTest();
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

it.for([
  "fresh",
  "answered",
  "superseded failure",
  "previous generation",
  "collected during preparation",
  "mixed collection",
  "retired target",
] as const)(
  "admits an exact async completion through the current owner: %s",
  async (mode, { signal }) => {
    await withOpenClawTestState(
      { label: "post-final-completion", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const cfg = completionConfig(state.workspaceDir);
        setRuntimeConfigSnapshot(cfg);
        await state.writeConfig(cfg);
        openOpenClawStateDatabase();
        const scope = { agentId: "main", sessionKey: "agent:main:post-final-completion" };
        await replaceSessionEntry(scope, { sessionId: randomUUID(), updatedAt: Date.now() });
        const generation = getAgentEventLifecycleGeneration();
        if (mode !== "fresh" && mode !== "collected during preparation") {
          recordRunFinalDelivered({
            sessionKey: scope.sessionKey,
            runId: "origin",
            at: 1000,
            generation: mode === "previous generation" ? `${generation}:retired` : generation,
          });
        }
        if (mode === "superseded failure") {
          recordRunFinalDelivered({ sessionKey: scope.sessionKey, runId: "later", at: 2000 });
        }
        model.mockReset().mockImplementation(async (params) => {
          await admitModelTurn(params);
          return { payloads: [{ text: "NO_REPLY" }], meta: { durationMs: 1 } };
        });
        const target = await captureSessionEventTargetForHost(scope.agentId, scope.sessionKey);
        const text =
          mode === "superseded failure"
            ? "Exec failed (synthetic, code 1): finalization failed"
            : "Exec completed (synthetic, code 0): result ready";
        const original = enqueueRequiredSystemEventEntry(text, { sessionKey: scope.sessionKey });
        expect(original).toBeDefined();
        if (!original) throw new Error("Missing original completion");
        const prepare = targets.prepareSessionEventTargetForHost;
        if (mode === "retired target") rotateAgentEventLifecycleGeneration();
        if (mode === "collected during preparation" || mode === "mixed collection") {
          vi.spyOn(targets, "prepareSessionEventTargetForHost").mockImplementationOnce(
            async (...args) => {
              const prepared = await prepare(...args);
              consumeSelectedSystemEventEntries(scope.sessionKey, [original]);
              if (mode === "collected during preparation")
                enqueueRequiredSystemEventEntry(text, { sessionKey: scope.sessionKey });
              return prepared;
            },
          );
        }
        const receipt = enqueueSessionEventForHost(text, {
          ...scope,
          source: "exec",
          sourceRunId: "origin",
          replyExpectation: "optional",
          expectedTarget: target,
          occurrences: [original],
          deliver: false,
          abortSignal: signal,
        });
        const outcome = await withinTest(receipt.settled, signal);
        if (mode === "mixed collection") {
          // Native exec producers own separate occurrences: collection of one
          // completion cannot suppress the still-unreviewed failure of another.
          expect(outcome.executionStarted).toBe(false);
          const second = enqueueSessionEventForHost("Exec failed (other, code 1): import failed", {
            ...scope,
            source: "exec",
            sourceRunId: "origin",
            replyExpectation: "optional",
            expectedTarget: target,
            deliver: false,
            abortSignal: signal,
          });
          const secondOutcome = await withinTest(second.settled, signal);
          expect(secondOutcome.error).toBeUndefined();
          expect(secondOutcome).toMatchObject({ status: "completed" });
          expect(model).toHaveBeenCalledOnce();
          expect(model.mock.lastCall![0].prompt).toContain("import failed");
          expect(model.mock.lastCall![0].prompt).not.toContain("result ready");
          expect(peekSystemEventEntries(scope.sessionKey)).toEqual([]);
        } else if (mode === "retired target") {
          expect(outcome.executionStarted).toBe(false);
          expect(model).not.toHaveBeenCalled();
          expect(peekSystemEventEntries(scope.sessionKey)).toEqual([]);
        } else if (mode === "collected during preparation") {
          expect(outcome.executionStarted).toBe(false);
          expect(model).not.toHaveBeenCalled();
          const remaining = peekSystemEventEntries(scope.sessionKey);
          expect(remaining).toHaveLength(1);
          expect(remaining[0]?.id).not.toBe(original.id);
          expect(remaining[0]?.text).toBe(text);
        } else {
          // Expose the native admission error instead of hiding it behind status fields.
          expect(outcome.error).toBeUndefined();
          expect(outcome).toMatchObject({ status: "completed", delivered: false });
          expect(model).toHaveBeenCalledOnce();
          const params = model.mock.lastCall![0];
          expect(params.terminalReplyExpectation).toBe("optional");
          expect(params.prompt).toContain(text);
          expect(params.prompt).toContain("Do not repeat completed actions");
          if (mode === "answered" || mode === "superseded failure") {
            expect(params.prompt).toContain("Post only if this result changes the answer");
            expect(params.prompt).toContain("Continue any unfinished work");
          } else {
            expect(params.prompt).not.toContain("after a reply was already delivered");
          }
          expect(peekSystemEventEntries(scope.sessionKey)).toEqual([]);
        }
      },
    );
  },
);
