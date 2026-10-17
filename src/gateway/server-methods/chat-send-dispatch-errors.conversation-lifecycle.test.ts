import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { emitAgentEvent, rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunContext,
  getAgentRunLifecycleGeneration,
} from "../../infra/agent-run-registry.js";
import {
  registerConversationLifecycleTransport,
  type ConversationLifecyclePublication,
} from "../../infra/conversation-lifecycle.js";
import * as custody from "../../infra/delivery-queue-sqlite.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "../chat-abort.js";
import type { ChatAbortControllerEntry } from "../chat-abort.types.js";
import { createChatRunState } from "../server-chat-state.js";
import { terminalizeRestartSafeChatAdmission } from "./chat-restart-recovery.js";
import { createChatSendDispatchErrorLifecycle } from "./chat-send-dispatch-errors.js";

const failure = () => new Error("429 rate limit exceeded");
type DispatchOwner = {
  lifecycle: ReturnType<typeof createChatSendDispatchErrorLifecycle>;
  cleanup: Mock<() => void>;
  registration: ReturnType<typeof registerChatAbortController>;
};
type Options = {
  restartSafe?: boolean;
  signals?: boolean;
  hidden?: boolean;
  nativeOwned?: boolean;
  queued?: boolean;
  noScheduler?: boolean;
  terminalize?: () => Promise<boolean>;
};
async function withBoundDispatch(
  options: Options,
  check: (fixture: Awaited<ReturnType<typeof prepare>>) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const fixture = await prepare(state, options);
    try {
      await check(fixture);
    } finally {
      await fixture.close();
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
    updatedAt: 1_000,
    startedAt: 1_000,
    lifecycleRunId: runId,
    status: "running",
    ...(options.restartSafe
      ? { restartRecoveryDeliveryRunId: runId, restartRecoveryDeliverySourceRunId: runId }
      : {}),
  });
  await appendTranscriptMessage(target, { message: { role: "user", content: "Please continue." } });
  const time = createGatewaySchedulerClock(1_000),
    scheduler = createTestGatewayScheduler(time.clock);
  const facts: ConversationLifecyclePublication[] = [],
    errors = vi.fn(),
    warn = vi.fn();
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
    onError: errors,
  });
  const context = {
    lifecycleScheduler: options.noScheduler ? undefined : scheduler,
    agentRunSeq: new Map<string, number>(),
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
    chatRunState: createChatRunState(),
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
    getSessionEventSubscriberConnIds: () => new Set<string>(),
    logGateway: { warn },
    nodeSendToSession: vi.fn(),
    removeChatRun: vi.fn(),
  };
  const owners: DispatchOwner[] = [];
  const pending: Promise<void>[] = [];
  const finalized = new Set<DispatchOwner>();
  function createOwner(sessionId = target.sessionId): DispatchOwner {
    const lifecycleGeneration = getAgentRunLifecycleGeneration();
    const registration = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId,
      sessionId,
      sessionKey: target.sessionKey,
      agentId: target.agentId,
      lifecycleGeneration,
      now: 1_000,
      timeoutMs: 60_000,
    });
    const cleanup = vi.fn(() => registration.cleanup());
    const lifecycle = createChatSendDispatchErrorLifecycle({
      admission: {
        sessionBinding: { ...target, sessionId, lifecycleGeneration },
        lifecycleGeneration,
        restartSafeAdmission: options.restartSafe ? { requestFingerprint: "fixture" } : undefined,
        activeRunAbort: registration,
        cleanupAdmittedRun: cleanup,
      } as never,
      context: context as never,
      isQueuedFollowupEnqueued: () => options.queued === true,
      isAgentRunStarted: () => false,
      persistUserTurnTranscript: vi.fn(),
      userTurnRecorder: { hasPersisted: () => true, isBlocked: () => false },
      session: {
        ...target,
        backingSessionId: sessionId,
        cfg: {},
        clientRunId: runId,
        now: 1_000,
        rawSessionKey: target.sessionKey,
      },
      terminalizeRestartSafeAdmission:
        options.terminalize ??
        ((terminal) =>
          terminalizeRestartSafeChatAdmission({
            ...terminal,
            ...target,
            admittedSessionId: sessionId,
            clientRunId: runId,
            startedAt: 1_000,
          })),
    });
    const owner = { lifecycle, cleanup, registration };
    owners.push(owner);
    return owner;
  }
  function claim(sessionId = target.sessionId) {
    claimAgentRunContext(runId, {
      ...target,
      sessionId,
      lifecycleGeneration: getAgentRunLifecycleGeneration(),
      ...(options.hidden ? { projectSessionMessages: false } : {}),
    });
    return getAgentRunContext(runId)!;
  }
  const original = claim();
  await transport.flush();
  expect(facts.map((fact) => fact.state)).toEqual(options.hidden ? [] : ["queued"]);
  const owner = createOwner();
  if (options.nativeOwned && owner.registration.entry) {
    owner.registration.entry.projectSessionTerminalPending = true;
  }
  const upsert = custody.upsertDeliveryQueueEntry;
  let writesBlocked = false;
  const writes = vi
    .spyOn(custody, "upsertDeliveryQueueEntry")
    .mockImplementation((input, scope) => {
      if (writesBlocked && input.queueName === "conversation-lifecycle-v2") {
        throw new Error("fixture native enqueue unavailable");
      }
      return upsert(input, scope);
    });
  function start(selected = owner) {
    const work = selected.lifecycle.handleError(failure());
    pending.push(work);
    // Deliberately asserted rejects are still observed until fixture teardown.
    void work.catch(() => undefined);
    return work;
  }
  async function finish(selected = owner) {
    try {
      await selected.lifecycle.finalize();
    } finally {
      finalized.add(selected);
    }
  }
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
    warn,
    errors,
    claim,
    createOwner,
    start,
    finish,
    block: (blocked: boolean) => {
      writesBlocked = blocked;
    },
    close: async () => {
      await scheduler.stop();
      await Promise.allSettled(pending);
      for (const selected of owners) {
        if (!finalized.has(selected)) {
          await finish(selected).catch(() => undefined);
        }
        if (selected.registration.entry) {
          selected.registration.entry.projectSessionTerminalPending = false;
        }
        selected.registration.cleanup();
      }
      writes.mockRestore();
      transport.stop();
      clearAgentRunContext(runId, getAgentRunLifecycleGeneration());
    },
  };
}

