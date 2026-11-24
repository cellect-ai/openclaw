import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentStoreRunFixture,
  persistRegistryFixture,
} from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { recordSessionStateEventAsync } from "../sessions/session-state-events.js";
import { prepareSubagentTerminalState } from "../sessions/subagent-terminal-state.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import * as stateRead from "../state/openclaw-state-db-readonly.js";
import { requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import {
  seedProjectionRow,
  withSessionRowProjectionState,
} from "./session-row-projection.test-support.js";
import * as transcript from "./session-transcript-readers.js";
import { describeThreadContinuation } from "./thread-continuation.js";

const key = "agent:main:slack:channel:c123:thread:1785541458.788849";
const timestamp = "2026-11-23T00:00:00.000Z";
afterEach(() => vi.restoreAllMocks());
function withThread(run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  return withSessionRowProjectionState(async (create) => run(await setup(create)));
}
async function setup(create: Parameters<Parameters<typeof withSessionRowProjectionState>[0]>[0]) {
  const cfg = { agents: { entries: { main: {} } }, plugins: { enabled: false } };
  setRuntimeConfigSnapshot(cfg);
  const own = seedProjectionRow(key, {
    sessionId: "owner",
    updatedAt: 100,
    status: "done",
    lastRunId: "new-success",
  });
  const child = seedProjectionRow("agent:main:subagent:child", {
    sessionId: "child",
    parentSessionKey: key,
    updatedAt: 200,
    status: "done",
    lastRunId: "child-success",
  });
  await replaceTranscriptEvents(own.scope, [
    {
      type: "message",
      id: "owner-tool",
      timestamp,
      message: {
        role: "toolResult",
        toolName: "exec",
        isError: true,
        content: [{ type: "text", text: "transcript failure" }],
      },
    },
  ]);
  await replaceTranscriptEvents(child.scope, [
    {
      type: "message",
      id: "child-tool",
      timestamp,
      message: {
        role: "toolResult",
        toolName: "foreign-child-tool",
        content: [{ type: "text", text: "ok" }],
      },
    },
  ]);
  const event = await recordSessionStateEventAsync({
    sessionKey: key,
    sessionId: "owner",
    agentId: "main",
    kind: "run_failed",
    runId: "old-failure",
    actorType: "agent",
    summary: "observed failure",
    occurredAt: 50,
  });
  expect(event).toBeDefined();
  const context = requestContext(cfg);
  const projection = await create({ cfg, context, modelCatalog: [] });
  bindSessionRowProjection(context, () => projection);
  const assertCurrent = vi.fn();
  const assertVisible = vi.fn(async () => {
    await projection.prepareSelection({ metadataOnly: true });
  });
  const inspect = () =>
    describeThreadContinuation({
      context,
      owner: { agentId: "main", sessionKey: key },
      assertCurrent,
      assertVisible,
      includeStatus: true,
    });
  return { own, child, inspect, assertCurrent, assertVisible, projection };
}
describe("Thread descriptive history through native reads", () => {
  it("reads the owner's tool/error with newer child rows and never resumes an observed failure", () =>
    withThread(async ({ inspect }) => {
      const result = await inspect();
      expect(result.status).toMatchObject({
        lastTool: "exec",
        lastToolAt: timestamp,
        lastError: "observed failure",
        latestTask: {
          taskId: "old-failure",
          status: "failed",
          ownerKey: key,
          createdAt: null,
          task: null,
          observationSummary: "observed failure",
        },
        taskCount: 1,
        historyAvailable: true,
        historyComplete: false,
        currentTerminalCoverageComplete: false,
        historyScope: "retained-terminal-observations",
        transcriptComplete: true,
      });
      expect(result.members).toHaveLength(2);
      expect(result.members.every((member) => member.status === "done")).toBe(true);
      expect(result.continuation).toBeUndefined();
    }));
  it("does not fabricate latest tasks from uncorrelated or prior-incarnation events", () =>
    withThread(async ({ inspect }) => {
      await recordSessionStateEventAsync({
        sessionKey: key,
        sessionId: "old-incarnation",
        agentId: "main",
        kind: "run_failed",
        runId: "foreign-failure",
        actorType: "agent",
        summary: "private stale failure",
        occurredAt: 500,
      });
      await recordSessionStateEventAsync({
        sessionKey: key,
        sessionId: "owner",
        agentId: "main",
        kind: "run_failed",
        actorType: "agent",
        summary: "no run identity",
        occurredAt: 600,
      });
      const result = await inspect();
      expect(result.status).toMatchObject({
        latestTask: null,
        taskCount: 1,
        historyComplete: false,
      });
      expect(JSON.stringify(result)).not.toContain("private stale failure");
      expect(result.continuation).toBeUndefined();
    }));
  it("propagates native event-read failure rather than returning empty success", () =>
    withThread(async ({ inspect }) => {
      vi.spyOn(stateRead, "executeExistingOpenClawStateRead").mockRejectedValueOnce(
        new Error("native history unavailable"),
      );
      await expect(inspect()).rejects.toThrow("native history unavailable");
    }));
  it("counts one exact run once and keeps its latest terminal observation", () =>
    withThread(async ({ inspect }) => {
      await recordSessionStateEventAsync({
        sessionKey: key,
        sessionId: "owner",
        agentId: "main",
        kind: "run_completed",
        runId: "old-failure",
        actorType: "agent",
        summary: "corrected completion",
      });
      const result = await inspect();
      expect(result.status).toMatchObject({
        taskCount: 1,
        latestTask: {
          taskId: "old-failure",
          status: "succeeded",
          createdAt: null,
          task: null,
          observationSummary: "corrected completion",
        },
        lastError: "transcript failure",
        currentTerminalCoverageComplete: false,
      });
      expect(result.status?.latestTask?.error).toBeUndefined();
    }));
  it("reads task text only from exact native submitted input, leaving creation time unknown", () =>
    withThread(async ({ own, inspect }) => {
      const recorder = createUserTurnTranscriptRecorder({
        target: { ...own.scope, sessionEntry: own.entry },
        input: {
          text: "Exact original request\n\nComplete context",
          timestamp: 50,
          idempotencyKey: "old-failure:user",
        },
      });
      await recorder.persistApproved();
      await replaceSessionEntry(own.scope, own.entry);
      const result = await inspect();
      expect(result.status?.latestTask).toMatchObject({
        task: "Exact original request\n\nComplete context",
        createdAt: null,
        observationSummary: "observed failure",
      });
      expect(result.continuation).toBeUndefined();
    }));
  it.each([false, true])(
    "correlates the native child producer without a claimed sessionId (replaced=%s)",
    (replaced) =>
      withThread(async ({ child, inspect }) => {
        const runId = "child-success";
        const run = createSubagentStoreRunFixture({
          runId,
          childSessionKey: child.scope.sessionKey,
          childAgentId: "main",
          requesterSessionKey: key,
          childSessionIdentity: { sessionId: replaced ? "stale-child" : child.entry.sessionId },
          createdAt: 10,
          task: "Exact native delegated task",
          completion: { required: false },
          delivery: { status: "not_required" },
        });
        persistRegistryFixture(new Map([[runId, run]]), [runId]);
        try {
          const prepared = prepareSubagentTerminalState({
            childSessionKey: child.scope.sessionKey,
            agentId: "main",
            runId,
            requesterSessionKey: key,
            outcomeStatus: "ok",
          });
          expect(prepared.input.event.sessionId).toBeUndefined();
          await recordSessionStateEventAsync(prepared.input.event);
          const result = await inspect();
          if (replaced) {
            expect(result.status?.latestTask?.taskId).not.toBe(runId);
            expect(result.status?.historyComplete).toBe(false);
          } else {
            expect(result.status).toMatchObject({
              taskCount: 2,
              latestTask: {
                taskId: runId,
                task: "Exact native delegated task",
                createdAt: 10,
                observationSummary: "child run completed",
              },
            });
          }
        } finally {
          persistRegistryFixture(new Map(), [runId]);
        }
      }),
  );
  it("marks a missing native history store unavailable while retaining actual transcript observations", () =>
    withThread(async ({ inspect }) => {
      vi.spyOn(stateRead, "executeExistingOpenClawStateRead").mockResolvedValueOnce(undefined);
      const result = await inspect();
      expect(result.status).toMatchObject({
        historyAvailable: false,
        historyComplete: false,
        taskCount: null,
        latestTask: null,
        lastTool: "exec",
        lastError: "transcript failure",
      });
      expect(result.continuation).toBeUndefined();
    }));
  it.each(["revoked", "replaced"])(
    "refuses %s identity after the awaited transcript read",
    (kind) =>
      withThread(async ({ own, inspect, assertCurrent }) => {
        const read = transcript.readSessionTranscriptBoundedMessageTailPageAsync;
        vi.spyOn(
          transcript,
          "readSessionTranscriptBoundedMessageTailPageAsync",
        ).mockImplementationOnce(async (...args) => {
          const result = await read(...args);
          if (kind === "revoked")
            assertCurrent.mockImplementation(() => {
              throw new Error("caller revoked");
            });
          else
            await replaceSessionEntry(own.scope, {
              ...own.entry,
              sessionId: "replacement",
              updatedAt: 700,
            });
          return result;
        });
        await expect(inspect()).rejects.toThrow(kind === "revoked" ? "caller revoked" : "changed");
      }),
  );
  it("reports byte-bounded transcript omissions explicitly", () =>
    withThread(async ({ own, inspect }) => {
      await replaceTranscriptEvents(own.scope, [
        {
          type: "message",
          id: "too-large",
          timestamp,
          message: {
            role: "toolResult",
            toolName: "exec",
            content: [{ type: "text", text: "x".repeat(1024 * 1024 + 100) }],
          },
        },
      ]);
      const result = await inspect();
      expect(result.status).toMatchObject({
        lastTool: null,
        lastToolAt: null,
        transcriptComplete: false,
      });
    }));
});
