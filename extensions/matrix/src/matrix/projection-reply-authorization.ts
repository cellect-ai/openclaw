import { createHash } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { ProjectionError } from "./projection-error.js";
import type { ProjectionExternalSource } from "./projection-source.js";
import type { MatrixClient } from "./sdk.js";
import {
  listBindingsForAccount,
  type MatrixThreadBindingRecord,
} from "./thread-bindings-shared.js";

// Retain the legacy deny marker on disk: an older gateway must reject these
// sessions after rollback rather than silently bypass their new source guard.
export const SOURCE_AUTHORIZED_PROJECTION = "session-projection-read-only";
export type SourceReplyAuthorizer = {
  protocol: string;
  resolveSource: (params: {
    targetSessionKey: string;
    externalSource?: ProjectionExternalSource;
    sourceAccountId?: string;
  }) => Promise<{ externalSource: ProjectionExternalSource; sourceAccountId: string }>;
  authorize: (params: {
    binding: MatrixThreadBindingRecord;
    matrixRoomId: string;
    matrixSenderId: string;
  }) => Promise<"allowed" | "denied" | "unavailable">;
};

export async function resolveProjectionReplyUpgrade(params: {
  channelRuntime: PluginRuntime["channel"];
  targetSessionKey: string;
  externalSource?: ProjectionExternalSource;
  protocol: string;
  readOnly?: boolean;
  existing?: { targetSessionKey: string; metadata?: Record<string, unknown> };
}) {
  const guard = params.channelRuntime.runtimeContexts.get<SourceReplyAuthorizer>({
    channelId: "matrix",
    capability: "source-session-authorization",
  });
  if (!guard || guard.protocol !== params.protocol || params.readOnly) {
    throw new ProjectionError(
      "source_auth_unavailable",
      "Requested source reply authorization is unavailable",
    );
  }
  const existing = params.existing;
  if (existing && existing.targetSessionKey !== params.targetSessionKey) {
    throw new ProjectionError("ownership_changed", "Canonical projection target cannot change");
  }
  if (
    existing?.metadata?.externalSource &&
    JSON.stringify(existing.metadata.externalSource) !== JSON.stringify(params.externalSource)
  ) {
    throw new ProjectionError("source_changed", "Projection external source cannot change");
  }
  const source = await guard.resolveSource({
    targetSessionKey: params.targetSessionKey,
    externalSource: params.externalSource,
    sourceAccountId:
      typeof existing?.metadata?.sourceAccountId === "string"
        ? existing.metadata.sourceAccountId
        : undefined,
  });
  return {
    externalSource: source.externalSource,
    sourceAccountId: source.sourceAccountId,
    sourceReplyAuthorization: guard.protocol,
  };
}

/** One projected room represents one canonical source, including room-level replies. */
export function getSourceAuthorizedProjection(accountId: string, roomId: string) {
  return listBindingsForAccount(accountId)
    .filter(
      (binding) =>
        binding.boundBy === SOURCE_AUTHORIZED_PROJECTION &&
        Boolean(binding.sourceReplyAuthorization) &&
        (binding.parentConversationId === roomId || binding.conversationId === roomId),
    )
    .toSorted((left, right) => right.boundAt - left.boundAt)[0];
}

export async function authorizeProjectionReply(params: {
  core: PluginRuntime;
  accountId: string;
  roomId: string;
  senderId: string;
}): Promise<"allowed" | "denied" | "unavailable"> {
  const binding = getSourceAuthorizedProjection(params.accountId, params.roomId);
  if (!binding) {
    return "allowed";
  }
  const guard = params.core.channel.runtimeContexts?.get<SourceReplyAuthorizer>({
    channelId: "matrix",
    capability: "source-session-authorization",
  });
  if (
    !guard ||
    !binding.sourceReplyAuthorization ||
    guard.protocol !== binding.sourceReplyAuthorization
  ) {
    return "unavailable";
  }
  try {
    return await guard.authorize({
      binding,
      matrixRoomId: params.roomId,
      matrixSenderId: params.senderId,
    });
  } catch {
    return "unavailable";
  }
}

export async function sendProjectionReplyRejection(params: {
  client: Pick<MatrixClient, "sendMessage">;
  roomId: string;
  messageId: string;
  threadRootId?: string;
  reason: "denied" | "unavailable";
}) {
  const body =
    params.reason === "denied"
      ? "This reply was not sent to the agent: you no longer have permission to continue this source conversation. Check your Fi and source-channel access."
      : "This reply was not sent to the agent because access could not be verified right now. Please try again shortly.";
  const transactionId = `source-reply-rejected-${createHash("sha256").update(params.messageId).digest("hex")}`;
  await params.client.sendMessage(
    params.roomId,
    {
      msgtype: "m.notice",
      body,
      "m.relates_to": params.threadRootId
        ? {
            rel_type: "m.thread",
            event_id: params.threadRootId,
            is_falling_back: false,
            "m.in_reply_to": { event_id: params.messageId },
          }
        : { "m.in_reply_to": { event_id: params.messageId } },
    },
    transactionId,
  );
}
