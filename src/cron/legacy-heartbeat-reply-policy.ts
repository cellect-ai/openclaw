import {
  getReplyPayloadMetadata,
  markReplyPayloadForSourceSuppressionDelivery,
} from "../auto-reply/reply-payload.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { normalizeChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AutomationResult } from "../infra/agent-run-registry.types.js";
import type { CronStoredJob } from "./types.js";

/** Restricts a migrated producer's final lane; never creates tool or sender authority. */
export function requiresLegacyHeartbeatExplicitReply(params: {
  job: Pick<CronStoredJob, "legacyHeartbeatReplyPolicy">;
  config: OpenClawConfig;
  chatType?: string;
  runtime: string;
}): boolean {
  if (params.job.legacyHeartbeatReplyPolicy !== true) return false;
  const chatType = normalizeChatType(params.chatType);
  // Unknown/mismatched routing cannot prove that the group's stricter setting
  // is inapplicable. This only restricts converted producers, never grants a send.
  if (!chatType && params.config.messages?.groupChat?.visibleReplies === "message_tool") {
    return true;
  }
  const mode =
    chatType === "group" || chatType === "channel"
      ? (params.config.messages?.groupChat?.visibleReplies ??
        params.config.messages?.visibleReplies)
      : params.config.messages?.visibleReplies;
  return mode === "message_tool" || (mode !== "automatic" && params.runtime === "codex");
}

/** Only an explicit settled cron.result can replace private execution prose. */
export function selectLegacyHeartbeatReplyPayloads(params: {
  explicitOnly: boolean;
  payloads: ReplyPayload[];
  result?: AutomationResult;
  successful: boolean;
  pending: boolean;
}): ReplyPayload[] {
  if (!params.explicitOnly) return params.payloads;
  const notices = params.payloads.filter(
    (payload) => getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true,
  );
  if (
    !params.successful ||
    params.pending ||
    !params.result ||
    params.result.outcome === "no_change"
  )
    return notices;
  const text = params.result.summary?.trim();
  // Foreground shaping and conversation settlement can see the same prepared payload.
  if (text && notices.some((payload) => payload.text?.trim() === text)) return notices;
  return text ? [...notices, markReplyPayloadForSourceSuppressionDelivery({ text })] : notices;
}
