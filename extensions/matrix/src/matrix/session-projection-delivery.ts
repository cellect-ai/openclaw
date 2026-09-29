import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { isSilentReplyPayloadText } from "openclaw/plugin-sdk/reply-chunking";
import { resolveReplyPublication } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CoreConfig } from "../types.js";
import {
  createMatrixSourcePublication,
  resolveMatrixReplyPublication,
  type MatrixPublication,
} from "./projection-publication.js";
import { isProjectionBinding } from "./projection-target.js";
import { sendMessageMatrix } from "./send.js";
import { projectionText } from "./session-projection-snapshot.js";

// The initial source message can be supplied by an authorized product bridge
// while its ordinary message_received hook is still in flight. Keep the two
// paths from emitting the same Matrix event in that narrow race. Matrix's
// delivery queue remains the durable retry/idempotency layer across restarts.
const projectedDeliveryKeys = new Set<string>();
const MAX_PROJECTED_DELIVERY_KEYS = 10_000;

export type ProjectionRole = "user" | "assistant";

type ProjectionBinding = {
  bindingId: string;
  conversation: {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  };
  metadata?: Record<string, unknown>;
};

type MessageHookContext = {
  channelId: string;
  sessionKey?: string;
  runId?: string;
  messageId?: string;
};

type MessageReceivedEvent = {
  content: string;
  sessionKey?: string;
  runId?: string;
  messageId?: string;
  timestamp?: number;
  senderId?: string;
  from?: string;
};

type ReplyPayloadSendingEvent = {
  kind: string;
  channel?: string;
  sessionKey?: string;
  runId?: string;
  publicationId?: string;
  publishedAtMs?: number;
  payload: {
    text?: string;
    isReasoning?: boolean;
    isCommentary?: boolean;
    isCompactionNotice?: boolean;
    isFallbackNotice?: boolean;
    isStatusNotice?: boolean;
  };
};

function clean(value: unknown): string {
  return normalizeOptionalString(value) ?? "";
}

function normalizeChannel(value: unknown): string {
  return clean(value).toLowerCase();
}

function resolveDeliveryIdentity(params: {
  role: ProjectionRole;
  messageId?: string;
  runId?: string;
  publication?: MatrixPublication;
}): string | null {
  const sourceId = params.publication
    ? `${params.publication.origin.messageId}:${params.publication.logicalPartId}:${params.publication.publicationRevision}`
    : clean(params.messageId) || clean(params.runId);
  if (!sourceId) {
    return null;
  }
  return `${params.role}:${sourceId}`;
}

async function projectToMatrix(params: {
  cfg: CoreConfig;
  sessionKey: string;
  sourceChannel: string;
  role: ProjectionRole;
  text: string;
  messageId?: string;
  runId?: string;
  bindings?: ProjectionBinding[];
  senderId?: string;
  agentId?: string;
  publishedAtMs?: number;
  hostEvent?: unknown;
}): Promise<void> {
  const sourceChannel = normalizeChannel(params.sourceChannel);
  if (!sourceChannel || sourceChannel === "matrix") {
    return;
  }
  const sessionKey = clean(params.sessionKey);
  const text = params.text.trim();
  if (!sessionKey || !text) {
    return;
  }

  const bindingService = getSessionBindingService();
  const bindings =
    params.bindings ??
    bindingService
      .listBySession(sessionKey)
      .filter(
        (binding) =>
          isProjectionBinding(binding) &&
          binding.metadata?.boundBy !== "session-projection-read-only",
      );
  await Promise.all(
    bindings.map(async (binding) => {
      if (
        binding.metadata?.boundBy === "session-projection-slack-direct" ||
        binding.metadata?.sourceReplyAuthorization
      ) {
        return;
      }
      const roomId = binding.conversation.parentConversationId;
      const threadId = binding.conversation.conversationId;
      if (!roomId || !threadId) {
        return;
      }
      const sourceMessageId = clean(params.messageId) || clean(params.runId);
      const sourceActorId =
        clean(params.senderId) ||
        (sourceChannel === "webchat" && params.role === "user"
          ? clean(binding.metadata?.sourceActorId)
          : "");
      const originalTime =
        params.publishedAtMs ??
        (sourceChannel === "slack" && /^\d+\.\d+$/.test(params.messageId ?? "")
          ? Math.floor(Number(params.messageId) * 1000)
          : sourceMessageId
            ? Date.now()
            : undefined);
      const publication = params.hostEvent
        ? resolveMatrixReplyPublication(
            params.hostEvent,
            binding.conversation.accountId,
            roomId,
            threadId,
          )
        : originalTime !== undefined &&
            sourceMessageId &&
            sourceActorId &&
            typeof binding.metadata?.environment === "string" &&
            typeof binding.metadata?.projectedConversationId === "string"
          ? createMatrixSourcePublication({
              bindingId: binding.bindingId,
              roomId,
              threadId,
              provider: sourceChannel,
              accountId: binding.conversation.accountId,
              messageId: sourceMessageId,
              actorId: sourceActorId,
              publishedAtMs: originalTime,
              role: params.role,
            })
          : undefined;
      if (params.hostEvent && !publication) {
        return;
      }
      const identity = resolveDeliveryIdentity({ ...params, publication });
      if (!identity) {
        return;
      }
      const deliveryScope =
        binding.metadata?.boundBy === "session-projection-read-only" ? roomId : binding.bindingId;
      const projectionKey = `${deliveryScope}:${identity}`;
      if (projectedDeliveryKeys.has(projectionKey)) {
        return;
      }
      if (projectedDeliveryKeys.size >= MAX_PROJECTED_DELIVERY_KEYS) {
        projectedDeliveryKeys.clear();
      }
      projectedDeliveryKeys.add(projectionKey);
      try {
        await sendMessageMatrix(
          `room:${roomId}`,
          projectionText({
            channel: sourceChannel,
            role: params.role,
            text,
            // Native chat's gateway client id identifies transport software,
            // not the human author. Keep it in trusted origin metadata while
            // presenting the portable user role on Matrix.
            senderId:
              sourceChannel === "webchat" && params.role === "user" ? undefined : params.senderId,
            agentId: params.agentId,
          }),
          {
            cfg: params.cfg,
            accountId: binding.conversation.accountId,
            threadId,
            deliveryQueueId: `matrix-session-projection:${deliveryScope}:${identity}`,
            // Each immutable logical publication is one durable payload part;
            // sendMessageMatrix owns any wire-event splitting within that part.
            deliveryPartIndex: 0,
            deliveryPartCount: 1,
            publication,
          },
        );
        bindingService.touch(binding.bindingId);
      } catch (error) {
        // A transient Matrix failure must remain retryable on a later source
        // event; the reservation only protects concurrent local emitters.
        projectedDeliveryKeys.delete(projectionKey);
        throw error;
      }
    }),
  );
}

