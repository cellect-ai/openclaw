// Delivers one final WebChat answer through a server-authorized channel route.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { isReplyPayloadStatusNotice, type ReplyPayload } from "../auto-reply/reply-payload.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { deliverInboundReplyWithMessageSendContextCore } from "../channels/turn/durable-delivery.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureDeliveryQueueStateContext,
  type DeliveryQueueStateContext,
} from "../infra/delivery-queue-state-context.js";
import { isOutboundDeliveryError } from "../infra/outbound/deliver-types.js";
import { loadCompletedDeliveryReceipt } from "../infra/outbound/delivery-queue-storage.js";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import { scheduleSessionDelivery } from "../infra/session-delivery-queue-runtime.js";
import {
  completeSessionDelivery,
  enqueueClaimedSessionDelivery,
  loadPendingSessionDelivery,
  resolveSessionDeliveryId,
} from "../infra/session-delivery-queue-storage.js";
import type { QueuedSessionDelivery } from "../infra/session-delivery-queue.records.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  buildTranscriptReplyTextFromInputs,
  readChatSendReplyPayload,
  selectChatSendFinalReplyInputs,
  type DeliveredChatSendReply,
} from "./server-methods/chat-send-command-replies.js";
import {
  resolveWebchatCompletionDeliveryReason,
  WEBCHAT_COMPLETION_DELIVERY_UNREAD_GRACE_MS,
  type WebchatCompletionDeliveryState,
} from "./webchat-completion-delivery.js";

type CompletionReply = { payload: ReplyPayload; kind: "block" | "final" };

export type WebchatCompletionFallbackParams = {
  cfg: OpenClawConfig;
  state: WebchatCompletionDeliveryState | undefined;
  startedAtMs: number;
  runId: string;
  sessionId: string;
  sessionKey?: string;
  agentId: string;
  ctx: MsgContext;
  replies: CompletionReply[];
  fallbackError?: string;
  nowMs?: number;
  log: { warn: (message: string) => void };
  /** Stable outer-queue identity used to deduplicate the provider send after restart. */
  deliveryIntentId?: string;
  continuationMarker?: boolean;
  queueContext?: DeliveryQueueStateContext;
  assertCurrent?: () => void;
};

/** The native dispatcher already owns silence normalization; retain its final selection and media rules. */
export function resolveWebchatCompletionReplies(params: {
  deliveredReplies: readonly DeliveredChatSendReply[];
  foldCommandBlocks: boolean;
  suppressReplies: boolean;
}): CompletionReply[] {
  const inputs = selectChatSendFinalReplyInputs(params).filter((input) => {
    const payload = readChatSendReplyPayload(input);
    return !isReplyPayloadStatusNotice(payload) && payload.isReasoning !== true;
  });
  const text = buildTranscriptReplyTextFromInputs(inputs);
  return text.trim() ? [{ kind: "final", payload: { text } }] : [];
}

const COMPLETION_OUTBOUND_INTENT_PREFIX = "webchat-completion-outbound:v1:";
const completionOutboundRetention = {
  idPrefix: COMPLETION_OUTBOUND_INTENT_PREFIX,
  maxAgeMs: 24 * 60 * 60_000,
  maxEntries: 2_000,
} as const;

type PendingWebchatCompletion = {
  runId: string;
  queueContext: OpenClawStateWorkerContext;
  state: WebchatCompletionDeliveryState;
  sessionKey: string;
  ownerConnId?: string;
  ownerDeviceId?: string;
};

// Active chat registrations are removed immediately after the final UI broadcast.
// Keep only the bounded delivery closure here so a reconnecting device can cancel its chase.
const pendingWebchatCompletions = new Map<string, PendingWebchatCompletion>();

function pendingCompletionKey(
  context: OpenClawStateWorkerContext,
  sessionKey: string,
  runId: string,
): string {
  const identity = context.admission.identity;
  return JSON.stringify([identity.key, identity.birthtime, sessionKey, runId]);
}

export type MarkWebchatCompletionSeenResult = "seen" | "not-found" | "unauthorized";

function completionDeliveryIdempotencyKey(sessionKey: string, runId: string): string {
  return `webchat-completion:${sessionKey}:${runId}`;
}

