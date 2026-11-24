import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import type { ReplyPayload } from "../auto-reply/types.js";

const { deliverInboundReplyWithMessageSendContextCore } = vi.hoisted(() => ({
  deliverInboundReplyWithMessageSendContextCore: vi.fn(),
}));
const { bindSessionConversation } = vi.hoisted(() => ({
  bindSessionConversation: vi.fn(),
}));
const sessionDelivery = vi.hoisted(() => ({
  complete: vi.fn(),
  enqueueClaimed: vi.fn(),
  load: vi.fn(),
  schedule: vi.fn(),
}));
const queueContext = vi.hoisted(() => ({
  environment: { OPENCLAW_STATE_DIR: "/tmp/session-queue" },
  admission: { identity: { key: "session-queue", birthtime: 1 }, assertCurrent: vi.fn() },
}));
const outboundDelivery = vi.hoisted(() => ({ loadCompletedReceipt: vi.fn() }));
const deliveryQueueContext = vi.hoisted(() => ({
  stateDir: "/tmp/delivery-queue",
  workerContext: { admission: { assertCurrent: vi.fn() } },
}));
vi.mock("../channels/turn/durable-delivery.js", () => ({
  deliverInboundReplyWithMessageSendContextCore,
}));
vi.mock("../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => ({ bind: bindSessionConversation }),
}));
vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: () => queueContext,
}));
vi.mock("../infra/outbound/delivery-queue-storage.js", () => ({
  loadCompletedDeliveryReceipt: outboundDelivery.loadCompletedReceipt,
}));
vi.mock("../infra/delivery-queue-state-context.js", () => ({
  captureDeliveryQueueStateContext: () => deliveryQueueContext,
}));
vi.mock("../infra/session-delivery-queue-runtime.js", () => ({
  scheduleSessionDelivery: sessionDelivery.schedule,
}));
vi.mock("../infra/session-delivery-queue-storage.js", async () => {
  const { createHash } = await import("node:crypto");
  return {
    completeSessionDelivery: sessionDelivery.complete,
    enqueueClaimedSessionDelivery: sessionDelivery.enqueueClaimed,
    loadPendingSessionDelivery: sessionDelivery.load,
    resolveSessionDeliveryId: (key: string) => createHash("sha256").update(key).digest("hex"),
  };
});

import {
  deliverWebchatCompletionFallback,
  deliverQueuedWebchatCompletionFallback,
  markWebchatCompletionSeen,
  scheduleWebchatCompletionFallback,
  resolveWebchatCompletionReplies,
} from "./webchat-completion-delivery-send.js";
import {
  WEBCHAT_COMPLETION_DELIVERY_SLOW_MS,
  type WebchatCompletionDeliveryState,
} from "./webchat-completion-delivery.js";

function state(): WebchatCompletionDeliveryState {
  return {
    route: { channel: "slack", to: "user:U123", accountId: "fi-admin" },
  };
}

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    cfg: {},
    state: state(),
    startedAtMs: 1_000,
    runId: "run-1",
    sessionId: "session-1",
    sessionKey: "agent:cellect-fi-admin:device:abc",
    agentId: "cellect-fi-admin",
    ctx: { Body: "question", SessionKey: "agent:cellect-fi-admin:device:abc" },
    replies: [{ kind: "final" as const, payload: { text: "The answer" } }],
    nowMs: 2_000,
    log: { warn: vi.fn() },
    ...overrides,
  };
}

describe("deliverWebchatCompletionFallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deliverInboundReplyWithMessageSendContextCore.mockResolvedValue({
      status: "handled_visible",
      delivery: { visibleReplySent: true, messageIds: ["1700000000.000001"] },
    });
    bindSessionConversation.mockResolvedValue({ bindingId: "default:user:U123" });
    sessionDelivery.complete.mockResolvedValue(undefined);
    sessionDelivery.enqueueClaimed.mockResolvedValue({
      id: "queued-completion",
      claimed: true,
      status: "pending",
    });
    sessionDelivery.load.mockResolvedValue(null);
    outboundDelivery.loadCompletedReceipt.mockResolvedValue(null);
    sessionDelivery.schedule.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers an unread quick reply once its grace period has elapsed", async () => {
    expect(await deliverWebchatCompletionFallback(baseParams())).toBe("handled");
    expect(deliverInboundReplyWithMessageSendContextCore).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["client-left", { armedAtMs: 1_500 }, 2_000],
    ["slow", {}, 1_000 + WEBCHAT_COMPLETION_DELIVERY_SLOW_MS],
  ] as const)("delivers exactly once for %s", async (_reason, stateExtra, nowMs) => {
    const deliveryState = { ...state(), ...stateExtra };
    const params = baseParams({ state: deliveryState, nowMs });

    expect(await deliverWebchatCompletionFallback(params)).toBe("handled");
    expect(await deliverWebchatCompletionFallback(params)).toBe("skipped");

    expect(deliverInboundReplyWithMessageSendContextCore).toHaveBeenCalledTimes(1);
    expect(deliverInboundReplyWithMessageSendContextCore).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        accountId: "fi-admin",
        to: "user:U123",
        threadId: null,
        replyToId: null,
        requiredCapabilities: expect.objectContaining({ reconcileUnknownSend: true }),
        payload: expect.objectContaining({ text: expect.stringContaining("The answer") }),
      }),
      expect.objectContaining({ workerContext: expect.any(Object) }),
    );
  });

  it("sends a terminal error when the hidden run fails", async () => {
    const deliveryState = { ...state(), armedAtMs: 1_500 };

    expect(
      await deliverWebchatCompletionFallback(
        baseParams({ state: deliveryState, fallbackError: "agent failed" }),
      ),
    ).toBe("handled");

    expect(deliverInboundReplyWithMessageSendContextCore).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          isError: true,
          text: expect.stringContaining("agent failed"),
        }),
      }),
      expect.objectContaining({ workerContext: expect.any(Object) }),
    );
  });

  it("cancels a scheduled chase when the same device sees the Fi answer", async () => {
    vi.useFakeTimers();
    const deliveryState = state();
    expect(
      await scheduleWebchatCompletionFallback({
        ...baseParams({ state: deliveryState }),
        sessionKey: "agent:cellect-fi-admin:device:abc",
        ownerDeviceId: "device-abc",
        unreadGraceMs: 100,
      }),
    ).toBe("scheduled");
    expect(
      await markWebchatCompletionSeen({
        runId: "run-1",
        sessionKey: "agent:cellect-fi-admin:device:abc",
        requesterDeviceId: "device-abc",
      }),
    ).toBe("seen");

    await vi.advanceTimersByTimeAsync(100);
    expect(deliverInboundReplyWithMessageSendContextCore).not.toHaveBeenCalled();
    expect(deliveryState.seenAtMs).toEqual(expect.any(Number));
  });

  it("cancels a persisted chase after restart only for the owning device", async () => {
    sessionDelivery.load.mockResolvedValue({
      kind: "completionFallback",
      sessionKey: "agent:cellect-fi-admin:device:restart",
      ownerDeviceId: "device-restart",
    });

    await expect(
      markWebchatCompletionSeen({
        runId: "run-restart",
        sessionKey: "agent:cellect-fi-admin:device:restart",
        requesterDeviceId: "device-other",
      }),
    ).resolves.toBe("unauthorized");
    expect(sessionDelivery.complete).not.toHaveBeenCalled();

    await expect(
      markWebchatCompletionSeen({
        runId: "run-restart",
        sessionKey: "agent:cellect-fi-admin:device:restart",
        requesterDeviceId: "device-restart",
      }),
    ).resolves.toBe("seen");
    expect(sessionDelivery.complete).toHaveBeenCalledTimes(1);
  });

  it("persists and schedules the chase when no read receipt arrives", async () => {
    expect(
      await scheduleWebchatCompletionFallback({
        ...baseParams({ runId: "run-unread" }),
        runId: "run-unread",
        sessionKey: "agent:cellect-fi-admin:device:abc",
        ownerDeviceId: "device-abc",
        unreadGraceMs: 100,
      }),
    ).toBe("scheduled");

    expect(sessionDelivery.enqueueClaimed).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "completionFallback",
        sessionKey: "agent:cellect-fi-admin:device:abc",
        runId: "run-unread",
        route: { channel: "slack", to: "user:U123", accountId: "fi-admin" },
        text: "The answer",
      }),
      100,
      queueContext,
    );
    expect(sessionDelivery.schedule).toHaveBeenCalledWith("queued-completion", queueContext);
    expect(deliverInboundReplyWithMessageSendContextCore).not.toHaveBeenCalled();
    expect(bindSessionConversation).not.toHaveBeenCalled();
  });

  it("recovers a persisted completion and binds only its Slack message thread to the original session", async () => {
    await deliverQueuedWebchatCompletionFallback({
      cfg: {},
      queueContext: queueContext as never,
      entry: {
        kind: "completionFallback",
        id: "queued-completion",
        enqueuedAt: 1_000,
        retryCount: 0,
        sessionKey: "agent:cellect-fi-admin:device:abc",
        sessionId: "session-1",
        runId: "run-recovered",
        agentId: "cellect-fi-admin",
        route: { channel: "slack", to: "user:U123", accountId: "fi-admin" },
        text: "Recovered answer",
        idempotencyKey: "completion-key",
      },
      log: { warn: vi.fn() },
    });

    expect(deliverInboundReplyWithMessageSendContextCore).toHaveBeenCalledTimes(1);
    expect(bindSessionConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionKey: "agent:cellect-fi-admin:device:abc",
        conversation: {
          channel: "slack",
          accountId: "fi-admin",
          conversationId: "1700000000.000001",
          parentConversationId: "user:U123",
        },
      }),
    );
    expect(deliverInboundReplyWithMessageSendContextCore).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryIntentId: "webchat-completion-outbound:v1:queued-completion",
        reusePendingDeliveryIntent: true,
        completionRetention: expect.objectContaining({
          idPrefix: "webchat-completion-outbound:v1:",
        }),
      }),
      expect.objectContaining({ stateDir: "/tmp/session-queue", workerContext: queueContext }),
    );
  });

  it("never binds a shared Slack destination to a private WebChat session", async () => {
    const log = { warn: vi.fn() };
    const sharedState: WebchatCompletionDeliveryState = {
      route: { channel: "slack", to: "channel:C123", accountId: "fi-admin" },
    };

    expect(await deliverWebchatCompletionFallback(baseParams({ state: sharedState, log }))).toBe(
      "handled",
    );
    expect(bindSessionConversation).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("continuation disabled for non-private destination"),
    );
  });

  it("fails closed when Slack does not return the message identity needed for a thread binding", async () => {
    const log = { warn: vi.fn() };
    deliverInboundReplyWithMessageSendContextCore.mockResolvedValueOnce({
      status: "handled_visible",
      delivery: { visibleReplySent: true },
    });

    expect(await deliverWebchatCompletionFallback(baseParams({ log }))).toBe("handled");
    expect(bindSessionConversation).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("missing provider message id"));
  });

  it("does not bind a destination when no reply became visible", async () => {
    deliverInboundReplyWithMessageSendContextCore.mockResolvedValueOnce({
      status: "handled_no_send",
      reason: "no_visible_result",
      delivery: { visibleReplySent: false },
    });

    expect(await deliverWebchatCompletionFallback(baseParams())).toBe("handled");
    expect(bindSessionConversation).not.toHaveBeenCalled();
  });

  it("does not duplicate a visible reply when continuation binding fails", async () => {
    const log = { warn: vi.fn() };
    bindSessionConversation.mockRejectedValueOnce(new Error("binding unavailable"));

    expect(await deliverWebchatCompletionFallback(baseParams({ log }))).toBe("handled");
    expect(deliverInboundReplyWithMessageSendContextCore).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("continuation binding failed run=run-1"),
    );
  });

  it("retries only the exact-thread binding after a crash boundary retained the provider receipt", async () => {
    const log = { warn: vi.fn() };
    bindSessionConversation.mockRejectedValueOnce(new Error("simulated crash before bind commit"));
    const params = baseParams({ log, deliveryIntentId: "outer-delivery-1" });

    expect(await deliverWebchatCompletionFallback(params)).toBe("failed");
    deliverInboundReplyWithMessageSendContextCore.mockResolvedValueOnce({
      status: "handled_visible",
      delivery: { visibleReplySent: false },
    });
    outboundDelivery.loadCompletedReceipt.mockResolvedValueOnce({
      platformMessageId: "1700000000.000001",
    });
    params.state!.attemptedAtMs = undefined;

    expect(await deliverWebchatCompletionFallback(params)).toBe("handled");
    expect(outboundDelivery.loadCompletedReceipt).toHaveBeenCalledWith(
      "webchat-completion-outbound:v1:outer-delivery-1",
      undefined,
      deliveryQueueContext,
    );
    expect(bindSessionConversation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          conversationId: "1700000000.000001",
          parentConversationId: "user:U123",
        }),
      }),
    );
  });

  it("does not retry a partial send that may already be visible", async () => {
    const log = { warn: vi.fn() };
    deliverInboundReplyWithMessageSendContextCore.mockResolvedValueOnce({
      status: "failed",
      error: new Error("second payload failed"),
      sentBeforeError: true,
    });

    expect(await deliverWebchatCompletionFallback(baseParams({ log }))).toBe("handled");
    expect(bindSessionConversation).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "delivery partially completed without continuation binding run=run-1",
      ),
    );
  });
  it("only collects replies accepted by the native silent-outcome owner", async () => {
    const deliveredReplies: Array<{
      kind: "final";
      input: { kind: "raw"; payload: ReplyPayload };
    }> = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        deliveredReplies.push({ kind: "final", input: { kind: "raw", payload } });
      },
    });
    const silent: ReplyPayload = { text: "NO_REPLY" };
    setReplyPayloadMetadata(silent, { silentReply: true });
    dispatcher.sendFinalReply(silent);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    expect(deliveredReplies).toEqual([]);
    expect(
      resolveWebchatCompletionReplies({
        deliveredReplies,
        foldCommandBlocks: false,
        suppressReplies: false,
      }),
    ).toEqual([]);
    // Literal visible text is already classified by the native owner; no second token parser.
    expect(
      resolveWebchatCompletionReplies({
        deliveredReplies: [
          { kind: "final", input: { kind: "raw", payload: { text: "NO_REPLY" } } },
        ],
        foldCommandBlocks: false,
        suppressReplies: false,
      }),
    ).toEqual([{ kind: "final", payload: { text: "NO_REPLY" } }]);
  });

  it("uses native final selection and omits suppressed, status and reasoning answers", () => {
    const final = {
      kind: "final" as const,
      input: { kind: "raw" as const, payload: { text: "answer" } },
    };
    expect(
      resolveWebchatCompletionReplies({
        deliveredReplies: [final],
        foldCommandBlocks: false,
        suppressReplies: true,
      }),
    ).toEqual([]);
    expect(
      resolveWebchatCompletionReplies({
        deliveredReplies: [
          { ...final, input: { kind: "raw", payload: { text: "working", isStatusNotice: true } } },
          {
            ...final,
            input: { kind: "raw", payload: { text: "private reasoning", isReasoning: true } },
          },
        ],
        foldCommandBlocks: false,
        suppressReplies: false,
      }),
    ).toEqual([]);
    expect(
      resolveWebchatCompletionReplies({
        deliveredReplies: [final],
        foldCommandBlocks: false,
        suppressReplies: false,
      }),
    ).toEqual([{ kind: "final", payload: { text: "answer" } }]);
  });

  it("does not send status-only fallback or disclose sensitive media in native text projection", async () => {
    expect(
      await deliverWebchatCompletionFallback(
        baseParams({
          replies: [{ kind: "final", payload: { text: "working", isStatusNotice: true } }],
        }),
      ),
    ).toBe("skipped");
    expect(deliverInboundReplyWithMessageSendContextCore).not.toHaveBeenCalled();
    expect(
      resolveWebchatCompletionReplies({
        deliveredReplies: [
          {
            kind: "final",
            input: {
              kind: "raw",
              payload: { mediaUrl: "/private/credential.png", sensitiveMedia: true },
            },
          },
        ],
        foldCommandBlocks: false,
        suppressReplies: false,
      }),
    ).toEqual([]);
  });

  it("fails closed if the captured queue owner closes before restored send", async () => {
    const closed = {
      ...deliveryQueueContext,
      workerContext: {
        admission: {
          assertCurrent() {
            throw new Error("closed queue");
          },
        },
      },
    };
    await expect(
      deliverWebchatCompletionFallback(baseParams({ queueContext: closed })),
    ).rejects.toThrow("closed queue");
    expect(deliverInboundReplyWithMessageSendContextCore).not.toHaveBeenCalled();
  });
  it("accepts its committed binding once without rechecking a superseded precommit view", async () => {
    let current = true;
    const assertCurrent = () => {
      if (!current) throw new Error("precommit view superseded");
    };
    bindSessionConversation.mockImplementationOnce(async ({ assertCurrent: assertBinding }) => {
      await Promise.resolve();
      assertBinding();
      // The worker has committed. Publication can supersede the old view after this point.
      current = false;
      return { bindingId: "committed-thread" };
    });
    const params = baseParams({ deliveryIntentId: "own-commit", assertCurrent });
    expect(await deliverWebchatCompletionFallback(params)).toBe("handled");
    expect(deliverInboundReplyWithMessageSendContextCore).toHaveBeenCalledOnce();
    expect(bindSessionConversation).toHaveBeenCalledOnce();
  });

  it("rechecks the exact source binding at the binding worker handoff after provider acceptance", async () => {
    let current = true;
    const assertCurrent = () => {
      if (!current) throw new Error("source binding replaced");
    };
    bindSessionConversation.mockImplementationOnce(async ({ assertCurrent: assertBinding }) => {
      await Promise.resolve();
      current = false;
      assertBinding();
    });
    expect(
      await deliverWebchatCompletionFallback(
        baseParams({ deliveryIntentId: "source-race", assertCurrent }),
      ),
    ).toBe("failed");
    expect(deliverInboundReplyWithMessageSendContextCore).toHaveBeenCalledOnce();
    // Custody remains on the exact intent; failure must never mint a second provider send key.
    expect(deliverInboundReplyWithMessageSendContextCore.mock.calls[0]?.[0].deliveryIntentId).toBe(
      "webchat-completion-outbound:v1:source-race",
    );
  });
});
