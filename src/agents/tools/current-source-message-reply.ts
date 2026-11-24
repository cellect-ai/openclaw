import { isRecord } from "@openclaw/normalization-core/record-coerce";

/**
 * Identify the narrow current-source reply that may bypass voice confirmation.
 * The message tool's source-reply owner still validates route directives and
 * payloads before dispatch; this hot-path predicate only accepts implicit routing.
 */
export function isCurrentSourcePlainMessageReply(params: {
  toolName: string;
  toolParams: unknown;
  currentChannelProvider?: string;
  currentChannelId?: string;
}): boolean {
  if (
    params.toolName !== "message" ||
    !params.currentChannelProvider?.trim() ||
    !params.currentChannelId?.trim() ||
    !isRecord(params.toolParams)
  ) {
    return false;
  }

  const keys = Object.keys(params.toolParams);
  const message = params.toolParams.message;
  return (
    keys.length === 2 &&
    keys.every((key) => key === "action" || key === "message") &&
    params.toolParams.action === "send" &&
    typeof message === "string" &&
    message.trim().length > 0 &&
    !containsMessageActionControlSyntax(message)
  );
}

/** Control text can change a send's thread, payload, or delivery mode. */
function containsMessageActionControlSyntax(message: string): boolean {
  return (
    message.includes("[[") ||
    /\bMEDIA\s*:/i.test(message) ||
    /!\[[^\]]*\]\(/.test(message) ||
    /\bNO_REPLY\b/i.test(message)
  );
}