export async function markWebchatCompletionSeen(params: {
  runId?: string;
  sessionKey: string;
  requesterConnId?: string;
  requesterDeviceId?: string;
  nowMs?: number;
  assertCurrent?: () => void;
}): Promise<MarkWebchatCompletionSeenResult> {
  params.assertCurrent?.();
  const queueContext = captureOpenClawStateWorkerContext();
  const exactKey =
    params.runId && pendingCompletionKey(queueContext, params.sessionKey, params.runId);
  const candidates = exactKey
    ? [[exactKey, pendingWebchatCompletions.get(exactKey)] as const]
    : [...pendingWebchatCompletions.entries()].filter(
        ([key, pending]) =>
          key === pendingCompletionKey(queueContext, params.sessionKey, pending.runId),
      );
  let marked = false;
  for (const [key, pending] of candidates) {
    if (!pending) {
      continue;
    }
    pending.queueContext.admission.assertCurrent();
    const sameOwner = pending.ownerDeviceId
      ? params.requesterDeviceId === pending.ownerDeviceId
      : Boolean(pending.ownerConnId && params.requesterConnId === pending.ownerConnId);
    if (pending.sessionKey !== params.sessionKey || !sameOwner) {
      if (params.runId) {
        return "unauthorized";
      }
      continue;
    }
    params.assertCurrent?.();
    await completeSessionDelivery(
      resolveSessionDeliveryId(completionDeliveryIdempotencyKey(params.sessionKey, pending.runId)),
      queueContext,
      params.assertCurrent,
    );
    pending.state.seenAtMs = params.nowMs ?? Date.now();
    pendingWebchatCompletions.delete(key);
    marked = true;
  }
  if (!marked && params.runId) {
    const deliveryId = resolveSessionDeliveryId(
      completionDeliveryIdempotencyKey(params.sessionKey, params.runId),
    );
    const persisted = await loadPendingSessionDelivery(deliveryId, queueContext);
    params.assertCurrent?.();
    if (persisted?.kind === "completionFallback") {
      const sameOwner = persisted.ownerDeviceId
        ? params.requesterDeviceId === persisted.ownerDeviceId
        : Boolean(persisted.ownerConnId && params.requesterConnId === persisted.ownerConnId);
      if (persisted.sessionKey !== params.sessionKey || !sameOwner) {
        return "unauthorized";
      }
      params.assertCurrent?.();
      await completeSessionDelivery(deliveryId, queueContext, params.assertCurrent);
      marked = true;
    }
  }
  return marked ? "seen" : "not-found";
}

export async function scheduleWebchatCompletionFallback(
  params: WebchatCompletionFallbackParams & {
    sessionKey: string;
    ownerConnId?: string;
    ownerDeviceId?: string;
    unreadGraceMs?: number;
  },
): Promise<"scheduled" | "skipped"> {
  const state = params.state;
  if (!state || state.seenAtMs !== undefined || state.attemptedAtMs !== undefined) {
    return "skipped";
  }
  const queueContext = captureOpenClawStateWorkerContext();
  const pendingKey = pendingCompletionKey(queueContext, params.sessionKey, params.runId);
  if (pendingWebchatCompletions.has(pendingKey)) return "skipped";
  state.completedAtMs = params.nowMs ?? Date.now();
  const answer = resolveCompletionAnswer(params);
  if (!answer) {
    params.log.warn(
      `webchat completion delivery skipped without visible reply run=${params.runId}`,
    );
    return "skipped";
  }
  const unreadGraceMs = params.unreadGraceMs ?? WEBCHAT_COMPLETION_DELIVERY_UNREAD_GRACE_MS;
  const idempotencyKey = completionDeliveryIdempotencyKey(params.sessionKey, params.runId);
  const queued = await enqueueClaimedSessionDelivery(
    {
      kind: "completionFallback",
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      runId: params.runId,
      agentId: params.agentId,
      route: state.route,
      text: answer,
      ...(params.fallbackError ? { isError: true as const } : {}),
      ...(params.ownerConnId ? { ownerConnId: params.ownerConnId } : {}),
      ...(params.ownerDeviceId ? { ownerDeviceId: params.ownerDeviceId } : {}),
      idempotencyKey,
    },
    unreadGraceMs,
    queueContext,
  );
  if (queued.status === "failed" || queued.status === "completed") {
    params.log.warn(`webchat completion delivery could not be scheduled run=${params.runId}`);
    return "skipped";
  }
  pendingWebchatCompletions.set(pendingKey, {
    runId: params.runId,
    queueContext,
    state,
    sessionKey: params.sessionKey,
    ownerConnId: params.ownerConnId,
    ownerDeviceId: params.ownerDeviceId,
  });
  await scheduleSessionDelivery(queued.id, queueContext);
  return "scheduled";
}

