// Stopped queued input must not become a missing-reply warning at finalization.
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { ConversationRunStopReason } from "../../infra/run-stop-actor.js";
import type { TemplateContext } from "../templating.js";
import { buildNoVisibleReplyFallbackText } from "./dispatch-from-config.payloads.js";
import { createDispatcher, emptyConfig } from "./dispatch-from-config.shared.test-harness.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
import {
  recordReplyOperationAgentTurn,
  resolveReplyOperationRunState,
} from "./reply-operation-run-state.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { buildTestCtx } from "./test-ctx.js";
import type { TypingController } from "./typing.js";

beforeAll(globalBeforeAll0);
beforeEach(() => {
  describe0BeforeEach0();
  setNoAbort();
});

it.each(
  ["discord", "matrix"].flatMap((provider) =>
    (["aborted", "live", "absent"] as const).map((signalState) => ({ provider, signalState })),
  ),
)(
  "settles a typed conversation Stop on $provider without a failure reply (dispatch signal=$signalState)",
  async ({ provider, signalState }) => {
    const controller = new AbortController();
    const dispatcher = createDispatcher();
    const reason = new ConversationRunStopReason({
      userId: "@reader:matrix.test",
      roomId: "!room:matrix.test",
      threadRootEventId: "$root",
      agentId: "main",
      sessionKey: "agent:main:conversation-stop",
    });
    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: provider,
        Surface: provider,
        ChatType: "direct",
        SessionKey: reason.actor.sessionKey,
      }),
      cfg: emptyConfig,
      dispatcher,
      replyOptions: { abortSignal: signalState === "absent" ? undefined : controller.signal },
      replyResolver: async () => {
        if (signalState === "aborted") {
          controller.abort(reason);
        }
        throw reason;
      },
    });
    expect(result.queuedFinal).toBe(false);
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
  },
);

it.each(["genuine failure", "ConversationRunStopReason"])(
  "preserves %s as a dispatch error",
  async (name) => {
    const controller = new AbortController();
    const error = Object.assign(new Error("dispatch failure"), { name });
    const dispatcher = createDispatcher();
    await expect(
      dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "matrix",
          Surface: "matrix",
          ChatType: "direct",
          SessionKey: "agent:main:dispatch-failure",
        }),
        cfg: emptyConfig,
        dispatcher,
        replyOptions: { abortSignal: controller.signal },
        replyResolver: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  },
);

// A Stop can reach only the run's own operation, or only the native run,
// leaving dispatch's signal live. The runner records the cancelled turn and
// returns nothing; for a user Stop that is not a missing reply.
it.each([
  {
    name: "native run stopped during the first model call",
    owner: { result: null },
    outcome: { kind: "aborted", reason: "user" },
    fallback: false,
  },
  {
    name: "reply operation aborted by the user",
    owner: { result: { kind: "aborted", code: "aborted_by_user" } },
    outcome: undefined,
    fallback: false,
  },
  {
    name: "native run aborted for restart",
    owner: { result: null },
    outcome: { kind: "aborted", reason: "restart" },
    fallback: true,
  },
  {
    name: "reply operation aborted for restart",
    owner: { result: { kind: "aborted", code: "aborted_for_restart" } },
    outcome: undefined,
    fallback: true,
  },
] as const)(
  "$name with no reply posts fallback=$fallback",
  async ({ owner, outcome, fallback }) => {
    const dispatcher = createDispatcher();
    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "matrix",
        Surface: "matrix",
        ChatType: "direct",
        SessionKey: "agent:main:inner-stop",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyOptions: { abortSignal: new AbortController().signal },
      replyResolver: async (_inbound, opts) => {
        recordReplyOperationAgentTurn(
          [resolveReplyOperationRunState(opts)!],
          owner as unknown as ReplyOperation,
          outcome,
        );
        return undefined;
      },
    });
    if (fallback) {
      expect(dispatcher.sendFinalReply).toHaveBeenCalledOnce();
    } else {
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
      expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
    }
  },
);