export async function projectInitialMessage(params: {
  cfg: CoreConfig;
  targetSessionKey: string;
  initialMessage?: {
    sourceChannel?: string;
    content?: string;
    messageId?: string;
    runId?: string;
    role?: ProjectionRole;
    senderId?: string;
    agentId?: string;
  };
  binding?: ProjectionBinding;
}): Promise<void> {
  const initial = params.initialMessage;
  if (!initial) {
    return;
  }
  await projectToMatrix({
    cfg: params.cfg,
    sessionKey: params.targetSessionKey,
    sourceChannel: clean(initial.sourceChannel),
    role: initial.role ?? "user",
    senderId: initial.senderId,
    agentId: initial.agentId,
    text: clean(initial.content),
    messageId: clean(initial.messageId) || undefined,
    runId: clean(initial.runId) || undefined,
    ...(params.binding ? { bindings: [params.binding] } : {}),
  });
}

export async function handleMatrixSessionProjectionMessageReceived(
  event: MessageReceivedEvent,
  context: MessageHookContext,
  cfg: CoreConfig,
): Promise<void> {
  await projectToMatrix({
    cfg,
    sessionKey: event.sessionKey ?? context.sessionKey ?? "",
    sourceChannel: context.channelId,
    role: "user",
    text: event.content,
    messageId: event.messageId ?? context.messageId,
    runId: event.runId ?? context.runId,
    senderId: event.senderId || event.from,
    publishedAtMs: event.timestamp,
  });
}

function isVisibleAnswerReply(event: ReplyPayloadSendingEvent): boolean {
  const text = clean(event.payload.text);
  return (
    // Completed answer chunks can own delivery in block-streaming mode;
    // the subsequent final payload may be empty or already deduplicated.
    (event.kind === "block" || event.kind === "final") &&
    Boolean(text) &&
    event.payload.isReasoning !== true &&
    event.payload.isCommentary !== true &&
    event.payload.isCompactionNotice !== true &&
    event.payload.isFallbackNotice !== true &&
    event.payload.isStatusNotice !== true &&
    !isSilentReplyPayloadText(text)
  );
}

export async function handleMatrixSessionProjectionReplyPayloadSending(
  event: ReplyPayloadSendingEvent,
  _context: MessageHookContext,
  cfg: CoreConfig,
): Promise<void> {
  if (!isVisibleAnswerReply(event)) {
    return;
  }
  const publication = resolveReplyPublication(event);
  if (!publication) {
    return;
  }
  await projectToMatrix({
    cfg,
    sessionKey: publication.sessionKey ?? "",
    sourceChannel: publication.channel ?? "",
    role: "assistant",
    text: clean(event.payload.text),
    runId: publication.runId,
    hostEvent: event,
  });
}
