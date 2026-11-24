import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  emitAgentEvent,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  awaitAgentRunAdmission,
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunContext,
  getAgentRunLifecycleGeneration,
} from "../../infra/agent-run-registry.js";
import {
  registerConversationLifecycleTransport,
  type ConversationLifecyclePublication,
} from "../../infra/conversation-lifecycle.js";
import * as worker from "../../infra/delivery-queue-worker-store.js";
import { getRpcSource } from "../../sessions/session-controller.rpc-sources.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { markChatAbortTerminalOutcome } from "../chat-abort-lifecycle-internal.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createChatSendDispatchErrorLifecycle } from "./chat-send-dispatch-errors.js";
import { registerRpcSourceForTest } from "./rpc-source-fixtures.test-support.js";

type Options = {
  signals?: boolean;
  hidden?: boolean;
  nativeOwned?: boolean;
  queued?: boolean;
  noScheduler?: boolean;
  persistUserTurn?: () => Promise<void>;
};
async function withBoundDispatch(
  options: Options,
  check: (fixture: Awaited<ReturnType<typeof prepare>>) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    resetAgentEventsForTest();
    const fixture = await prepare(state, options);
    try {
      await check(fixture);
    } finally {
      await fixture.close();
      resetAgentEventsForTest();
    }
  });
}
async function prepare(state: { stateDir: string; sessionsDir: () => string }, options: Options) {
  const target = {
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "room-dispatch-failure",
    storePath: path.join(state.sessionsDir(), "sessions.json"),
  };
  const runId = "room-dispatch-failure-run";
  await upsertSessionEntryCore(target, {
    sessionId: target.sessionId,
    updatedAt: 1000,
    startedAt: 1000,
    lifecycleRunId: runId,
  });
  await appendTranscriptMessage(target, { message: { role: "user", content: "Please continue." } });
  const time = createGatewaySchedulerClock(1000);
  const scheduler = createTestGatewayScheduler(time.clock);
  const facts: ConversationLifecyclePublication[] = [];
  const transport = registerConversationLifecycleTransport({
    transportId: "dispatch-failure-room",
    stateDir: state.stateDir,
    resolveBindings: () => [
      {
        environment: "test",
        conversationId: "conversation-0001",
        roomId: "!room:matrix.test",
        bindingId: "binding-0001",
        accountId: "test",
        threadRootEventId: "$root",
        sessionKey: target.sessionKey,
        agentId: target.agentId,
      },
    ],
    publish: async (_binding, event) => {
      facts.push(event);
    },
    signals: () => options.signals !== false,
    onError: vi.fn(),
  });
  await transport.ready;
  const context = createDirectChatContext({
    lifecycleScheduler: options.noScheduler ? undefined : scheduler,
  });
  type DispatchOwner = {
    lifecycle: ReturnType<typeof createChatSendDispatchErrorLifecycle>;
    cleanup: ReturnType<typeof vi.fn<() => void>>;
    registration: ReturnType<typeof registerRpcSourceForTest>;
  };
  const owners: DispatchOwner[] = [];
  const handling: Promise<void>[] = [];
  function createOwner(sessionId = target.sessionId): DispatchOwner {
    const lifecycleGeneration = getAgentRunLifecycleGeneration();
    const registration = registerRpcSourceForTest({
      runId,
      sessionId,
      sessionKey: target.sessionKey,
      agentId: target.agentId,
      storeScope: target.storePath,
      lifecycleGeneration,
    });
    registration.initializeTiming({ now: 1000 });
    const cleanup = vi.fn(() => registration.cleanup());
    const lifecycle = createChatSendDispatchErrorLifecycle({
      admission: { lifecycleGeneration, activeRunAbort: registration, cleanupAdmittedRun: cleanup },
      context,
      isQueuedFollowupEnqueued: () => options.queued === true,
      isAgentRunStarted: () => false,
      persistUserTurnTranscript: options.persistUserTurn ?? vi.fn(async () => undefined),
      userTurnRecorder: { hasPersisted: () => !options.persistUserTurn, isBlocked: () => false },
      session: {
        agentId: target.agentId,
        storePath: target.storePath,
        cfg: {},
        clientRunId: runId,
        now: 1000,
        rawSessionKey: target.sessionKey,
        sessionKey: target.sessionKey,
      },
    });
    const owner = { lifecycle, cleanup, registration };
    owners.push(owner);
    return owner;
  }
  async function claim(sessionId = target.sessionId) {
    claimAgentRunContext(runId, {
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      sessionId,
      lifecycleGeneration: getAgentRunLifecycleGeneration(),
      ...(options.hidden ? { projectSessionMessages: false } : {}),
    });
    const owner = getAgentRunContext(runId)!;
    await awaitAgentRunAdmission(runId, owner);
    return owner;
  }
  const original = await claim();
  await transport.flush();
  const owner = createOwner();
  if (options.nativeOwned) markChatAbortTerminalOutcome(owner.registration.entry);
  const execute = worker.executeDeliveryQueueOperation;
  let blocked = false;
  const writes = vi.spyOn(worker, "executeDeliveryQueueOperation").mockImplementation((...args) => {
    if (blocked && args[2].type === "deliveryQueue.lifecycleRecord")
      return Promise.reject(new Error("fixture native enqueue unavailable"));
    return execute(...args);
  });
  const start = (selected = owner) => {
    const pending = selected.lifecycle.handleError(new Error("429 rate limit exceeded"));
    handling.push(pending);
    void pending.catch(() => undefined);
    return pending;
  };
  return {
    target,
    runId,
    owner,
    original,
    facts,
    context,
    scheduler,
    time,
    transport,
    claim,
    createOwner,
    start,
    finish: (selected = owner) => selected.lifecycle.finalize(),
    block: (value: boolean) => {
      blocked = value;
    },
    waitForRetry: () => vi.waitFor(() => expect(scheduler.nextWakeAtMs).toBe(6000)),
    close: async () => {
      await scheduler.stop();
      await Promise.allSettled(handling);
      for (const entry of owners) entry.registration.cleanup();
      writes.mockRestore();
      await transport.stop().catch(() => undefined);
      clearAgentRunContext(runId, getAgentRunLifecycleGeneration());
    },
  };
}

