import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import type { SlackSendResult } from "../../send.js";
import type * as SlackStreaming from "../../streaming.js";
import type { TestReplyPayload } from "./dispatch.compact-progress.test-support.js";
import type { SlackReplyOptionEvent } from "./dispatch.compact-progress.test-support.js";
import type { TestDispatchCounts } from "./dispatch.compact-progress.test-support.js";
import type { TestDispatchSequenceEntry } from "./dispatch.compact-progress.test-support.js";
import type { DeliveryParams } from "./dispatch.preview.test-support.js";
import type { PreparedSlackMessage } from "./types.js";
let capturedTurn:
  | Parameters<typeof import("openclaw/plugin-sdk/channel-inbound").dispatchChannelInboundTurn>[0]
  | undefined;

import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { createReplyDispatcher, type ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { resolveSlackAccount } from "../../accounts.js";
import { buildSlackCompleteBlocksFallbackText } from "../../blocks-fallback.js";
import { slackSetupPlugin } from "../../channel.setup.js";
import {
  createDraftStreamStub,
  preamble,
  approval,
  planEvent,
  textReply,
  section,
  emitSlackToolProgressTestEvent,
} from "./dispatch.compact-progress.test-support.js";
import { requireRecord } from "./dispatch.preview.test-support.js";

const FINAL_REPLY_TEXT = "final answer";

const THREAD_TS = "thread-1";

const STREAM_MESSAGE_TS = "171234.567";

const getGlobalHookRunnerMock = vi.hoisted(() => vi.fn());

const createSlackDraftStreamMock = vi.fn();

const normalDeliveryResult = {
  messageId: "normal-final",
  channelId: "C123",
  receipt: createMessageReceiptFromOutboundResults({
    results: [{ messageId: "normal-final", channelId: "C123" }],
  }),
};

const deliverRepliesMock = vi.fn(
  async (_params: DeliveryParams): Promise<SlackSendResult | undefined> => normalDeliveryResult,
);

const sendMessageSlackMock = vi.fn<typeof import("../../send.js").sendMessageSlack>();

const finalizeSlackPreviewEditMock = vi.fn(async (_input: { blocks?: unknown }) => {});

const normalizeSlackOutboundTextMock = vi.fn((value: string) => value.trim());

const postMessageMock = vi.fn(async () => ({ ok: true, ts: "171234.999" }));

const chatUpdateMock = vi.fn(async () => ({ ok: true, ts: "171234.999" }));

const recordSlackThreadParticipationMock = vi.fn();

const updateLastRouteMock = vi.hoisted(() => vi.fn(async () => {}));

const appendSlackStreamMock = vi.fn(async (_input?: unknown) => {});

const startSlackStreamMock = vi.fn(async (_input?: unknown) => createNativeStreamSession());

const stopSlackStreamMock = vi.fn(async (_params?: unknown) => ({}) as { messageId?: string });

const emitSlackMessageSentHooksMock = vi.fn(() => {});

const reactSlackMessageMock = vi.fn(async () => {});

const removeSlackReactionMock = vi.fn(async () => {});

const editSlackMessageMock = vi.fn<typeof import("../../actions.js").editSlackMessage>();

const editSlackRenderedMessageMock =
  vi.fn<typeof import("../../actions.js").editSlackRenderedMessage>();

const deleteSlackMessageMock = vi.fn<typeof import("../../actions.js").deleteSlackMessage>();

const logVerboseMock = vi.fn();

const { SlackStreamNotDeliveredError: NotDeliveredError } =
  await vi.importActual<typeof SlackStreaming>("../../streaming.js");

class TooLongError extends NotDeliveredError {}

let mockedNativeStreaming = false;

let mockedSlackStreamingMode: "off" | "partial" | "block" | "progress" = "partial";

let mockedPinnedMainDmOwner: string | undefined;

let capturedReplyOptions: GetReplyOptions | undefined;

const statusReactionControllerMock = {
  setQueued: vi.fn(async () => {}),
  setThinking: vi.fn(async () => {}),
  setTool: vi.fn(async () => {}),
  setError: vi.fn(async () => {}),
  setDone: vi.fn(async () => {}),
  clear: vi.fn(async () => {}),
  restoreInitial: vi.fn(async () => {}),
};

let mockedReplyThreadTs: string | undefined = THREAD_TS;

let mockedStatusThreadTs: string | undefined = THREAD_TS;

let mockedReplyThreadTsSequence: Array<string | undefined> | undefined;

let mockedSlackReplyBlocks: unknown[] | undefined;

let mockedSlackIsThreadReply = true;

type TypingCallbacks = {
  start: () => Promise<void>;
  stop?: () => Promise<void>;
  onStartError: (err: unknown) => void;
  onStopError?: (err: unknown) => void;
};

let mockedDispatchSequence: TestDispatchSequenceEntry[] = [];

let mockedQueuedDispatchCounts: TestDispatchCounts = { tool: 0, block: 0, final: 0 };

let mockedAgentRunTerminalOutcome: "completed" | "failed" | undefined;

let mockedSourceReplyDelivered = false;

let mockedDispatchError: Error | undefined;

let useRealChannelInboundTurn = false;

let mockedReplyOptionEvents: SlackReplyOptionEvent[] = [];

function progressAccount(
  progress: Record<string, unknown> = { toolProgress: true, label: "Working" },
) {
  mockedSlackStreamingMode = "progress";
  return { streaming: { mode: "progress", progress } };
}

function createNativeStreamSession() {
  return { channel: "C123", threadTs: THREAD_TS, stopped: false, delivered: true, pendingText: "" };
}

function useDraftStream(finalize = false) {
  if (finalize) {
    finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);
  }
  const draftStream = createDraftStreamStub();
  createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
  return draftStream;
}