it("still posts the fallback after a failed agent turn with no reply", async () => {
  const dispatcher = createDispatcher();
  const result = await dispatchReplyFromConfig({
    ctx: buildTestCtx({
      Provider: "matrix",
      Surface: "matrix",
      ChatType: "direct",
      SessionKey: "agent:main:inner-failure",
    }),
    cfg: emptyConfig,
    dispatcher,
    replyOptions: { abortSignal: new AbortController().signal },
    replyResolver: async (_inbound, opts) => {
      const owner = { result: { kind: "failed", code: "run_failed" } } as unknown as ReplyOperation;
      recordReplyOperationAgentTurn([resolveReplyOperationRunState(opts)!], owner);
      return undefined;
    },
  });
  expect(dispatcher.sendFinalReply).toHaveBeenCalledExactlyOnceWith({
    text: buildNoVisibleReplyFallbackText(),
  });
  expect(result.noVisibleReplyFallbackDelivered).toBe(true);
});

it.each([
  { name: "cutoff message ID", message: { MessageSid: "42" }, cancelled: true },
  { name: "older timestamp", message: { Timestamp: 999 }, cancelled: true },
  { name: "newer message ID", message: { MessageSid: "43" }, cancelled: false },
  { name: "newer timestamp", message: { Timestamp: 1001 }, cancelled: false },
])("settles $name without waiving a newer missing reply", async ({ message, cancelled }) => {
  const sessionKey = "agent:main:discord:direct:abort-cutoff";
  const sessionEntry: SessionEntry = {
    sessionId: "cutoff-session",
    updatedAt: 0,
    abortCutoffMessageSid: "42",
    abortCutoffTimestamp: 1000,
    abortedLastRun: true,
  };
  const sessionStore = { [sessionKey]: sessionEntry };
  const typing: TypingController = {
    onReplyStart: async () => {},
    startTypingLoop: async () => {},
    startTypingOnText: async () => {},
    refreshTypingTtl: () => {},
    isActive: () => false,
    markRunComplete: () => {},
    markDispatchIdle: () => {},
    cleanup: vi.fn(),
  };
  const dispatcher = createDispatcher();
  const continueTurn = vi.fn(async () => undefined);
  const ctx = buildTestCtx({
    Provider: "discord",
    Surface: "discord",
    ChatType: "direct",
    SessionKey: sessionKey,
    Body: "queued input",
    CommandBody: "queued input",
    ...message,
  });
  // Exercise the production inline owner with dispatch's actual options/state,
  // then let the real finalizer decide whether a fallback is owed.
  const result = await dispatchReplyFromConfig({
    ctx,
    cfg: emptyConfig,
    dispatcher,
    replyResolver: async (inbound, opts) => {
      const inline = await handleInlineActions({
        ctx: inbound,
        sessionCtx: inbound as TemplateContext,
        cfg: emptyConfig,
        agentId: "main",
        sessionKey,
        sessionEntry,
        sessionStore,
        workspaceDir: "/unused",
        isGroup: false,
        opts,
        typing,
        allowTextCommands: false,
        inlineStatusRequested: false,
        command: {
          surface: "discord",
          channel: "discord",
          channelId: "discord",
          ownerList: [],
          senderIsOwner: false,
          isAuthorizedSender: false,
          abortKey: sessionKey,
          rawBodyNormalized: "queued input",
          commandBodyNormalized: "queued input",
        },
        directives: clearInlineDirectives("queued input"),
        cleanedBody: "queued input",
        elevatedEnabled: false,
        elevatedAllowed: false,
        elevatedFailures: [],
        defaultActivation: () => "always",
        resolveModelLevels: async () => ({
          resolvedThinkLevel: undefined,
          resolvedReasoningLevel: "off",
        }),
        resolvedVerboseLevel: undefined,
        resolvedElevatedLevel: "off",
        resolveDefaultThinkingLevel: async () => "off",
        provider: "openai",
        model: "test-model",
        contextTokens: 0,
        abortedLastRun: true,
        sessionScope: "per-sender",
      });
      return inline.kind === "reply" ? inline.reply : continueTurn();
    },
  });

  if (cancelled) {
    expect(continueTurn).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalledOnce();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(result.deliberateSilentTerminalReply).toBe(true);
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
    expect(sessionEntry.abortCutoffMessageSid).toBe("42");
  } else {
    expect(continueTurn).toHaveBeenCalledOnce();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledExactlyOnceWith({
      text: buildNoVisibleReplyFallbackText(),
    });
    expect(result.noVisibleReplyFallbackDelivered).toBe(true);
    expect(result.deliberateSilentTerminalReply).toBeUndefined();
    expect(sessionEntry.abortCutoffMessageSid).toBeUndefined();
    expect(sessionEntry.abortCutoffTimestamp).toBeUndefined();
  }
});