it("persists a bound admitted dispatch failure before native cleanup", async () => {
  await withBoundDispatch({}, async (f) => {
    await f.start();
    await f.finish();
    await f.transport.flush();
    expect(loadSessionEntry(f.target)).toMatchObject({ status: "failed", lastRunId: f.runId });
    expect(f.facts.map((fact) => fact.state)).toEqual(["queued", "failed"]);
    expect(f.facts.at(-1)).toMatchObject({ failureKind: "rate_limit" });
    expect(f.owner.cleanup).toHaveBeenCalledOnce();
  });
});
it("retains admission and retries the exact terminal occurrence once storage returns", async () => {
  await withBoundDispatch({}, async (f) => {
    f.block(true);
    const pending = f.start();
    await f.waitForRetry();
    expect(f.owner.cleanup).not.toHaveBeenCalled();
    expect(getAgentRunContext(f.runId)).toBe(f.original);
    expect(f.context.dedupe.size).toBe(0);
    f.block(false);
    await f.time.advanceTo(6000);
    await pending;
    await f.finish();
    await f.transport.flush();
    expect(f.facts.map((fact) => fact.state)).toEqual(["queued", "failed"]);
    expect(f.facts.at(-1)?.revision).toBe(2);
    expect(f.owner.cleanup).toHaveBeenCalledOnce();
    expect(f.scheduler.nextWakeAtMs).toBeNull();
  });
});
it("keeps unresolved terminal custody visible when its scheduler closes", async () => {
  await withBoundDispatch({}, async (f) => {
    f.block(true);
    const pending = f.start();
    await f.waitForRetry();
    await f.scheduler.stop();
    await expect(pending).rejects.toThrow("unresolved at Gateway shutdown");
    await expect(f.finish()).rejects.toThrow("unresolved at Gateway shutdown");
    expect(f.context.dedupe.size).toBe(0);
    expect(f.owner.cleanup).not.toHaveBeenCalled();
    expect(getAgentRunContext(f.runId)).toBe(f.original);
  });
});
it.each([false, true])(
  "never transfers a stale terminal to its successor (rotation: %s)",
  async (rotation) => {
    await withBoundDispatch({}, async (f) => {
      f.block(true);
      const pending = f.start();
      await f.waitForRetry();
      f.owner.registration.cleanup();
      clearAgentRunContext(f.runId, getAgentRunLifecycleGeneration());
      f.block(false);
      if (rotation) rotateAgentEventLifecycleGeneration();
      const replacement = await f.claim("replacement-session");
      const successor = f.createOwner("replacement-session");
      await f.time.advanceTo(6000);
      await expect(pending).rejects.toThrow("owner changed");
      await expect(f.finish()).rejects.toThrow("owner changed");
      expect(getAgentRunContext(f.runId)).toBe(replacement);
      expect(getRpcSource(f.runId)).toBe(successor.registration.entry);
      expect(f.context.dedupe.size).toBe(0);
    });
  },
);
it("does not clear a successor installed while the prior source saves its user turn", async () => {
  const entered = createDeferredCore(),
    release = createDeferredCore();
  await withBoundDispatch(
    {
      persistUserTurn: async () => {
        entered.resolve();
        await release.promise;
      },
    },
    async (f) => {
      await f.start();
      const finalizing = f.finish();
      await entered.promise;
      clearAgentRunContext(f.runId, getAgentRunLifecycleGeneration());
      const replacement = await f.claim("replacement-session");
      const successor = f.createOwner("replacement-session");
      release.resolve();
      await finalizing;
      expect(getAgentRunContext(f.runId)).toBe(replacement);
      expect(getRpcSource(f.runId)).toBe(successor.registration.entry);
      expect(f.context.dedupe.size).toBe(0);
      expect(f.context.removeChatRun).not.toHaveBeenCalled();
    },
  );
});
it("refuses cleanup when an embedded caller has no retry scheduler", async () => {
  await withBoundDispatch({ noScheduler: true }, async (f) => {
    f.block(true);
    await expect(f.start()).rejects.toThrow("fixture native enqueue unavailable");
    await expect(f.finish()).rejects.toThrow("fixture native enqueue unavailable");
    expect(getAgentRunContext(f.runId)).toBe(f.original);
    expect(f.owner.cleanup).not.toHaveBeenCalled();
  });
});
it.each(["signals-off", "hidden", "native-owned", "queued"] as const)(
  "preserves %s projection ownership",
  async (mode) => {
    await withBoundDispatch(
      {
        signals: mode !== "signals-off",
        hidden: mode === "hidden",
        nativeOwned: mode === "native-owned",
        queued: mode === "queued",
      },
      async (f) => {
        if (mode === "native-owned")
          emitAgentEvent({
            runId: f.runId,
            stream: "lifecycle",
            data: { phase: "error", executionSettled: true, error: "429 rate limit exceeded" },
          });
        await f.start();
        await f.finish();
        await f.transport.flush();
        if (mode === "hidden") expect(f.facts).toEqual([]);
        else if (mode === "queued")
          expect(f.facts.some((fact) => fact.state === "failed")).toBe(false);
        else {
          expect(f.facts.filter((fact) => fact.state === "failed")).toHaveLength(1);
          if (mode === "signals-off")
            for (const fact of f.facts) expect(fact).not.toHaveProperty("failureKind");
        }
      },
    );
  },
);