function draftUpdateTexts(draftStream: ReturnType<typeof createDraftStreamStub>): string[] {
  return draftStream.update.mock.calls.map(([update]) => {
    if (typeof update === "string") {
      return update;
    }
    return requireRecord(update, "draft update").text as string;
  });
}

function createPreparedSlackMessage(params?: {
  cfg?: Record<string, unknown>;
  accountConfig?: Record<string, unknown>;
  ctxPayload?: Record<string, unknown>;
  message?: Partial<PreparedSlackMessage["message"]>;
  replyToMode?: "off" | "first" | "all" | "batched";
  isDirectMessage?: boolean;
  route?: Partial<PreparedSlackMessage["route"]>;
  typingReaction?: string;
  ackReactionMessageTs?: string;
  ackReactionPromise?: Promise<boolean> | null;
  relayIdentity?: { username?: string; iconUrl?: string; iconEmoji?: string };
  turnAdoptionLifecycle?: object;
  dispatchReplyFromConfig?: unknown;
  eventScope?: {
    teamId: string;
    client: Record<string, unknown>;
  };
}): PreparedSlackMessage {
  const routeSessionKey = params?.route?.sessionKey ?? "agent:agent-1:slack:C123";
  const mainSessionKey = params?.route?.mainSessionKey ?? "main";
  const lastRoutePolicy =
    params?.route?.lastRoutePolicy ?? (routeSessionKey === mainSessionKey ? "main" : "session");
  const message = {
    channel: "C123",
    ts: "171234.111",
    thread_ts: THREAD_TS,
    user: "U123",
    ...params?.message,
  };

  return {
    ctx: {
      cfg: params?.cfg ?? {},
      runtime: {},
      botToken: "xoxb-test",
      app: { client: { chat: { postMessage: postMessageMock, update: chatUpdateMock } } },
      teamId: "T1",
      botUserId: "U_OPENCLAW",
      botId: "B_OPENCLAW",
      textLimit: 4000,
      typingReaction: params?.typingReaction ?? "",
      historyLimit: 0,
      allowFrom: [],
      dispatchReplyFromConfig: params?.dispatchReplyFromConfig,
      setSlackSessionStatus: async () => true,
    },
    account: {
      accountId: "default",
      config: params?.accountConfig ?? {},
    },
    relayIdentity: params?.relayIdentity,
    turnAdoptionLifecycle: params?.turnAdoptionLifecycle,
    eventScope: params?.eventScope,
    message,
    route: {
      agentId: "agent-1",
      accountId: "default",
      mainSessionKey,
      sessionKey: routeSessionKey,
      lastRoutePolicy,
      ...params?.route,
    },
    channelConfig: null,
    replyTarget: `channel:${message.channel}`,
    ctxPayload: {
      MessageThreadId: THREAD_TS,
      ...params?.ctxPayload,
    },
    turn: {
      record: {},
    },
    replyToMode: params?.replyToMode ?? "all",
    isDirectMessage: params?.isDirectMessage ?? false,
    isRoomish: false,
    ackReactionValue: "eyes",
    ackReactionMessageTs: params?.ackReactionMessageTs,
    ackReactionPromise: params?.ackReactionPromise ?? null,
  } as unknown as PreparedSlackMessage;
}

