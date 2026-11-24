import { type ChatEvent } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { isTimeoutError, resolveFailoverReasonFromError } from "../agents/failover-error.js";
import { formatErrorMessage } from "../infra/errors.js";

// Derived from ChatErrorEventSchema.errorKind (gateway-protocol); keep set in sync.
type ChatErrorKind = NonNullable<Extract<ChatEvent, { state: "error" }>["errorKind"]>;

const CHAT_ERROR_KINDS = new Set<ChatErrorKind>([
  "refusal",
  "timeout",
  "rate_limit",
  "context_length",
  "unknown",
]);

export function readChatErrorKind(value: unknown): ChatErrorKind | undefined {
  return typeof value === "string" && CHAT_ERROR_KINDS.has(value as ChatErrorKind)
    ? (value as ChatErrorKind)
    : undefined;
}

// Refusal is a stop-reason fact; other badges use the canonical failover classification.
export function resolveChatErrorKindFromError(error: unknown): ChatErrorKind | undefined {
  if (error === undefined) {
    return undefined;
  }
  const message = formatErrorMessage(error).toLowerCase();
  if (
    message.includes("refusal") ||
    message.includes("content_filter") ||
    message.includes("sensitive")
  ) {
    return "refusal";
  }
  const reason = resolveFailoverReasonFromError(error);
  if (reason === "rate_limit" || reason === "overloaded") {
    return "rate_limit";
  }
  if (reason === "context_overflow") {
    return "context_length";
  }
  // FailoverReason "timeout" is the retryable-transient bucket and deliberately
  // swallows generic 5xx; only genuinely timeout-shaped errors get the badge.
  return isTimeoutError(error) ? "timeout" : undefined;
}
