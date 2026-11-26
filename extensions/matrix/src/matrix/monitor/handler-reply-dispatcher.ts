import {
  createAcceptedChannelDeliveryResult,
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createChannelDeliveryAccumulator,
  createPreviewMessageReceipt,
  createReplyPrefixOptions,
  createTypingCallbacks,
  deriveDurableFinalDeliveryRequirements,
  type MessageReceipt,
  type LivePreviewDeliveryResult,
} from "openclaw/plugin-sdk/channel-outbound";
import { resolveOutboundMediaAccessForConfig } from "openclaw/plugin-sdk/outbound-media";
import {
  buildTtsSupplementMediaPayload,
  getReplyPayloadTtsSupplement,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { readNativeFinalReplySource, type ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { stripReasoningTagsFromText } from "openclaw/plugin-sdk/text-chunking";
import { prepareMatrixReplyPayload, resolveMatrixExtraContent } from "../../outbound.js";
import { getMatrixRuntime } from "../../runtime.js";
import type { CoreConfig, MatrixStreamingMode, ReplyToMode } from "../../types.js";
import { deliverBoundSourceReply } from "../bound-source-reply.js";
import { resolveMatrixReplyPublication } from "../projection-publication.js";
import type { MatrixClient } from "../sdk.js";
import { sendMessageMatrix } from "../send.js";
import {
  MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY,
  MATRIX_REPLY_TO_TRIGGER_CONTENT_KEY,
  MATRIX_STREAM_PHASE_CONTENT_KEY,
  type MatrixSendResult,
} from "../send/types.js";
import type {
  createMatrixDraftController,
  MatrixReplyDispatchInfo,
} from "./handler-draft-controller.js";
import {
  loadMatrixSendModule,
  matrixTextWouldActivateMentions,
  type MatrixDraftStreamHandle,
} from "./handler-runtime.js";

type MatrixDraftController = Awaited<ReturnType<typeof createMatrixDraftController>>;
type MatrixReplyDeliveryResult = LivePreviewDeliveryResult;

function mergeMatrixReplyDeliveryResults(
  results: readonly MatrixReplyDeliveryResult[],
): MatrixReplyDeliveryResult {
  const single = results.length === 1 ? results[0] : undefined;
  if (single?.visibleReplySent) {
    return single;
  }
  const visibleResults = results.filter((result) => result.visibleReplySent);
  if (visibleResults.length === 0) {
    return { visibleReplySent: false, suppression: { reason: "no_visible_result" } };
  }
  const content = visibleResults
    .map((result) => result.content)
    .filter(Boolean)
    .join("\n");
  if (visibleResults.some((result) => result.receipt || result.messageIds?.length)) {
    return createAcceptedChannelDeliveryResult({ deliveryResults: visibleResults, content });
  }
  return { visibleReplySent: true, content };
}

function toMatrixPartialDeliveryError(
  error: unknown,
  settled: readonly MatrixReplyDeliveryResult[],
): unknown {
  const failedPartial = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
  const merged = mergeMatrixReplyDeliveryResults([
    ...settled,
    ...(failedPartial ? [failedPartial] : []),
  ]);
  return merged.visibleReplySent
    ? createChannelPartialDeliveryError(error, { ...merged, visibleReplySent: true })
    : error;
}

function resolveVisibleMatrixReplyText(text?: string): string | undefined {
  if (typeof text !== "string") {
    return undefined;
  }
  const trimmedStart = text.trimStart();
  if (!trimmedStart) {
    return text;
  }
  if (normalizeLowercaseStringOrEmpty(trimmedStart).startsWith("reasoning:")) {
    return undefined;
  }
  const visibleText = stripReasoningTagsFromText(text, { mode: "strict", trim: "none" });
  return visibleText.trim() ? visibleText : undefined;
}

/** Fi pairs a finished answer with the person's "Let me know" request by this field. */
const MATRIX_LET_ME_KNOW_ANSWER_CONTENT_KEY = "ai.cellect.let_me_know_answer";

export function createMatrixReplyDispatcher(config: {
  cfg: CoreConfig;
  prefixOptions: Omit<ReturnType<typeof createReplyPrefixOptions>, "onModelSelected">;
  humanDelay: ReturnType<
    typeof import("openclaw/plugin-sdk/agent-runtime").resolveHumanDelayConfig
  >;
  typingCallbacks: ReturnType<typeof createTypingCallbacks>;
  streaming: MatrixStreamingMode;
  draftStream: MatrixDraftStreamHandle | undefined;
  draftController: MatrixDraftController;
  client: MatrixClient;
  roomId: string;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  threadTarget?: string;
  replyToEventId?: string;
  /** The turn's own triggering "Let me know" event; only its final replies are marked. */
  letMeKnowTriggerEventId?: string;
  /** This turn was admitted into the bound source session. */
  sourceReply?: { sessionKey: string; eventId: string };
  accountId: string;
  mediaLocalRoots: readonly string[];
  durableProjection?: boolean;
  logVerboseMessage: (message: string) => void;
}) {
  const {
    cfg,
    prefixOptions,
    humanDelay,
    typingCallbacks,
    streaming,
    draftStream,
    draftController,
    client,
    roomId,
    runtime,
    replyToMode,
    threadTarget,
    replyToEventId,
    letMeKnowTriggerEventId,
    sourceReply,
    accountId,
    mediaLocalRoots,
    durableProjection = false,
    logVerboseMessage,
  } = config;
  const quietDraftStreaming = streaming === "quiet" || streaming === "progress";
  let sourceReplyPart = 0;
  const letMeKnowAnswerContent = letMeKnowTriggerEventId
    ? {
        [MATRIX_LET_ME_KNOW_ANSWER_CONTENT_KEY]: {
          version: 1,
          triggerEventId: letMeKnowTriggerEventId,
        },
      }
    : undefined;
  const progressDraftStreaming = streaming === "progress";
  // Tool, block, and final payloads are delivered separately but share one first-reply slot.
  let hasReplied = false;
  const deliverPayload = async (
    reply: ReplyPayload,
    additionalContent?: Record<string, unknown>,
  ): Promise<MatrixReplyDeliveryResult> => {
    const core = getMatrixRuntime();
    const logVerbose = (message: string) => {
      if (core.logging.shouldLogVerbose()) {
        runtime.log?.(message);
      }
    };
    const accepted = createChannelDeliveryAccumulator();
    const visibleText = resolveVisibleMatrixReplyText(reply.text);
    const { hasMedia, hasText, mediaUrls } = resolveSendableOutboundReplyParts(reply);
    if (reply.isReasoning === true || (!hasMedia && reply.text && visibleText === undefined)) {
      logVerbose("matrix reply suppressed as reasoning-only");
      return accepted.result();
    }
    if (!hasText && !hasMedia) {
      if (reply.audioAsVoice) {
        logVerbose("matrix reply has audioAsVoice without media/text; skipping");
      } else {
        runtime.error?.("matrix reply missing text/media");
      }
      return accepted.result();
    }
    const explicitReplyToId =
      reply.replyToTag || reply.replyToCurrent ? reply.replyToId?.trim() : undefined;
    const ambientReplyToId = threadTarget ?? replyToEventId;
    const replyToIdForReply =
      explicitReplyToId ||
      (!threadTarget && replyToMode !== "off" && (replyToMode === "all" || !hasReplied)
        ? (reply.replyToId ?? ambientReplyToId)?.trim()
        : undefined);
    const fallbackReplyToId = threadTarget
      ? (reply.replyToId ?? ambientReplyToId)?.trim()
      : undefined;
    const onDeliveryResult = (result: MatrixSendResult) => {
      // A concrete event consumes the first-reply slot even when a later event fails.
      accepted.add({ receipt: result.receipt }, result.content);
      if (replyToIdForReply) {
        hasReplied = true;
      }
    };
    // The reply's own event fields ride its first event, not a later chunk.
    const replyContent = { ...resolveMatrixExtraContent(reply), ...additionalContent };
    const extraContent = Object.keys(replyContent).length > 0 ? replyContent : undefined;
    const targets = mediaUrls.length > 0 ? mediaUrls : [undefined];
    try {
      for (const [index, mediaUrl] of targets.entries()) {
        await sendMessageMatrix(roomId, index === 0 ? (visibleText ?? "") : "", {
          client,
          cfg,
          ...(mediaUrl !== undefined
            ? {
                mediaUrl,
                mediaLocalRoots,
                mediaAccess: resolveOutboundMediaAccessForConfig(cfg),
                audioAsVoice: reply.audioAsVoice,
              }
            : {}),
          replyToId: replyToIdForReply,
          fallbackReplyToId,
          threadId: threadTarget,
          accountId,
          extraContent: index === 0 ? extraContent : undefined,
          publication: resolveMatrixReplyPublication(
            reply,
            accountId,
            roomId,
            threadTarget,
            index,
            index === targets.length - 1,
          ),
          onDeliveryResult,
        });
      }
    } catch (error: unknown) {
      throw toMatrixPartialDeliveryError(error, [accepted.result()]);
    }
    return accepted.result();
  };
  const { previewLifecycle } = draftController;
  let nonFinalReplyDeliveryFailed = false;
  const isDurableFinal = (payload: ReplyPayload, info: MatrixReplyDispatchInfo) =>
    durableProjection && !sourceReply && info.kind === "final" && !payload.isCompactionNotice;
  const forwardBoundSourceReply = async (
    payload: ReplyPayload,
    result: MatrixReplyDeliveryResult | void,
  ) => {
    if (
      !sourceReply ||
      !result?.visibleReplySent ||
      !payload.text?.trim() ||
      payload.isCompactionNotice ||
      payload.isReasoning ||
      payload.isCommentary ||
      payload.isStatusNotice
    ) {
      return;
    }
    const partIndex = sourceReplyPart++;
    try {
      await deliverBoundSourceReply({
        matrixAccountId: accountId,
        roomId,
        sessionKey: sourceReply.sessionKey,
        triggerEventId: sourceReply.eventId,
        partIndex,
        text: payload.text,
      });
    } catch {
      // The room already has the answer. A Slack miss must not fail that delivery.
      logVerboseMessage(`matrix: bound source reply was not delivered room=${roomId}`);
    }
  };
  const beginNextBlockDraft = (
    boundary: ReturnType<MatrixDraftController["captureDraftBlockBoundary"]>,
  ) => {
    // Each block owns a new draft generation; prior retained/consumed state must not
    // suppress settlement or cleanup for the next provider-visible event.
    draftController.beginDraftGeneration();
    draftController.advanceDraftBlockBoundary(boundary);
    draftStream?.reset();
    draftController.resetReplyToIdForNextBlock();
    draftController.updateDraftFromLatestFullText();
  };

  return {
    preparePayload: async (payload: ReplyPayload, info: MatrixReplyDispatchInfo) => {
      if (!isDurableFinal(payload, info)) {
        return await prepareMatrixReplyPayload(payload);
      }
      const prepared = await prepareMatrixReplyPayload(payload);
      const text = resolveVisibleMatrixReplyText(prepared.text);
      if (
        payload.isReasoning ||
        (!text?.trim() && !resolveSendableOutboundReplyParts(prepared).hasMedia)
      ) {
        return null;
      }
      const explicitReply = prepared.replyToTag || prepared.replyToCurrent;
      const source = readNativeFinalReplySource(payload);
      return {
        ...prepared,
        text,
        ...(threadTarget && !explicitReply ? { replyToId: undefined } : {}),
        channelData: {
          ...prepared.channelData,
          matrix: {
            ...(threadTarget ? { fallbackReplyToId: prepared.replyToId ?? threadTarget } : {}),
            extraContent: {
              ...resolveMatrixExtraContent(prepared),
              ...letMeKnowAnswerContent,
              ...(source
                ? {
                    [MATRIX_REPLY_TO_TRIGGER_CONTENT_KEY]: {
                      version: 1,
                      triggerEventId: source.sourceMessageId,
                      deliveryId: source.deliveryId,
                    },
                  }
                : {}),
              [MATRIX_STREAM_PHASE_CONTENT_KEY]: "answer",
            },
          },
        },
      };
    },
    durable: (payload: ReplyPayload, info: MatrixReplyDispatchInfo) => {
      if (!isDurableFinal(payload, info)) {
        return false as const;
      }
      previewLifecycle.beginFinalDelivery();
      const explicit = payload.replyToTag || payload.replyToCurrent;
      const ambient =
        !threadTarget && replyToMode !== "off" && (replyToMode === "all" || !hasReplied);
      const replyToId = explicit
        ? (payload.replyToId ?? null)
        : ambient
          ? (payload.replyToId ?? replyToEventId ?? null)
          : null;
      return {
        to: `room:${roomId}`,
        threadId: threadTarget,
        replyToId,
        noDirectFallback: true as const,
        mediaAccess: resolveOutboundMediaAccessForConfig(cfg),
        requiredCapabilities: deriveDurableFinalDeliveryRequirements({
          payload,
          replyToId,
          threadId: threadTarget,
          payloadTransport: true,
          afterCommit: true,
          reconcileUnknownSend: true,
        }),
      };
    },
    onDelivered: async (
      payload: ReplyPayload,
      info: MatrixReplyDispatchInfo,
      result: Partial<MatrixReplyDeliveryResult> | void,
    ) => {
      // Projected finals already required a fresh, immutable event instead of a
      // preview edit. Observe queue custody through the same preview lifecycle.
      if (!isDurableFinal(payload, info)) return;
      if (result?.visibleReplySent) {
        await previewLifecycle.observeDelivery(
          { ...result, visibleReplySent: true },
          { isError: payload.isError },
        );
        if (result.replyToId) hasReplied = true;
      } else {
        previewLifecycle.observeSuppression();
      }
    },
    turnDispatcherOptions: {
      ...prefixOptions,
      humanDelay,
      onReplyStart: typingCallbacks.onReplyStart,
      onIdle: typingCallbacks.onIdle,
    },
    deliverReply: async (payload: ReplyPayload, info: MatrixReplyDispatchInfo) => {
      const publication = resolveMatrixReplyPublication(payload, accountId, roomId, threadTarget);
      // Tool progress and streamed blocks are working frames, not the answer.
      const answerContent = info.kind === "final" ? letMeKnowAnswerContent : undefined;
      const createDraftReceipt = (id: string): MessageReceipt =>
        createPreviewMessageReceipt({
          id,
          ...(threadTarget ? { threadId: threadTarget } : {}),
          ...(draftController.currentReplyToId()
            ? { replyToId: draftController.currentReplyToId() }
            : {}),
        });
      const createDraftDeliveryResult = (
        id: string,
        content: string,
      ): MatrixReplyDeliveryResult => {
        const receipt = createDraftReceipt(id);
        return {
          messageIds: receipt.platformMessageIds,
          receipt,
          visibleReplySent: true,
          content,
        };
      };
      const settlesPreview =
        Boolean(draftStream) && info.kind !== "tool" && !payload.isCompactionNotice;
      const ttsSupplement = getReplyPayloadTtsSupplement(payload);
      const fallbackPayload =
        settlesPreview &&
        ttsSupplement &&
        ttsSupplement.visibleTextAlreadyDelivered !== true &&
        !payload.text?.trim()
          ? { ...payload, text: ttsSupplement.spokenText }
          : payload;
      const { hasMedia } = resolveSendableOutboundReplyParts(payload);
      const payloadText = payload.text ?? ttsSupplement?.spokenText;
      // Capture before transport can yield to a newer assistant message.
      const blockBoundary =
        info.kind === "block" && !payload.isCompactionNotice
          ? draftController.captureDraftBlockBoundary(payloadText, info)
          : undefined;
      const payloadReplyMismatch =
        ((!threadTarget && replyToMode !== "off") ||
          payload.replyToTag ||
          payload.replyToCurrent) &&
        normalizeOptionalString(payload.replyToId) !== draftController.currentReplyToId();
      let retainedDraftDelivery: MatrixReplyDeliveryResult | undefined;
      let deliveryResult: MatrixReplyDeliveryResult | undefined;
      try {
        const result = await previewLifecycle.deliver<{ text: string }>({
          // Matrix block events are durable finals of their own draft generation.
          kind: payload.isCompactionNotice ? "tool" : info.kind === "block" ? "final" : info.kind,
          payload,
          isError: payload.isError,
          adapter: draftStream
            ? {
                buildFinalEdit: () =>
                  payloadText?.trim() &&
                  !payload.isError &&
                  !payloadReplyMismatch &&
                  !publication &&
                  !draftStream.mustDeliverFinalNormally() &&
                  !(hasMedia && !ttsSupplement && progressDraftStreaming)
                    ? { text: payloadText }
                    : undefined,
                editFinal: async (draftEventId, edit) => {
                  // A flush can discover a single-event limit, and mentions require a
                  // fresh event because draft mentions are deliberately inert.
                  if (
                    Boolean(publication) ||
                    draftStream.mustDeliverFinalNormally() ||
                    (await matrixTextWouldActivateMentions(client, edit.text))
                  ) {
                    return { visibleReplySent: false };
                  }
                  const { editMessageMatrix, prepareMatrixSingleText } =
                    await loadMatrixSendModule();
                  const presentationContent = hasMedia
                    ? undefined
                    : resolveMatrixExtraContent(payload);
                  const extraContent = {
                    ...(quietDraftStreaming
                      ? { [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true }
                      : {}),
                    ...presentationContent,
                    ...answerContent,
                  };
                  if (
                    !quietDraftStreaming &&
                    !presentationContent &&
                    !answerContent &&
                    draftStream.matchesPreparedText(edit.text)
                  ) {
                    if (!(await draftStream.finalizeLive())) {
                      return { visibleReplySent: false };
                    }
                  } else {
                    await editMessageMatrix(roomId, draftEventId, edit.text, {
                      client,
                      cfg,
                      threadId: threadTarget,
                      accountId,
                      ...(Object.keys(extraContent).length > 0 ? { extraContent } : {}),
                      streamPhase: "answer",
                    });
                  }
                  return createDraftDeliveryResult(
                    draftEventId,
                    prepareMatrixSingleText(edit.text, {
                      cfg,
                      accountId,
                    }).convertedText,
                  );
                },
                createPreviewReceipt: createDraftReceipt,
                buildSupplementalPayload: () =>
                  hasMedia
                    ? ttsSupplement
                      ? buildTtsSupplementMediaPayload(payload)
                      : { ...payload, text: undefined }
                    : undefined,
                deliverSupplemental: (supplemental) => deliverPayload(supplemental),
                logPreviewEditFailure: (err) => {
                  logVerboseMessage(`matrix: preview final edit failed: ${String(err)}`);
                },
              }
            : undefined,
          deliverNormally: async (normalPayload) => {
            if (
              settlesPreview &&
              !previewLifecycle.previewFinalized &&
              (hasMedia ||
                payloadText?.trim() ||
                payload.isError ||
                payloadReplyMismatch ||
                Boolean(publication) ||
                draftStream?.mustDeliverFinalNormally())
            ) {
              const id = draftStream?.eventId();
              const content = draftStream?.content();
              if (id && content) {
                retainedDraftDelivery = createDraftDeliveryResult(id, content);
              }
            }
            return await deliverPayload(
              normalPayload === payload ? fallbackPayload : normalPayload,
              answerContent,
            );
          },
        });
        deliveryResult = result.deliveryResult;
      } catch (error: unknown) {
        if (retainedDraftDelivery) {
          previewLifecycle.retainPreview();
        }
        if (blockBoundary) {
          // A retained cumulative preview already shows its suffix. Do not replay it.
          beginNextBlockDraft(
            retainedDraftDelivery
              ? {
                  ...blockBoundary,
                  messageGeneration: blockBoundary.previewMessageGeneration,
                  endOffset:
                    blockBoundary.messageGeneration === blockBoundary.previewMessageGeneration
                      ? Math.max(blockBoundary.endOffset, blockBoundary.previewEndOffset)
                      : blockBoundary.previewEndOffset,
                }
              : blockBoundary,
          );
        }
        throw toMatrixPartialDeliveryError(
          error,
          retainedDraftDelivery ? [retainedDraftDelivery] : [],
        );
      }
      if (retainedDraftDelivery && !deliveryResult?.visibleReplySent) {
        previewLifecycle.retainPreview();
      }
      const retainedDraft = retainedDraftDelivery?.messageIds?.includes(
        draftStream?.eventId() ?? "",
      )
        ? retainedDraftDelivery
        : undefined;
      const mergedDelivery = mergeMatrixReplyDeliveryResults(
        [retainedDraft, deliveryResult].filter(
          (result): result is MatrixReplyDeliveryResult => result !== undefined,
        ),
      );
      if (blockBoundary) {
        beginNextBlockDraft(blockBoundary);
        await typingCallbacks.onReplyStart();
      }
      if (info.kind === "block" || info.kind === "final") {
        await forwardBoundSourceReply(payload, mergedDelivery);
      }
      return mergedDelivery;
    },
    onReplyError: (err: unknown, info: { kind: "tool" | "block" | "final" }) => {
      if (info.kind === "final") {
        if (durableProjection && !sourceReply && draftStream?.eventId()) {
          previewLifecycle.retainPreview();
        }
        previewLifecycle.observeFailure();
      } else {
        nonFinalReplyDeliveryFailed = true;
      }
      runtime.error?.(`matrix ${info.kind} reply failed: ${String(err)}`);
    },
    nonFinalReplyDeliveryFailed: () => nonFinalReplyDeliveryFailed,
  };
}