async function dispatch(params?: Parameters<typeof createPreparedSlackMessage>[0]) {
  await dispatchPreparedSlackMessage(createPreparedSlackMessage(params));
}

async function dispatchProgress(progress?: Parameters<typeof progressAccount>[0]) {
  await dispatch({ accountConfig: progressAccount(progress) });
}

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveHumanDelayConfig: () => undefined,
}));

vi.mock("openclaw/plugin-sdk/channel-feedback", () => ({
  createStatusReactionController: () => statusReactionControllerMock,
  logAckFailure: () => {},
  logTypingFailure: () => {},
}));

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>();
  return {
    ...actual,
    createChannelProgressDraftCompositor: (
      params: Parameters<typeof actual.createChannelProgressDraftCompositor>[0],
    ) =>
      actual.createChannelProgressDraftCompositor({
        ...params,
        // Gate timing lives in the compositor suite; dispatch tests exercise
        // Slack rendering and delivery after work admits the draft.
        setTimeoutFn: ((handler: () => void) => {
          handler();
          return 0 as never;
        }) as unknown as typeof setTimeout,
        clearTimeoutFn: (() => {}) as typeof clearTimeout,
      }),
    createChannelMessageReplyPipeline: (params: {
      transformReplyPayload?: (payload: TestReplyPayload) => TestReplyPayload | null;
      typing?: TypingCallbacks;
    }) => {
      return {
        typingCallbacks: params.typing
          ? {
              onReplyStart: params.typing.start,
              onIdle: () => {
                void params.typing?.stop?.();
              },
            }
          : undefined,
        transformReplyPayload: params.transformReplyPayload,
        onModelSelected: undefined,
      };
    },
    resolveChannelMessageSourceReplyDeliveryMode:
      actual.resolveChannelMessageSourceReplyDeliveryMode,
    resolveAgentOutboundIdentity: () => undefined,
    buildChannelProgressDraftLine: ({ explanation }: { explanation?: string }) =>
      explanation
        ? {
            kind: "plan",
            text: `🗺️ Update Plan: ${explanation}`,
            label: "Update Plan",
            detail: explanation,
            toolName: "update_plan",
          }
        : undefined,
    resolveChannelProgressDraftMaxLineChars: (entry?: {
      streaming?: { progress?: { maxLineChars?: number } };
    }) => entry?.streaming?.progress?.maxLineChars,
    resolveChannelStreamingBlockEnabled: () => false,
  };
});

vi.mock("openclaw/plugin-sdk/reply-payload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/reply-payload")>()),
  resolveAskUserQuestionOptionIndices: () => undefined,
  isReplyPayloadNonTerminalToolErrorWarning: () => false,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  danger: (message: string) => message,
  logVerbose: logVerboseMock,
  shouldLogVerbose: () => false,
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>();
  return { ...actual, getGlobalHookRunner: getGlobalHookRunnerMock };
});

vi.mock("openclaw/plugin-sdk/security-runtime", () => ({
  resolvePinnedMainDmOwnerFromAllowlist: () => mockedPinnedMainDmOwner,
}));

