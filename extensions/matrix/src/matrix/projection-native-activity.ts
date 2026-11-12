import type { SessionBindingRecord } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { isMatrixBindingNoticeText } from "./binding-notice.js";
import { MATRIX_PROJECTION_CONTENT_KEY } from "./projection-publication.js";
import {
  parseProjectionExternalSource,
  type getMatrixProjectionStatus,
} from "./projection-source.js";
import {
  object,
  readProjectionThread,
  SOURCE_CONTENT_REVISION_KEY,
  type ProjectionHistory,
} from "./session-projection-plan.js";

export type ProjectionNativeActivityReceipt = {
  eventId: string;
  originServerTs: number;
  bindingId: string;
  sessionKey: string;
  roomId: string;
  threadRootEventId: string;
  accountId: string;
  environment: string;
  conversationId: string;
  sourceAccountId: string;
  externalSource: NonNullable<ReturnType<typeof parseProjectionExternalSource>>;
};

const LEGACY_PROJECTION_KEY = "com.openclaw.session_projection";
const CHAT_TYPES = new Set([
  "m.text",
  "m.emote",
  "m.image",
  "m.file",
  "m.audio",
  "m.video",
  "m.location",
]);

/** History is complete and decrypted; a current source binding supplies the scope, never event JSON. */
export function resolveProjectionNativeActivity(
  history: ProjectionHistory,
  status: Extract<ReturnType<typeof getMatrixProjectionStatus>, { status: "existing" }>,
  binding: SessionBindingRecord | null,
): ProjectionNativeActivityReceipt | undefined {
  const externalSource = parseProjectionExternalSource(status.externalSource);
  const metadata = binding?.metadata;
  if (
    !binding ||
    binding.status !== "active" ||
    binding.bindingId !== status.bindingId ||
    binding.targetSessionKey !== status.targetSessionKey ||
    binding.conversation.channel !== "matrix" ||
    binding.conversation.accountId !== status.accountId ||
    binding.conversation.parentConversationId !== status.roomId ||
    binding.conversation.conversationId !== status.threadRootEventId ||
    !status.environment ||
    metadata?.environment !== status.environment ||
    !status.conversationId ||
    metadata?.projectedConversationId !== status.conversationId ||
    !status.sourceAccountId ||
    metadata?.sourceAccountId !== status.sourceAccountId ||
    !externalSource ||
    externalSource.provider !== "slack" ||
    JSON.stringify(parseProjectionExternalSource(metadata?.externalSource)) !==
      JSON.stringify(externalSource)
  ) {
    return undefined;
  }

  const legacyChunks = new Set(
    readProjectionThread(history).legacyChunks.map((chunk) => chunk.eventId),
  );
  const candidates = history.events.filter((event) => {
    const content = object(event.content);
    const relation = object(content?.["m.relates_to"]);
    if (
      event.type !== "m.room.message" ||
      event.unsigned?.redacted_because ||
      (event.room_id !== undefined && event.room_id !== status.roomId) ||
      !event.event_id ||
      !event.sender ||
      legacyChunks.has(event.event_id) ||
      !Number.isSafeInteger(event.origin_server_ts) ||
      event.origin_server_ts < 0 ||
      !content ||
      !CHAT_TYPES.has(String(content.msgtype)) ||
      typeof content.body !== "string" ||
      !content.body.trim() ||
      relation?.rel_type !== "m.thread" ||
      relation.event_id !== history.threadId ||
      (event.sender === history.self && isMatrixBindingNoticeText(content.body)) ||
      LEGACY_PROJECTION_KEY in content
    ) {
      return false;
    }
    if (!(MATRIX_PROJECTION_CONTENT_KEY in content)) {
      return !(SOURCE_CONTENT_REVISION_KEY in content);
    }
    const publication = object(content[MATRIX_PROJECTION_CONTENT_KEY]);
    const origin = object(publication?.origin);
    // Only complete native publications in this exact binding qualify. Slack
    // copies and unknown/malformed provenance never become native activity.
    return (
      publication?.version === 2 &&
      publication.bindingId === status.bindingId &&
      publication.roomId === status.roomId &&
      publication.environment === status.environment &&
      publication.conversationId === status.conversationId &&
      (publication.role === "user" || publication.role === "assistant") &&
      publication.complete === true &&
      Number.isSafeInteger(publication.partCount) &&
      Number(publication.partCount) > 0 &&
      Number(publication.partCount) <= 256 &&
      publication.partIndex === Number(publication.partCount) - 1 &&
      Number.isSafeInteger(publication.publicationRevision) &&
      Number(publication.publicationRevision) > 0 &&
      typeof publication.logicalPartId === "string" &&
      Boolean(publication.logicalPartId) &&
      typeof origin?.messageId === "string" &&
      Boolean(origin.messageId) &&
      typeof origin.actorId === "string" &&
      Boolean(origin.actorId) &&
      (origin?.provider === "matrix" || origin?.provider === "webchat")
    );
  });
  const latest = candidates.toSorted(
    (left, right) =>
      right.origin_server_ts - left.origin_server_ts || right.event_id.localeCompare(left.event_id),
  )[0];
  if (!latest) {
    return undefined;
  }
  return {
    eventId: latest.event_id,
    originServerTs: latest.origin_server_ts,
    bindingId: binding.bindingId,
    sessionKey: binding.targetSessionKey,
    roomId: status.roomId,
    threadRootEventId: status.threadRootEventId,
    accountId: status.accountId,
    environment: status.environment,
    conversationId: status.conversationId,
    sourceAccountId: status.sourceAccountId,
    externalSource,
  };
}