it.each([false, true])(
  "publishes a bound admitted dispatch failure with its kind (restart-safe: %s)",
  async (restartSafe) => {
    await withBoundDispatch({ restartSafe }, async (f) => {
      await f.start();
      await f.finish();
      await f.transport.flush();
      expect(loadSessionEntry(f.target)).toMatchObject({ status: "failed", lastRunId: f.runId });
      expect(f.errors).not.toHaveBeenCalled();
      expect(f.warn).not.toHaveBeenCalled();
      expect(f.facts.map((fact) => fact.state)).toEqual(["queued", "failed"]);
      expect(f.facts.at(-1)).toMatchObject({ failureKind: "rate_limit" });
      expect(f.owner.cleanup).toHaveBeenCalledOnce();
    });
  },
);
it("retains admitted work through a failed native enqueue and retries only terminal persistence", async () => {
  await withBoundDispatch({}, async (f) => {
    f.block(true);
    const handling = f.start();
    expect(f.owner.cleanup).not.toHaveBeenCalled();
    expect(getAgentRunContext(f.runId)).toBe(f.original);
    expect(f.owner.registration.entry?.isAbortable?.(f.owner.registration.entry)).toBe(false);
    expect(f.scheduler.nextWakeAtMs).toBe(6_000);
    expect(f.context.dedupe.size).toBe(0);
    f.block(false);
    await f.time.advanceTo(6_000);
    await handling;
    await f.finish();
    await f.transport.flush();
    expect(f.facts.map((fact) => fact.state)).toEqual(["queued", "failed"]);
    expect(f.facts.at(-1)).toMatchObject({ failureKind: "rate_limit" });
    expect(f.owner.cleanup).toHaveBeenCalledOnce();
    expect(f.scheduler.nextWakeAtMs).toBeNull();
  });
});
it("retires an unresolved retry on scheduler shutdown without caching a failed terminal", async () => {
  await withBoundDispatch({}, async (f) => {
    f.block(true);
    const handling = f.start();
    await f.scheduler.stop();
    await handling;
    await f.finish();
    expect(f.context.dedupe.size).toBe(0);
    expect(f.owner.cleanup).toHaveBeenCalledOnce();
    expect(f.facts.some((fact) => fact.state === "failed")).toBe(false);
    expect(f.warn).toHaveBeenCalledWith(
      "Native dispatch terminal remains unresolved at Gateway shutdown.",
    );
  });
});
it.each([false, true])(
  "retires a stale retry without touching its replacement (rotation: %s)",
  async (rotation) => {
    await withBoundDispatch({}, async (f) => {
      f.block(true);
      const handling = f.start();
      f.owner.registration.cleanup();
      clearAgentRunContext(f.runId, getAgentRunLifecycleGeneration());
      // A new generation must durably admit its queued fact. Restore storage
      // before that admission, while the original retry is still scheduled.
      f.block(false);
      if (rotation) {
        rotateAgentEventLifecycleGeneration();
      }
      const replacement = f.claim("replacement-session");
      const successor = f.createOwner("replacement-session");
      await f.time.advanceTo(6_000);
      await handling;
      await f.finish();
      expect(getAgentRunContext(f.runId)).toBe(replacement);
      expect(f.context.chatAbortControllers.get(f.runId)).toBe(successor.registration.entry);
      expect(f.context.dedupe.size).toBe(0);
      expect(f.owner.cleanup).toHaveBeenCalledOnce();
    });
  },
);
it("settles two retrying owners of the same run ID independently", async () => {
  await withBoundDispatch({}, async (f) => {
    f.block(true);
    const first = f.start();
    f.owner.registration.cleanup();
    clearAgentRunContext(f.runId, getAgentRunLifecycleGeneration());
    const replacement = f.claim("replacement-session"),
      successor = f.createOwner("replacement-session"),
      second = f.start(successor);
    f.block(false);
    await f.time.advanceTo(6_000);
    await Promise.all([first, second]);
    await f.finish();
    expect(getAgentRunContext(f.runId)).toBe(replacement);
    await f.finish(successor);
    await f.transport.flush();
    expect(successor.cleanup).toHaveBeenCalledOnce();
    expect(f.owner.cleanup).toHaveBeenCalledOnce();
    expect(f.facts.filter((fact) => fact.state === "failed")).toHaveLength(1);
    expect(f.scheduler.nextWakeAtMs).toBeNull();
  });
});
it("does not clear or cache over a replacement admitted during post-publication settlement", async () => {
  const entered = createDeferredCore(),
    release = createDeferredCore<boolean>();
  await withBoundDispatch(
    {
      restartSafe: true,
      terminalize: () => {
        entered.resolve();
        return release.promise;
      },
    },
    async (f) => {
      const handling = f.start();
      await entered.promise;
      f.owner.registration.cleanup();
      clearAgentRunContext(f.runId, getAgentRunLifecycleGeneration());
      const replacement = f.claim("replacement-session"),
        successor = f.createOwner("replacement-session");
      release.resolve(true);
      await handling;
      await f.finish();
      expect(getAgentRunContext(f.runId)).toBe(replacement);
      expect(f.context.chatAbortControllers.get(f.runId)).toBe(successor.registration.entry);
      expect(f.context.dedupe.size).toBe(0);
      expect(f.context.removeChatRun).not.toHaveBeenCalled();
    },
  );
});
it("fails closed when an embedded caller cannot schedule a rejected enqueue", async () => {
  await withBoundDispatch({ noScheduler: true }, async (f) => {
    f.block(true);
    await expect(f.start()).rejects.toThrow("fixture native enqueue unavailable");
    await expect(f.finish()).rejects.toThrow("fixture native enqueue unavailable");
    expect(getAgentRunContext(f.runId)).toBe(f.original);
    expect(f.owner.cleanup).not.toHaveBeenCalled();
    expect(f.context.dedupe.size).toBe(0);
  });
});
it("keeps signals-off publications in the legacy base shape", async () => {
  await withBoundDispatch({ signals: false }, async (f) => {
    await f.start();
    await f.finish();
    await f.transport.flush();
    expect(f.facts.map((fact) => fact.state)).toEqual(["queued", "failed"]);
    for (const fact of f.facts) {
      expect(fact).not.toHaveProperty("failureKind");
    }
  });
});
it("does not publish hidden maintenance failures to the room", async () => {
  await withBoundDispatch({ hidden: true }, async (f) => {
    await f.start();
    await f.finish();
    await f.transport.flush();
    expect(f.facts).toEqual([]);
  });
});
it("does not compete with a native-owned terminal", async () => {
  await withBoundDispatch({ nativeOwned: true }, async (f) => {
    emitAgentEvent({
      runId: f.runId,
      stream: "lifecycle",
      data: { phase: "error", executionSettled: true, error: "429 rate limit exceeded" },
    });
    await f.start();
    await f.finish();
    await f.transport.flush();
    expect(f.facts.filter((fact) => fact.state === "failed")).toHaveLength(1);
  });
});
it("leaves an admitted queued followup to its existing settlement owner", async () => {
  await withBoundDispatch({ queued: true }, async (f) => {
    await f.start();
    await f.finish();
    await f.transport.flush();
    expect(f.facts.some((fact) => fact.state === "failed")).toBe(false);
  });
});