vi.mock("../../actions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../actions.js")>()),
  reactSlackMessage: reactSlackMessageMock,
  removeSlackReaction: removeSlackReactionMock,
  editSlackMessage: editSlackMessageMock,
  editSlackRenderedMessage: editSlackRenderedMessageMock,
  deleteSlackMessage: deleteSlackMessageMock,
}));

vi.mock("../../draft-stream.js", () => ({ createSlackDraftStream: createSlackDraftStreamMock }));

vi.mock("../../format.js", () => ({
  markdownToSlackMrkdwnChunks: (value: string) => [value],
  normalizeSlackOutboundText: normalizeSlackOutboundTextMock,
}));

vi.mock("../../limits.js", () => ({ SLACK_TEXT_LIMIT: 4000, SLACK_EDIT_TEXT_MAX_BYTES: 4000 }));

vi.mock("../../sent-thread-cache.js", () => ({
  clearSlackThreadFailureNotice: () => {},
  hasSlackThreadParticipation: () => false,
  recordSlackThreadFailureNotice: () => true,
  recordSlackThreadParticipation: recordSlackThreadParticipationMock,
}));

vi.mock("../../stream-mode.js", () => ({
  applyAppendOnlyStreamUpdate: ({ incoming }: { incoming: string }) => ({
    changed: true,
    rendered: incoming,
    source: incoming,
  }),
  resolveSlackStreamingConfig: () => ({
    mode: mockedSlackStreamingMode,
    nativeStreaming: mockedNativeStreaming,
  }),
}));

vi.mock("../../streaming.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SlackStreaming>()),
  appendSlackStream: appendSlackStreamMock,
  markSlackStreamFallbackDelivered: (session: ReturnType<typeof createNativeStreamSession>) => {
    session.pendingText = "";
    session.stopped = !session.delivered;
  },
  SlackStreamMessageTooLongError: TooLongError,
  startSlackStream: async (input: unknown) =>
    Object.assign(await startSlackStreamMock(input), { streamer: { ts: STREAM_MESSAGE_TS } }),
  stopSlackStream: async (params: { session: { stopped: boolean } }) => {
    params.session.stopped = true;
    return await stopSlackStreamMock(params);
  },
}));

vi.mock("../../message-sent-hook.js", () => ({
  emitSlackMessageSentHooks: emitSlackMessageSentHooksMock,
}));

vi.mock("../../threading.js", () => ({
  resolveSlackThreadContext: () => ({
    messageThreadId: mockedStatusThreadTs,
    isThreadReply: mockedSlackIsThreadReply,
  }),
}));

vi.mock("../allow-list.js", () => ({
  normalizeSlackAllowOwnerEntry: (value: string) => value,
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/session-store-runtime")>()),
  resolveStorePath: () => "/tmp/openclaw-store.json",
  updateLastRoute: updateLastRouteMock,
}));

vi.mock("../../reply-blocks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../reply-blocks.js")>()),
  resolveSlackReplyBlocks: () => mockedSlackReplyBlocks,
}));

vi.mock("../replies.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../replies.js")>()),
  createSlackReplyDeliveryPlan: () => ({
    peekThreadTs: () =>
      mockedReplyThreadTsSequence ? mockedReplyThreadTsSequence[0] : mockedReplyThreadTs,
    nextThreadTs: () =>
      mockedReplyThreadTsSequence ? mockedReplyThreadTsSequence.shift() : mockedReplyThreadTs,
    markSent: () => {},
  }),
  deliverReplies: (params: Parameters<typeof import("../replies.js").deliverReplies>[0]) =>
    deliverRepliesMock({ ...params, replies: params.replies.map((prepared) => prepared.payload) }),
}));

