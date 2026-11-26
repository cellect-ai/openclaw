import { expectDefined } from "@openclaw/normalization-core";
import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { testing as sessionBindingTesting } from "openclaw/plugin-sdk/session-binding-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { resetSystemEventsForTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import type { MatrixStreamingConfig } from "../../types.js";
import type { MatrixReplyDispatchInfo } from "./handler-draft-controller.js";
import { registerMatrixBlockStreamingConfigTests } from "./handler.block-streaming-config.test-support.js";
import { registerMatrixLiveAllowlistTests } from "./handler.live-allowlist.test-support.js";
import { registerMatrixPreviewDeliveryTests } from "./handler.preview-delivery.test-support.js";
import {
  createMatrixHandlerTestHarness as createHarness,
  createMatrixTextMessageEvent as textEvent,
} from "./handler.test-helpers.js";
import { stripMatrixMentionPrefix } from "./mentions.js";

// Core owns the shared gate (DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS); plugins
// cannot import it, so mirror the value here for start-boundary assertions.
const PROGRESS_DRAFT_START_DELAY_MS = 1_500;
const ROOM = "!room:example.org";

const sendMock = vi.hoisted(() => vi.fn<typeof import("../send.js").sendMessageMatrix>());
const sendDraftMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ messageId: "$draft1", roomId: "!room" })),
);
const editMock = vi.hoisted(() =>
  vi.fn<typeof import("../send.js").editMessageMatrix>(async () => "$edited"),
);
const typingMock = vi.hoisted(() => vi.fn(async () => {}));
const { prepareMock, prepareSingleText } = vi.hoisted(() => {
  const prepare = (text: string) => {
    const trimmedText = text.trim();
    return {
      trimmedText,
      convertedText: trimmedText,
      singleEventLimit: 4000,
      fitsInSingleEvent: true,
    };
  };
  return { prepareMock: vi.fn(prepare), prepareSingleText: prepare };
});
const mentionsMock = vi.hoisted(() =>
  vi.fn(async ({ body }: { body: string }) => {
    const userIds = Array.from(body.matchAll(/@[A-Za-z0-9._=/-]+:[^\s`<]+/g), (match) => match[0]);
    return {
      ...(body.includes("@room") ? { room: true } : {}),
      ...(userIds.length > 0 ? { user_ids: userIds } : {}),
    };
  }),
);
const hooksMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>();
  return { ...actual, getGlobalHookRunner: hooksMock };
});

// mock-isolation: Keep Matrix network sends inert while testing monitor routing and delivery decisions.
vi.mock("../send.js", () => ({
  editMessageMatrix: editMock,
  prepareMatrixSingleText: prepareMock,
  reactMatrixMessage: vi.fn(async () => {}),
  resolveMatrixMentionsForBody: mentionsMock,
  sendMessageMatrix: sendMock,
  sendSingleTextMessageMatrix: sendDraftMock,
  sendReadReceiptMatrix: vi.fn(async () => {}),
  sendTypingMatrix: typingMock,
}));

function receiveText(
  handler: ReturnType<typeof createHarness>["handler"],
  event: Parameters<typeof textEvent>[0],
  roomId = ROOM,
) {
  return handler(roomId, textEvent(event));
}

function waitForState<T>(
  assertion: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
): Promise<T> {
  return vi.waitFor(assertion, { interval: 1, ...options });
}

type SessionOrigin = {
  chatType: "direct" | "group";
  from: string;
  to: string;
  nativeChannelId?: string;
};

function threadRoot(eventId = "$root", body = "Root topic") {
  return textEvent({ eventId, sender: "@alice:example.org", body });
}

function threadRelation(root = "$root") {
  return { rel_type: "m.thread", event_id: root, "m.in_reply_to": { event_id: root } };
}

function dispatchResult(final = 0, block = 0) {
  return { queuedFinal: final > 0, counts: { final, block, tool: 0 } };
}

function replyDispatcher(waitForIdle = async () => {}) {
  return {
    dispatcher: { markComplete: () => {}, waitForIdle },
    replyOptions: {},
    markDispatchIdle: () => {},
    markRunComplete: () => {},
  };
}

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  installMatrixMonitorTestRuntime();
  hooksMock.mockReset().mockReturnValue(null);
  prepareMock.mockReset().mockImplementation(prepareSingleText);
  mentionsMock.mockClear();
  sendMock.mockReset().mockImplementation(acceptMatrixReply());
  typingMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  resetSystemEventsForTest();
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mockCalls(mock: unknown, label: string): unknown[][] {
  if (!vi.isMockFunction(mock)) {
    throw new Error(`${label} was not a mock`);
  }
  return mock.mock.calls;
}

function callArg(mock: unknown, callIndex: number, argIndex: number, label = "mock call") {
  return expectDefined(mockCalls(mock, label).at(callIndex), label)[argIndex];
}

function lastCallArg(mock: unknown, argIndex: number, label = "mock call") {
  return callArg(mock, -1, argIndex, label);
}

function draftBody(callIndex = 0) {
  return callArg(sendDraftMock, callIndex, 1, "single text message body");
}

function expectNoCalls(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

function matrixEditOptions(eventId: string, body: string, roomId = ROOM) {
  return expectDefined(
    editMock.mock.calls.find(
      ([room, id, text]) => room === roomId && id === eventId && text === body,
    )?.[3],
    `edit options for ${eventId}`,
  );
}

function expectDeliveredMediaReply() {
  expect(lastCallArg(sendMock, 2)).toMatchObject({
    mediaUrl: "https://example.com/image.png",
  });
  expect(lastCallArg(sendMock, 1)).toBe("");
}

function deliveryResult(messageId = "$reply1", content = "delivered") {
  return {
    messageIds: [messageId],
    receipt: {
      primaryPlatformMessageId: messageId,
      platformMessageIds: [messageId],
      parts: [{ platformMessageId: messageId, kind: "text" as const, index: 0 }],
      sentAt: 1,
    },
    visibleReplySent: true,
    content,
  };
}

function tombstoneDispatch(): never {
  throw Object.assign(new Error("session ended during restart recovery"), {
    code: "SESSION_RESTART_RECOVERY_TOMBSTONE",
  });
}

function acceptMatrixReply(
  messageId = "$reply1",
  content = "delivered",
): typeof import("../send.js").sendMessageMatrix {
  return async (_room, _text, options) => {
    const result = {
      messageId,
      roomId: ROOM,
      primaryMessageId: messageId,
      receipt: deliveryResult(messageId, content).receipt,
      content,
    };
    await options.onDeliveryResult?.(result);
    return result;
  };
}

type HarnessOptions = NonNullable<Parameters<typeof createHarness>[0]>;
const noticeDirs = useSessionStoreTempDirs(afterAll, "matrix-dm-notice-");

registerMatrixLiveAllowlistTests();

describe("matrix monitor handler failure handling", () => {
  it("sends a durable threaded notice after restart tombstone rejection", async () => {
    const callOrder: string[] = [];
    const runtime = { error: vi.fn() };
    const dispatchInboundMessage = vi.fn(async () => {
      callOrder.push("dispatch");
      return tombstoneDispatch();
    });
    sendMock.mockImplementationOnce(async () => {
      callOrder.push("notice");
      return {
        ...deliveryResult("$notice"),
        messageId: "$notice",
        roomId: ROOM,
        primaryMessageId: "$notice",
      };
    });
    const { handler } = createHarness({
      runtime: runtime as never,
      recordInboundSession: vi.fn(async () => {
        callOrder.push("record");
      }),
      isDirectMessage: false,
      roomsConfig: { [ROOM]: { requireMention: false } },
      client: {
        getEvent: async () => threadRoot("$thread-root", "Thread root"),
      },
      dispatchInboundMessage,
    });
    await receiveText(handler, {
      eventId: "$tombstone-event",
      body: "continue",
      relatesTo: threadRelation("$thread-root"),
    });
    expect(dispatchInboundMessage).toHaveBeenCalledOnce();
    expect(sendMock).toHaveBeenCalledOnce();
    expect(callArg(sendMock, 0, 0)).toBe(ROOM);
    expect(String(callArg(sendMock, 0, 1))).toContain("Send /new or /reset");
    expect(callArg(sendMock, 0, 2)).toMatchObject({
      accountId: "ops",
      replyToId: undefined,
      fallbackReplyToId: "$thread-root",
      threadId: "$thread-root",
      deliveryQueueId: "matrix:restart-recovery-tombstone:ops:!room:example.org:$tombstone-event",
      deliveryPartIndex: 0,
      deliveryPartCount: 1,
      extraContent: { msgtype: "m.notice" },
    });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(callOrder).toEqual(["record", "dispatch", "notice"]);
  });

  it("propagates a failed restart tombstone notice for ingress retry", async () => {
    const runtime = { error: vi.fn() };
    sendMock.mockRejectedValueOnce(new Error("homeserver unavailable"));
    const { handler } = createHarness({
      runtime: runtime as never,
      dispatchInboundMessage: vi.fn(async () => tombstoneDispatch()),
    });
    await expect(
      receiveText(handler, { eventId: "$tombstone-notice-failed", body: "continue" }),
    ).rejects.toThrow("homeserver unavailable");
    expect(sendMock).toHaveBeenCalledOnce();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("failed completing restart-recovery tombstone notice"),
    );
  });

  it("reports a queued block delivery failure after dispatch", async () => {
    const kind = "block";
    const runtime = { error: vi.fn() };
    const { handler } = createHarness({
      runtime: runtime as never,
      dispatchInboundMessage: vi.fn(async () => dispatchResult(0, 1)),
      createReplyDispatcherWithTyping: (params) =>
        replyDispatcher(async () => {
          params?.onError?.(new Error("send failed"), { kind });
        }),
    });
    await receiveText(handler, { eventId: `$release-on-${kind}-delivery-error`, body: "hello" });
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining(`matrix ${kind} reply failed`),
    );
  });
});

describe("matrix monitor handler draft streaming", () => {
  type DeliverFn = (payload: ReplyPayload, info: MatrixReplyDispatchInfo) => Promise<unknown>;

  const waitForDrafts = (count = 1) =>
    waitForState(() => expect(sendDraftMock).toHaveBeenCalledTimes(count));

  function nextDraft(messageId: string) {
    sendDraftMock.mockClear();
    editMock.mockClear();
    sendDraftMock.mockResolvedValueOnce({ messageId, roomId: "!room" });
  }

  async function toolStarted(opts: GetReplyOptions, toolCallId: string, name: string) {
    const activity = { toolCallId, name, phase: "start" as const };
    await opts.onItemEvent?.(projectAgentToolActivity(activity));
    await opts.onToolStart?.(activity);
  }

  async function sendPreview(opts: GetReplyOptions, text: string, expectedSends = 1) {
    await opts.onPartialReply?.({ text });
    await waitForDrafts(expectedSends);
  }

  async function deliverBlock(deliver: DeliverFn, text: string, nextId: string, remaining: string) {
    nextDraft(nextId);
    await deliver({ text }, { kind: "block" });
    await waitForDrafts();
    expect(draftBody()).toBe(remaining);
  }

  function createStreamingHarness(opts?: {
    replyToMode?: "off" | "first" | "all" | "batched";
    threadReplies?: "inbound" | "always";
    blockStreamingEnabled?: boolean;
    streaming?: "partial" | "quiet" | "progress" | "off";
    previewToolProgressEnabled?: boolean;
    accountConfig?: import("../../types.js").MatrixConfig;
  }) {
    let deliver: DeliverFn | undefined;
    let onError: ((error: unknown, info: { kind: string }) => void) | undefined;
    const replyOptions = createDeferred<GetReplyOptions>();
    const run = createDeferred<void>();

    sendMock.mockReset().mockImplementation(acceptMatrixReply());
    sendDraftMock.mockReset().mockResolvedValue({ messageId: "$draft1", roomId: "!room" });
    editMock.mockReset().mockResolvedValue("$edited");

    const redactEventMock = vi.fn(async () => "$redacted");
    const logVerboseMessage = vi.fn();

    const { handler } = createHarness({
      streaming: opts?.streaming ?? "quiet",
      accountConfig: opts?.accountConfig,
      previewToolProgressEnabled: opts?.previewToolProgressEnabled ?? false,
      blockStreamingEnabled: opts?.blockStreamingEnabled ?? false,
      replyToMode: opts?.replyToMode ?? "off",
      threadReplies: opts?.threadReplies,
      client: { redactEvent: redactEventMock },
      logVerboseMessage,
      createReplyDispatcherWithTyping: (params: Record<string, unknown> | undefined) => {
        deliver = params?.deliver as DeliverFn | undefined;
        onError = params?.onError as typeof onError;
        return replyDispatcher();
      },
      dispatchInboundMessage: vi.fn(async (args: { replyOptions?: GetReplyOptions }) => {
        replyOptions.resolve(expectDefined(args.replyOptions, "reply options"));
        await run.promise;
        return dispatchResult(1);
      }) as never,
    });

    const dispatch = async () => {
      const handlerDone = receiveText(handler, { eventId: "$msg1", body: "hello" });
      const capturedOptions = await replyOptions.promise;
      return {
        deliver: expectDefined(deliver, "deliver callback"),
        onError: expectDefined(onError, "error callback"),
        opts: capturedOptions,
        finish: async () => {
          run.resolve();
          await handlerDone;
        },
      };
    };

    return { dispatch, redactEventMock, logVerboseMessage };
  }

  async function startStreaming(options?: Parameters<typeof createStreamingHarness>[0]) {
    const { dispatch, ...harness } = createStreamingHarness(options);
    return { ...harness, ...(await dispatch()) };
  }

  async function startPreview(
    text: string,
    options?: Parameters<typeof createStreamingHarness>[0],
  ) {
    const harness = await startStreaming(options);
    await sendPreview(harness.opts, text);
    return harness;
  }

  function progressHarness(progress: NonNullable<MatrixStreamingConfig["progress"]>) {
    return startStreaming({
      streaming: "progress",
      previewToolProgressEnabled: progress.toolProgress ?? false,
      accountConfig: { streaming: { mode: "progress", progress } },
    });
  }

  it("records a failed block typing restart without replaying the accepted delivery", async () => {
    const acceptedDelivery = deliveryResult("$accepted", "Already delivered block");
    const { dispatch, logVerboseMessage, redactEventMock } = createStreamingHarness({
      streaming: "off",
    });
    sendMock.mockImplementationOnce(acceptMatrixReply("$accepted", "Already delivered block"));
    typingMock.mockRejectedValueOnce(new Error("typing unavailable"));
    const { deliver, finish } = await dispatch();

    await expect(
      deliver({ text: "Already delivered block" }, { kind: "block" }),
    ).resolves.toMatchObject(acceptedDelivery);
    expect(sendMock).toHaveBeenCalledOnce();
    expect(typingMock).toHaveBeenCalledExactlyOnceWith(ROOM, true, {
      client: expect.objectContaining({ redactEvent: redactEventMock }),
    });
    const expectedDiagnostic =
      "matrix typing action=start failed target=!room:example.org: Error: typing unavailable";
    await waitForState(() =>
      expect(
        logVerboseMessage.mock.calls.filter(([message]) => message === expectedDiagnostic),
      ).toHaveLength(1),
    );
    await finish();
  });

  it("settles finalized previews with provider-prepared content", async () => {
    prepareMock.mockImplementation((text: string) => ({
      ...prepareSingleText(text),
      convertedText: `prepared:${text.trim()}`,
    }));
    const { deliver, finish } = await startPreview("Raw preview", { streaming: "quiet" });
    const result = await deliver({ text: "Raw final" }, { kind: "final" });
    expect(result).toMatchObject({ messageIds: ["$draft1"], content: "prepared:Raw final" });
    await finish();
  });

  it.each(["reply_payload_sending", "message_sending"])(
    "suppresses provider previews when %s is registered",
    async (hook) => {
      hooksMock.mockReturnValue({
        hasHooks: vi.fn((hookName: string) => hook === hookName),
      });
      const { deliver, opts, finish } = await startStreaming({
        previewToolProgressEnabled: true,
        streaming: "progress",
      });
      expect(opts.onPartialReply).toBeUndefined();
      expect(opts.onToolStart).toBeUndefined();
      expect(opts.suppressDefaultToolProgressMessages).toBeUndefined();
      await deliver({ text: "Durable final" }, { kind: "final" });
      expectNoCalls(sendDraftMock, editMock);
      expect(sendMock).toHaveBeenCalledTimes(1);
      await finish();
    },
  );

  it("clears an empty plan and resumes Matrix drafts", async () => {
    vi.useFakeTimers();
    const { opts, finish, redactEventMock } = await progressHarness({
      toolProgress: true,
      label: false,
    });
    try {
      await opts.onPlanUpdate?.({ phase: "update", steps: [] });
      expectNoCalls(sendDraftMock, redactEventMock);

      await opts.onPlanUpdate?.({
        phase: "update",
        explanation: "Plan",
        steps: [{ step: "Inspect", status: "in_progress" }],
      });
      await waitForDrafts();
      expect(draftBody()).toBe("`Plan`\n\n`▸ Inspect`");

      await opts.onPlanUpdate?.({ phase: "update", steps: [] });
      expect(redactEventMock).toHaveBeenCalledExactlyOnceWith(ROOM, "$draft1");
      await opts.onPlanUpdate?.({
        phase: "update",
        steps: [{ step: "Resume", status: "in_progress" }],
      });
      await waitForDrafts(2);
      expect(lastCallArg(sendDraftMock, 1)).toBe("`▸ Resume`");
    } finally {
      await finish();
    }
  });

  it("keeps quiet Matrix status, plans, and approvals with tool progress disabled", async () => {
    vi.useFakeTimers();
    const { opts, finish } = await progressHarness({ toolProgress: false, label: "Working" });
    try {
      expect(opts.suppressDefaultToolProgressMessages).toBe(true);
      await toolStarted(opts, "read-1", "read_file");
      expect(sendDraftMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(draftBody()).toBe("Working");

      await opts.onPlanUpdate?.({
        phase: "update",
        steps: [{ step: "Inspect", status: "in_progress" }],
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(lastCallArg(editMock, 2)).toContain("▸ Inspect");
      await opts.onApprovalEvent?.({ phase: "requested", command: "confirm-operation" });
      await vi.advanceTimersByTimeAsync(1_000);

      const quietProgress = lastCallArg(editMock, 2);
      expect(quietProgress).toContain("Working");
      expect(quietProgress).toContain("▸ Inspect");
      expect(quietProgress).toContain("confirm-operation");
      expect(quietProgress).not.toContain("Read File");
    } finally {
      await finish();
    }
  });

  const spokenPayload = () => ({
    mediaUrl: "https://example.com/tts.mp3",
    audioAsVoice: true,
    spokenText: "Spoken answer",
    ttsSupplement: { spokenText: "Spoken answer" },
  });

  it.each(["media send", "live finalization"])(
    "recovers TTS delivery after %s fails",
    async (stage) => {
      const { redactEventMock, deliver, finish } = await startPreview("Spoken answer", {
        blockStreamingEnabled: true,
        streaming: "partial",
      });
      if (stage === "media send") {
        sendMock.mockRejectedValueOnce(new Error("media send failed"));
        await expect(deliver(spokenPayload(), { kind: "final" })).rejects.toMatchObject({
          code: "CHANNEL_PARTIAL_DELIVERY",
          deliveryResult: {
            messageIds: ["$draft1"],
            visibleReplySent: true,
            content: "Spoken answer",
            receipt: { primaryPlatformMessageId: "$draft1" },
          },
        });
      } else {
        editMock.mockRejectedValueOnce(new Error("rate limited"));
        await deliver(spokenPayload(), { kind: "final" });
        expect(redactEventMock).toHaveBeenCalledWith(ROOM, "$draft1");
        expect(sendMock).toHaveBeenCalledTimes(1);
        expect(callArg(sendMock, 0, 1)).toBe("Spoken answer");
        expect(callArg(sendMock, 0, 2)).toMatchObject({
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
        });
      }
      await finish();
    },
  );

  registerMatrixPreviewDeliveryTests({
    createStreamingHarness,
    createMockMatrixDeliveryResult: deliveryResult,
    acceptMatrixReply,
    sendSingleTextMessageMatrixMock: sendDraftMock,
    editMessageMatrixMock: editMock,
    sendMessageMatrixMock: sendMock,
    waitForMatrixState: waitForState,
    mockCalls,
  });

  it("keeps delayed same-message block boundaries at the emitted block length", async () => {
    const { redactEventMock, deliver, opts, finish } = await startStreaming({
      blockStreamingEnabled: true,
    });
    await opts.onPartialReply?.({ text: "Alpha" });
    await waitForDrafts(1);
    await opts.onPartialReply?.({ text: "AlphaBeta" });
    await waitForState(() => matrixEditOptions("$draft1", "AlphaBeta"));
    await deliverBlock(deliver, "Alpha", "$draft2", "Beta");
    matrixEditOptions("$draft1", "Alpha");
    expectNoCalls(sendMock, redactEventMock);
    await finish();
  });

  it("starts fresh progress drafts for queued followups after the primary final", async () => {
    vi.useFakeTimers();
    const { deliver, opts, finish } = await progressHarness({ toolProgress: true });
    await toolStarted(opts, "read-1", "read_file");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sendDraftMock).toHaveBeenCalledTimes(1);

    await deliver({ text: "Primary answer" }, { kind: "final" });
    sendDraftMock.mockClear();
    sendDraftMock.mockResolvedValue({ messageId: "$draft2", roomId: "!room" });
    await opts.onQueuedFollowupAdmitted?.();
    await toolStarted(opts, "exec-followup", "exec");
    // Mirrors DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS: the followup draft must
    // wait out a fresh gate instead of inheriting the primary turn's timer.
    await vi.advanceTimersByTimeAsync(PROGRESS_DRAFT_START_DELAY_MS - 1);
    expect(sendDraftMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(sendDraftMock).toHaveBeenCalledTimes(1);
    expect(draftBody()).toMatch(/`Exec: running`$/);
    await finish();
  });

  it("keeps late block delivery scoped to its source assistant message", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { redactEventMock, deliver, opts, finish } = await startStreaming({
      blockStreamingEnabled: true,
    });
    try {
      await opts.onAssistantMessageStart?.();
      await sendPreview(opts, "Alpha");
      await opts.onAssistantMessageStart?.();
      await opts.onPartialReply?.({ text: "Beta" });

      // Drive the draft throttle before checking queued-block ordering.
      await vi.advanceTimersByTimeAsync(1_000);
      matrixEditOptions("$draft1", "Beta");

      nextDraft("$draft2");
      await deliver(
        { text: "Alpha" },
        { kind: "block", assistantMessageIndex: 1, blockSourceRange: [0, 5] },
      );
      matrixEditOptions("$draft1", "Alpha");
      expectNoCalls(sendMock, redactEventMock);
      await waitForDrafts(1);
      expect(draftBody()).toBe("Beta");

      await deliver({ text: "Beta" }, { kind: "final" });
      expectNoCalls(sendMock, redactEventMock);
    } finally {
      await finish();
    }
  });

  it.each(["quiet", "partial"] as const)(
    "settles aborted %s draft visibility",
    async (streaming) => {
      if (streaming === "quiet") {
        vi.useFakeTimers();
      }
      const pendingDraft = createDeferred<{ messageId: string; roomId: string }>();
      sendDraftMock
        .mockReset()
        .mockImplementation(() =>
          streaming === "quiet"
            ? pendingDraft.promise
            : Promise.resolve({ messageId: "$draft1", roomId: "!room" }),
        );
      editMock.mockReset().mockResolvedValue("$edited");
      sendMock.mockReset().mockImplementation(acceptMatrixReply());
      const redactEventMock = vi.fn(async () => "$redacted");
      const { handler } = createHarness({
        streaming,
        client: { redactEvent: redactEventMock },
        createReplyDispatcherWithTyping: () => replyDispatcher(),
        dispatchInboundMessage: vi.fn(async (args: { replyOptions?: GetReplyOptions }) => {
          await args.replyOptions?.onPartialReply?.({ text: "partial" });
          if (streaming === "partial") {
            await waitForDrafts();
          }
          throw new Error("model timeout");
        }) as never,
      });
      const handlerDone = expect(
        receiveText(handler, { eventId: "$msg1", body: "hello" }),
      ).rejects.toThrow("model timeout");
      if (streaming === "quiet") {
        await waitForDrafts();
        pendingDraft.resolve({ messageId: "$draft1", roomId: "!room" });
      }
      await handlerDone;
      if (streaming === "partial") {
        expect(redactEventMock).not.toHaveBeenCalled();
      } else {
        expect(redactEventMock).toHaveBeenCalledWith(ROOM, "$draft1");
        sendDraftMock.mockClear();
        editMock.mockClear();
        await vi.advanceTimersByTimeAsync(50);
        expectNoCalls(sendDraftMock, editMock);
      }
    },
  );

  it("cleans up empty final drafts with blank-only media", async () => {
    const payload = { mediaUrls: ["   "] };
    const { deliver, finish, redactEventMock } = await startPreview("Partial reply", {
      streaming: "partial",
    });
    sendMock.mockClear();
    await deliver(payload, { kind: "final" });
    expect(sendMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
    expect(redactEventMock).toHaveBeenCalledWith(ROOM, "$draft1");
  });

  it("skips compaction notices in draft finalization", async () => {
    const { deliver, finish } = await startPreview("Streaming");
    sendMock.mockClear();
    await deliver({ text: "Compacting...", isCompactionNotice: true }, { kind: "block" });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(editMock).not.toHaveBeenCalled();
    await finish();
  });

  it.each([false, true])(
    "settles draft routing with first reply slot consumed=%s",
    async (consumeFirst) => {
      const threadReplies = consumeFirst ? undefined : "always";
      const payload = {
        text: "Final text",
        ...(!consumeFirst ? { replyToId: "$suppressed_implicit" } : {}),
      };
      const { redactEventMock, deliver, opts, finish } = await startStreaming({
        replyToMode: "first",
        threadReplies,
      });
      if (consumeFirst) {
        await deliver({ text: "tool result", replyToId: "$msg1" }, { kind: "tool" });
        await opts.onAssistantMessageStart?.();
      }
      await sendPreview(opts, "Partial reply");
      if (threadReplies && !consumeFirst) {
        expect(callArg(sendDraftMock, 0, 2)).toMatchObject({
          threadId: "$msg1",
          replyToId: undefined,
        });
      }
      sendMock.mockClear();
      await deliver(payload, { kind: "final" });
      if (consumeFirst) {
        expect(editMock).not.toHaveBeenCalled();
        expect(redactEventMock).toHaveBeenCalledWith(ROOM, "$draft1");
        expect(sendMock).toHaveBeenCalledTimes(1);
      } else {
        expect(editMock).toHaveBeenCalledOnce();
        expectNoCalls(redactEventMock, sendMock);
      }
      await finish();
    },
  );

  it("reuses partial-draft captions for a singular fallback after blank plural entries", async () => {
    const mediaUrls = ["   "];
    const { deliver, finish, redactEventMock } = await startPreview("screenshot ready", {
      streaming: "partial",
    });
    sendMock.mockClear();
    await deliver(
      { text: "screenshot ready", mediaUrl: "https://example.com/image.png", mediaUrls },
      { kind: "final" },
    );
    expect(editMock).toHaveBeenCalledTimes(1);
    expect(matrixEditOptions("$draft1", "screenshot ready").live).toBe(false);
    expect(redactEventMock).not.toHaveBeenCalled();
    expectDeliveredMediaReply();
    await finish();
  });

  it.each(["mentions", "event limit"] as const)(
    "replaces previews with one durable final for %s",
    async (reason) => {
      const mentions = reason === "mentions";
      const { redactEventMock, deliver, opts, finish } = await startStreaming(
        mentions ? { streaming: "partial", blockStreamingEnabled: true } : {},
      );
      const preview = mentions ? "hello @alice:example.org" : "1234";
      const finalText = mentions ? `${preview}!` : "123456";
      await sendPreview(opts, preview);
      if (!mentions) {
        prepareMock.mockImplementation((text: string) => ({
          ...prepareSingleText(text),
          singleEventLimit: 5,
          fitsInSingleEvent: text.trim().length <= 5,
        }));
        await opts.onPartialReply?.({ text: finalText });
      }
      if (mentions) {
        sendMock.mockClear();
      }
      await deliver({ text: finalText }, { kind: "final" });
      expect(editMock).not.toHaveBeenCalled();
      expect(redactEventMock).toHaveBeenCalledWith(ROOM, "$draft1");
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(callArg(sendMock, 0, 1, "final reply text")).toBe(finalText);
      expect(sendDraftMock).toHaveBeenCalledTimes(1);
      await finish();
    },
  );
});

it.each([
  { text: "@[OpenClaw Bot] /model", displayName: "OpenClaw Bot", expected: "/model" },
  {
    text: "Hello @bot:server how are you",
    userId: "@bot:server",
    expected: "Hello @bot:server how are you",
  },
])("strips only a leading mention from $text", ({ expected, ...params }) => {
  expect(stripMatrixMentionPrefix(params)).toBe(expected);
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

describe("matrix monitor handler block streaming config", () => {
  registerMatrixBlockStreamingConfigTests();
});

describe("Matrix invitation control-plane publications", () => {
  it.each([{}, null, { version: 1 }, { version: 2, recipientUserId: "@person:example.test" }])(
    "does not enrich or route a protected notice %j",
    async (marker) => {
      const getUserId = vi.fn(async () => "@bot:example.test");
      const { handler, resolveAgentRoute, recordInboundSession, runPrepared } = createHarness({
        client: { getUserId },
      });
      const event = textEvent({
        eventId: "$invitation",
        body: "You were added to this conversation.",
      });
      event.content["ai.cellect.invitation"] = marker;
      await handler(ROOM, event);
      expect(getUserId).not.toHaveBeenCalled();
      expect(resolveAgentRoute).not.toHaveBeenCalled();
      expect(recordInboundSession).not.toHaveBeenCalled();
      expect(runPrepared).not.toHaveBeenCalled();
    },
  );
  it("keeps ordinary messages with identical visible text on the native ingress", async () => {
    const { handler, recordInboundSession } = createHarness();
    await handler(
      ROOM,
      textEvent({ eventId: "$ordinary-notice", body: "You were added to this conversation." }),
    );
    expect(recordInboundSession).toHaveBeenCalledTimes(1);
  });
});