function resolveCompletionAnswer(params: WebchatCompletionFallbackParams): string {
  const finalEntries = params.replies.filter((item) => item.kind === "final");
  const substantiveEntries = finalEntries.filter(
    (item) => !isReplyPayloadStatusNotice(item.payload),
  );
  const candidates = substantiveEntries.filter((item) => item.payload.isReasoning !== true);
  const replyText = uniqueStrings(
    candidates
      .map((item) => item.payload.text?.trim())
      .filter((text): text is string => typeof text === "string" && text.length > 0),
  ).join("\n\n");
  return params.fallbackError?.trim() || replyText;
}

function isPrivateSlackDestination(route: WebchatCompletionDeliveryState["route"]): boolean {
  // Fi's signed route issuer uses Slack's canonical `user:<member-id>` target for a DM.
  // Unknown/bare/channel targets are notification-only: failing closed here prevents a
  // private WebChat transcript from becoming the current session of a shared channel.
  return route.channel === "slack" && /^user:[^:]+$/i.test(route.to.trim());
}

async function bindCompletionConversation(
  params: WebchatCompletionFallbackParams,
  messageId: string | undefined,
): Promise<"bound" | "notification-only" | "failed"> {
  const targetSessionKey = params.sessionKey ?? params.ctx.SessionKey;
  if (!targetSessionKey) {
    params.log.warn(
      `webchat completion continuation binding failed run=${params.runId}: missing session key`,
    );
    return "failed";
  }
  if (!isPrivateSlackDestination(params.state!.route)) {
    params.log.warn(
      `webchat completion continuation disabled for non-private destination run=${params.runId}`,
    );
    return "notification-only";
  }
  const normalizedMessageId = messageId?.trim();
  if (!normalizedMessageId) {
    params.log.warn(
      `webchat completion continuation binding failed run=${params.runId}: missing provider message id`,
    );
    return "notification-only";
  }
  try {
    const route = params.state!.route;
    await getSessionBindingService().bind({
      assertCurrent: () => {
        params.queueContext?.workerContext.admission.assertCurrent();
        params.assertCurrent?.();
      },
      targetSessionKey,
      targetKind: "session",
      placement: "current",
      conversation: {
        channel: route.channel,
        accountId: route.accountId ?? "default",
        conversationId: normalizedMessageId,
        parentConversationId: route.to,
      },
      metadata: {
        agentId: params.agentId,
        boundBy: "webchat-completion-delivery",
      },
    });
    return "bound";
  } catch (error) {
    params.log.warn(
      `webchat completion continuation binding failed run=${params.runId}: ${String(error)}`,
    );
    return "failed";
  }
}