vi.mock("../../send.js", () => ({ sendMessageSlack: sendMessageSlackMock }));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  type DispatchParams = Parameters<typeof actual.dispatchChannelInboundTurn>[0];
  return {
    ...actual,
    readAgentRunTerminalOutcome: () => mockedAgentRunTerminalOutcome,
    dispatchChannelInboundTurn: async (params: DispatchParams) => {
      capturedTurn = params;
      if (useRealChannelInboundTurn) {
        return actual.dispatchChannelInboundTurn(params);
      }
      capturedReplyOptions = params.replyOptions as typeof capturedReplyOptions;
      for (const [index, entry] of mockedReplyOptionEvents.entries()) {
        if (entry.kind === "item") {
          const { kind: _kind, itemKind, ...payload } = entry;
          await params.replyOptions?.onItemEvent?.({ ...payload, kind: itemKind });
        } else if (entry.kind === "command_output" || entry.kind === "tool_start") {
          await emitSlackToolProgressTestEvent(params.replyOptions, entry, index);
        } else if (entry.kind === "patch") {
          const { kind: _kind, ...payload } = entry;
          await params.replyOptions?.onPatchSummary?.(payload);
          if (entry.phase === "end") {
            await params.replyOptions?.onItemEvent?.({
              itemId: entry.itemId,
              toolCallId: entry.toolCallId,
              kind: "patch",
              phase: "end",
              status: "completed",
              title: entry.title ?? "Apply Patch",
              name: entry.name,
              meta: entry.summary,
            });
          }
        } else if (entry.kind === "plan") {
          const { kind: _kind, ...payload } = entry;
          await params.replyOptions?.onPlanUpdate?.(payload);
        } else if (entry.kind === "concurrent_items") {
          await Promise.all(
            entry.progressTexts.map((progressText) =>
              Promise.resolve(params.replyOptions?.onItemEvent?.({ progressText })),
            ),
          );
        } else if (entry.kind === "assistant_start") {
          await params.replyOptions?.onAssistantMessageStart?.();
        } else if (entry.kind === "reasoning") {
          const { kind: _kind, ...payload } = entry;
          await params.replyOptions?.onReasoningStream?.(payload);
        } else if (entry.kind === "reasoning_end") {
          await params.replyOptions?.onReasoningEnd?.();
        } else if (entry.kind === "visible_work") {
          await params.replyOptions?.onVisibleWorkSessions?.(entry.sessions);
        } else if (entry.kind === "checkpoint") {
          await entry.run();
        } else if (entry.kind === "approval") {
          const { kind: _kind, ...payload } = entry;
          await params.replyOptions?.onApprovalEvent?.(payload);
        } else if (entry.kind === "partial") {
          await params.replyOptions?.onPartialReply?.({ text: entry.text });
        } else {
          throw new Error("Unsupported test event");
        }
      }
      if (mockedDispatchError) {
        throw mockedDispatchError;
      }
      for (const entry of mockedDispatchSequence) {
        if (entry.kind === "checkpoint") {
          await entry.run();
          continue;
        }
        if (entry.kind === "queued_followup") {
          await params.replyOptions?.onQueuedFollowupAdmitted?.();
          continue;
        }
        if (entry.kind === "item") {
          await params.replyOptions?.onItemEvent?.({ progressText: entry.progressText });
          continue;
        }
        const payload = entry.payload as ReplyPayload;
        const transformed = params.dispatcherOptions?.transformReplyPayload
          ? params.dispatcherOptions.transformReplyPayload(payload)
          : payload;
        if (!transformed) {
          continue;
        }
        const deliverPayload = params.dispatcherOptions?.beforeDeliver
          ? await params.dispatcherOptions.beforeDeliver(transformed, { kind: entry.kind })
          : transformed;
        if (!deliverPayload) {
          continue;
        }
        mockedQueuedDispatchCounts[entry.kind] += 1;
        const dispatcher = createReplyDispatcher({
          deliver: params.delivery.deliver,
          onError: params.delivery.onError,
        });
        if (entry.kind === "tool") {
          dispatcher.sendToolResult(deliverPayload);
        } else if (entry.kind === "block") {
          dispatcher.sendBlockReply(deliverPayload);
        } else {
          dispatcher.sendFinalReply(deliverPayload);
        }
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
      }
      return {
        admission: { kind: "dispatch" } as const,
        dispatched: true as const,
        ctxPayload: params.ctxPayload,
        routeSessionKey: params.route.sessionKey,
        dispatchResult: {
          queuedFinal: false,
          counts: { ...mockedQueuedDispatchCounts },
          observedReplyDelivery: mockedSourceReplyDelivered,
        },
      };
    },
  };
});

