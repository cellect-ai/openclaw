import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import * as agentEvents from "../infra/agent-events.js";
import { captureAgentRunPersistence } from "../infra/agent-run-persistence.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

it.each(["commit", "failure"] as const)(
  "keeps real Gateway databases until required persistence %s settles",
  async (mode) => {
    const fixture = await createGatewayMetadataCloseFixture(`required-persistence-${mode}`);
    const release = createDeferred();
    const entered = createDeferred();
    const failure = new Error("synthetic required lifecycle write failed");
    let first = true;
    let receipt: ReturnType<typeof captureAgentRunPersistence> | undefined;
    let closing: Promise<unknown> | undefined;
    try {
      const { server } = await fixture.startServer();
      const options = { agentId: "main", env: fixture.state.env };
      const agent = openOpenClawAgentDatabase(options).db;
      const shared = openOpenClawStateDatabase(options).db;
      receipt = captureAgentRunPersistence(
        {},
        {
          run: async () => {
            await release.promise;
            if (first && mode === "failure") {
              first = false;
              throw failure;
            }
          },
        },
      );
      const drain = agentEvents.drainRequiredAgentRunPersistence;
      vi.spyOn(agentEvents, "drainRequiredAgentRunPersistence").mockImplementation(() => {
        entered.resolve();
        return drain();
      });
      let settled = false;
      closing = server
        .close({ reason: "required persistence close proof" })
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      await awaitGateBeforeSettlement(
        entered.promise,
        closing,
        "Gateway skipped required persistence",
      );
      expect(settled).toBe(false);
      expect(agent.isOpen).toBe(true);
      expect(shared.isOpen).toBe(true);
      release.resolve();
      const outcome = await closing;
      if (mode === "failure") {
        expect(collectNestedErrorCandidates(outcome)).toContain(failure);
        expect(agent.isOpen).toBe(true);
        expect(shared.isOpen).toBe(true);
      } else {
        expect(outcome).toBeUndefined();
        expect(agent.isOpen).toBe(false);
        expect(shared.isOpen).toBe(false);
      }
    } finally {
      release.resolve();
      await Promise.allSettled([closing, receipt?.pending]);
      // Resolve this test's exact failed obligation; never clear unrelated custody.
      await receipt?.retry();
      vi.restoreAllMocks();
      await fixture.cleanup();
    }
  },
);
