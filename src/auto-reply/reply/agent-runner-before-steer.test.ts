import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runReplyAgent } from "./agent-runner-run.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { clearFollowupDrainCallback } from "./queue/drain.js";
import { resetRecentQueuedMessageIdDedupe } from "./queue/recent-message-ids.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import { clearFollowupQueue } from "./queue/state.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { createMockTypingController } from "./test-helpers.js";

const hookState = vi.hoisted(() => ({
  hasHook: true,
  result: undefined as { handled: boolean } | undefined,
  throws: false,
  calls: [] as Array<{ event: Record<string, unknown>; ctx: Record<string, unknown> }>,
}));

vi.mock("../../plugins/hook-runner-global.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/hook-runner-global.js")>();
  return {
    ...actual,
    getGlobalHookRunner: () => ({
      hasHooks: (name: string) => name === "before_steer" && hookState.hasHook,
      runBeforeSteer: async (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
        hookState.calls.push({ event, ctx });
        if (hookState.throws) {
          throw new Error("plugin fault");
        }
        return hookState.result;
      },
    }),
  };
});

const KEY = "agent:cellect-fi-admin:before-steer";

/** A run that is active in KEY and would accept steered text, as a completion wake is. */
function activeRun() {
  const run = createQueueTestRun({ prompt: "also do this", messageId: "$event-1" });
  run.run.agentId = "cellect-fi-admin";
  run.run.sessionKey = KEY;
  const delivered: string[] = [];
  const operation = createReplyOperation({
    sessionKey: KEY,
    sessionId: run.run.sessionId,
    resetTriggered: false,
  });
  operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(run));
  operation.setPhase("running");
  operation.attachBackend({
    kind: "embedded",
    cancel: vi.fn(),
    messageInjectionV2: {
      version: 2,
      isAvailable: () => true,
      queueMessage: async (text, _options, assertCurrent) => {
        assertCurrent();
        delivered.push(text);
      },
    },
  });
  return { run, operation, delivered };
}

async function incoming(run: ReturnType<typeof createQueueTestRun>) {
  const state: ReplyOperationRunState = {};
  await runReplyAgent({
    commandBody: run.prompt,
    followupRun: run,
    opts: { runId: "incoming", [REPLY_OPERATION_RUN_STATE]: state },
    queueKey: KEY,
    resolvedQueue: { mode: "steer", debounceMs: 0 },
    shouldSteer: true,
    shouldFollowup: false,
    isActive: true,
    typing: createMockTypingController(),
    sessionCtx: { Provider: "matrix", SessionKey: KEY, MessageSid: run.messageId },
    sessionKey: KEY,
    defaultModel: "gpt-test",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "text_end",
    shouldInjectGroupIntro: false,
    typingMode: "never",
  });
  return state;
}

describe("before_steer: a plugin keeps a message out of the active run", () => {
  beforeEach(() => {
    hookState.hasHook = true;
    hookState.result = undefined;
    hookState.throws = false;
    hookState.calls = [];
    resetRecentQueuedMessageIdDedupe();
  });
  afterEach(() => {
    clearFollowupQueue(KEY);
    clearFollowupDrainCallback(KEY);
    vi.restoreAllMocks();
  });

  it("steers as before when no plugin claims it", async () => {
    const { run, operation, delivered } = activeRun();
    try {
      const state = await incoming(run);
      expect(state.admission).toEqual({ status: "accepted", mode: "steer" });
      expect(delivered).toEqual(["also do this"]);
      expect(hookState.calls).toHaveLength(1);
      expect(hookState.calls[0]?.event).toMatchObject({ messageId: "$event-1", sessionKey: KEY });
    } finally {
      operation.complete();
    }
  });

  it("queues it as its own turn, never injected, when a plugin claims the steer", async () => {
    hookState.result = { handled: true };
    const { run, operation, delivered } = activeRun();
    try {
      const state = await incoming(run);
      expect(state.admission).toEqual({ status: "accepted", mode: "followup" });
      expect(delivered).toEqual([]);
      expect(getExistingFollowupQueue(KEY)?.items.map((item) => item.messageId)).toEqual([
        "$event-1",
      ]);
    } finally {
      operation.complete();
    }
  });

  it("runs a redelivered event once: the queue's message-id dedupe still applies", async () => {
    hookState.result = { handled: true };
    const { run, operation, delivered } = activeRun();
    try {
      await incoming(run);
      const again = createQueueTestRun({ prompt: "also do this", messageId: "$event-1" });
      again.run.agentId = "cellect-fi-admin";
      again.run.sessionKey = KEY;
      await incoming(again);
      expect(getExistingFollowupQueue(KEY)?.items).toHaveLength(1);
      expect(delivered).toEqual([]);
    } finally {
      operation.complete();
    }
  });

  it.each([
    ["no plugin registers the hook", () => (hookState.hasHook = false)],
    ["the plugin throws", () => (hookState.throws = true)],
    ["the plugin declines", () => (hookState.result = { handled: false })],
  ])("steers unchanged when %s", async (_name, arrange) => {
    arrange();
    const { run, operation, delivered } = activeRun();
    try {
      const state = await incoming(run);
      expect(state.admission).toEqual({ status: "accepted", mode: "steer" });
      expect(delivered).toEqual(["also do this"]);
    } finally {
      operation.complete();
    }
  });

  it("does not ask when the host already queues it for a tool-authority mismatch", async () => {
    hookState.result = { handled: true };
    const { run, operation, delivered } = activeRun();
    run.toolsAllow = ["read"];
    try {
      const state = await incoming(run);
      expect(state.admission).toEqual({ status: "accepted", mode: "followup" });
      expect(delivered).toEqual([]);
      expect(hookState.calls).toHaveLength(0);
    } finally {
      operation.complete();
    }
  });
});