vi.mock("./preview-finalize.js", () => ({
  finalizeSlackPreviewEdit: finalizeSlackPreviewEditMock,
}));

let dispatchPreparedSlackMessage: typeof import("./dispatch.js").dispatchPreparedSlackMessage;

beforeAll(async () => {
  ({ dispatchPreparedSlackMessage } = await import("./dispatch.js"));
});

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "slack", source: "test", plugin: slackSetupPlugin }]),
  );
  createSlackDraftStreamMock.mockReset();
  deliverRepliesMock.mockReset();
  sendMessageSlackMock.mockReset();
  editSlackMessageMock.mockReset();
  editSlackRenderedMessageMock.mockReset();
  deleteSlackMessageMock.mockReset();
  useRealChannelInboundTurn = false;
  finalizeSlackPreviewEditMock.mockReset();
  normalizeSlackOutboundTextMock.mockClear();
  postMessageMock.mockClear();
  chatUpdateMock.mockClear();
  recordSlackThreadParticipationMock.mockReset();
  updateLastRouteMock.mockReset();
  appendSlackStreamMock.mockReset().mockResolvedValue(undefined);
  startSlackStreamMock.mockReset();
  stopSlackStreamMock.mockReset().mockResolvedValue({});
  reactSlackMessageMock.mockReset();
  removeSlackReactionMock.mockReset();
  logVerboseMock.mockReset();
  getGlobalHookRunnerMock.mockReset().mockReturnValue(undefined);
  for (const value of Object.values(statusReactionControllerMock)) {
    value.mockClear();
  }
  mockedNativeStreaming = false;
  mockedSlackStreamingMode = "partial";
  mockedPinnedMainDmOwner = undefined;
  capturedReplyOptions = undefined;
  mockedReplyThreadTs = THREAD_TS;
  mockedStatusThreadTs = THREAD_TS;
  mockedReplyThreadTsSequence = undefined;
  mockedSlackReplyBlocks = undefined;
  mockedSlackIsThreadReply = true;
  mockedDispatchSequence = [textReply(FINAL_REPLY_TEXT)];
  mockedQueuedDispatchCounts = { tool: 0, block: 0, final: 0 };
  mockedAgentRunTerminalOutcome = undefined;
  mockedSourceReplyDelivered = false;
  mockedDispatchError = undefined;
  mockedReplyOptionEvents = [];

  createSlackDraftStreamMock.mockReturnValue(createDraftStreamStub());
  finalizeSlackPreviewEditMock.mockRejectedValue(new Error("socket closed"));
  startSlackStreamMock.mockResolvedValue(createNativeStreamSession());
  emitSlackMessageSentHooksMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  resetPluginRuntimeStateForTest();
});

it.each(["plain", "detailed"] as const)(
  "deduplicates a %s plan headline and preamble",
  async (format) => {
    const draftStream = useDraftStream();
    const plain = format === "plain";
    const headline = plain ? "Read *literal* <@U123>" : "Checking the workspace";
    const plan: SlackReplyOptionEvent = {
      ...planEvent("Inspect", headline),
      ...(plain ? { explanationFormat: "plain" as const } : {}),
    };
    const commentary = preamble(headline, "preamble-1");
    if (plain) {
      mockedDispatchSequence = [];
    }
    mockedReplyOptionEvents = plain ? [commentary, plan] : [plan, commentary];
    await dispatchProgress({
      style: "card",
      toolProgress: !plain,
      ...(!plain ? { commentary: true } : {}),
    });
    if (plain) {
      expect(draftStream.update).toHaveBeenLastCalledWith({
        text: "Read *literal* &lt;@U123&gt;",
        blocks: [section(headline, true)],
      });
    } else {
      const text = draftUpdateTexts(draftStream).at(-1)!;
      expect(text.match(/Checking the workspace/g)).toHaveLength(1);
      expect(text).toContain("_Checking the workspace_");
      expect(text).toContain("▸ Inspect");
    }
  },
);