export async function deliverWebchatCompletionFallback(
  params: WebchatCompletionFallbackParams,
): Promise<"skipped" | "handled" | "failed"> {
  params.assertCurrent?.();
  const nowMs = params.nowMs ?? Date.now();
  const reason = resolveWebchatCompletionDeliveryReason({
    state: params.state,
    startedAtMs: params.startedAtMs,
    nowMs,
  });
  const state = params.state;
  if (!state || !reason) {
    return "skipped";
  }
  state.attemptedAtMs = nowMs;
  const answer = resolveCompletionAnswer(params);
  if (!answer) {
    params.log.warn(
      `webchat completion delivery skipped without visible reply run=${params.runId}`,
    );
    return "skipped";
  }
  const queueContext = params.queueContext ?? captureDeliveryQueueStateContext();
  queueContext.workerContext.admission.assertCurrent();
  const reasonText = "Sent to Slack because the Fi reply was not viewed within one minute";
  const payload: ReplyPayload = {
    text: params.continuationMarker
      ? `*Continue in Slack*\n\n${answer}\n\n_Reply in this thread to continue the same conversation._`
      : `*Fi chat reply*\n\n${answer}\n\n_${reasonText} · Session ${params.sessionId}_`,
    ...(params.fallbackError ? { isError: true } : {}),
  };
  const route = state.route;
  const result = await deliverInboundReplyWithMessageSendContextCore(
    {
      cfg: params.cfg,
      assertDirectAdapterHandoff: () => {
        queueContext.workerContext.admission.assertCurrent();
        params.assertCurrent?.();
      },
      channel: route.channel,
      accountId: route.accountId,
      agentId: params.agentId,
      ctxPayload: finalizeInboundContext({
        ...params.ctx,
        OriginatingChannel: route.channel,
        OriginatingTo: route.to,
        AccountId: route.accountId,
        MessageThreadId: undefined,
        ReplyToId: undefined,
        ReplyToIdFull: undefined,
      }),
      payload,
      info: { kind: "final" },
      to: route.to,
      threadId: null,
      replyToId: null,
      requiredCapabilities: {
        text: true,
        messageSendingHooks: true,
        reconcileUnknownSend: true,
      },
      ...(params.deliveryIntentId
        ? {
            deliveryIntentId: `${COMPLETION_OUTBOUND_INTENT_PREFIX}${params.deliveryIntentId}`,
            reusePendingDeliveryIntent: true,
            completionRetention: completionOutboundRetention,
          }
        : {}),
    },
    queueContext,
  ).catch(
    (
      error: unknown,
    ): {
      status: "failed";
      error: unknown;
      sentBeforeError?: true;
    } => ({
      status: "failed",
      error,
      ...(isOutboundDeliveryError(error) && error.sentBeforeError ? { sentBeforeError: true } : {}),
    }),
  );
  if (result.status === "failed") {
    if (result.sentBeforeError) {
      params.log.warn(
        `webchat completion delivery partially completed without continuation binding run=${params.runId}: ${String(result.error)}`,
      );
      return "handled";
    }
    params.log.warn(
      `webchat completion delivery failed run=${params.runId}: ${String(result.error)}`,
    );
    return "failed";
  }
  if (result.status === "unsupported") {
    params.log.warn(
      `webchat completion delivery unsupported run=${params.runId}: ${result.reason}`,
    );
    return "failed";
  }
  if (result.status === "handled_visible") {
    // Delivery is already recipient-visible, so binding failure is observable but
    // must not retry and duplicate the final answer.
    let messageId = result.delivery.messageIds?.[0];
    if (!messageId && params.deliveryIntentId) {
      messageId = (
        await loadCompletedDeliveryReceipt(
          `${COMPLETION_OUTBOUND_INTENT_PREFIX}${params.deliveryIntentId}`,
          undefined,
          queueContext,
        )
      )?.platformMessageId;
    }
    params.assertCurrent?.();
    queueContext.workerContext.admission.assertCurrent();
    if ((await bindCompletionConversation({ ...params, queueContext }, messageId)) === "failed") {
      // Only a stable durable intent can retry binding without sending the answer again.
      return params.deliveryIntentId ? "failed" : "handled";
    }
  }
  return "handled";
}

export async function deliverQueuedWebchatCompletionFallback(params: {
  cfg: OpenClawConfig;
  entry: Extract<QueuedSessionDelivery, { kind: "completionFallback" }>;
  queueContext: OpenClawStateWorkerContext;
  log: { warn: (message: string) => void };
}): Promise<void> {
  const { entry } = params;
  params.queueContext.admission.assertCurrent();
  const queueContext: DeliveryQueueStateContext = {
    workerContext: params.queueContext,
    stateDir: params.queueContext.environment.OPENCLAW_STATE_DIR,
    ...(params.queueContext.environment.OPENCLAW_SUPERVISOR_MODE === "external"
      ? { supervisorMode: "external" }
      : {}),
  };
  pendingWebchatCompletions.delete(
    pendingCompletionKey(params.queueContext, entry.sessionKey, entry.runId),
  );
  const result = await deliverWebchatCompletionFallback({
    cfg: params.cfg,
    state: { route: entry.route, armedAtMs: entry.enqueuedAt },
    startedAtMs: entry.enqueuedAt,
    sessionId: entry.sessionId,
    sessionKey: entry.sessionKey,
    agentId: entry.agentId,
    runId: entry.runId,
    ctx: { SessionKey: entry.sessionKey },
    replies: [{ kind: "final", payload: { text: entry.text } }],
    ...(entry.isError ? { fallbackError: entry.text } : {}),
    deliveryIntentId: entry.id,
    queueContext,
    assertCurrent: () => params.queueContext.admission.assertCurrent(),
    log: params.log,
  });
  if (result !== "handled") {
    throw new Error(`webchat completion delivery ${result}`);
  }
}