it("caps the card fallback text at the draft limit while keeping the long blocks", async () => {
  const draftStream = useDraftStream();
  const long = (word: string) => Array.from({ length: 400 }, () => word).join(" ");
  mockedReplyOptionEvents = [
    planEvent("Inspect", long("explain")),
    preamble(long("status"), "preamble-1"),
    ...Array.from({ length: 20 }, (_, index) =>
      approval(`${long("run")}-${index}`, `approval-${index}`),
    ),
  ];
  await dispatchProgress({ style: "card" });
  const update = requireRecord(draftStream.update.mock.calls.at(-1)?.[0], "long card update");
  const blocks = update.blocks as unknown[];
  // Precondition: the full card text exceeds the 4,000-character draft limit.
  expect(buildSlackCompleteBlocksFallbackText(blocks).length).toBeGreaterThan(4000);
  expect((update.text as string).length).toBeLessThanOrEqual(4000);
  expect(JSON.stringify(blocks)).toContain("Approval required:");
});

it.each([
  { firstSend: "delivered", messageId: "171234.567" },
  // The first Slack post is still queued or in flight, so no message id exists yet.
  { firstSend: "pending", messageId: undefined },
])(
  "deletes a working card once a resolved approval was its last visible row (first send $firstSend)",
  async ({ messageId }) => {
    const draftStream = useDraftStream();
    draftStream.messageId = () => messageId;
    mockedReplyOptionEvents = [
      // The default card hides the plan, but the compositor still holds it.
      planEvent("Inspect"),
      approval("run checks"),
      { kind: "approval", phase: "resolved", approvalId: "approval-1" },
    ];
    await dispatchProgress({ style: "card" });
    expect(draftUpdateTexts(draftStream)).toEqual([
      "Approval required: run checks; approval requested",
    ]);
    expect(draftStream.clear).toHaveBeenCalled();
    expect(draftStream.forceNewMessage).toHaveBeenCalled();
  },
);

it.each(["reverse-write", "read-only"] as const)(
  "preserves the admitted Slack sender for %s projected durable finals",
  async (sourceMode) => {
    const bindings = vi.spyOn(getSessionBindingService(), "listBySession").mockReturnValue([
      {
        bindingId: "projection",
        targetSessionKey: "agent:agent-1:slack:C123",
        targetKind: "session",
        conversation: { channel: "matrix", accountId: "default", conversationId: "!room:test" },
        status: "active",
        boundAt: 1,
        metadata: {
          environment: "test",
          projectedConversationId: "!room:test",
          ...(sourceMode === "reverse-write"
            ? { sourceReplyAuthorization: "fixture" }
            : { boundBy: "session-projection-read-only" }),
        },
      },
    ]);
    try {
      const cfg = { channels: { slack: { botToken: "xoxb-test" } } };
      const prepared = createPreparedSlackMessage({ cfg });
      prepared.account = resolveSlackAccount({ cfg, accountId: "default" });
      await dispatchPreparedSlackMessage(prepared);
      const durable = capturedTurn?.delivery?.durable;
      if (typeof durable !== "function") {
        throw new Error("Expected a Slack durable final adapter");
      }
      const options = await durable({ text: FINAL_REPLY_TEXT }, { kind: "final" });
      if (!options || !options.prepareRuntimeHandoff) {
        throw new Error("Projected Slack finals must preserve their admitted sender");
      }
      const pinned = options.prepareRuntimeHandoff(cfg);
      expect(pinned.channels?.slack?.accounts?.default?.botToken).toBe("xoxb-test");
      expect(() =>
        options.prepareRuntimeHandoff?.({ channels: { slack: { botToken: "xoxb-other" } } }),
      ).toThrow("Slack reply sender changed");
    } finally {
      bindings.mockRestore();
    }
  },
);
