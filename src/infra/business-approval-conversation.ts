import {
  sanitizeApprovalScope,
  summarizeApprovalScope,
  type ApprovalScope,
} from "./approval-scope.js";
import { sanitizeExecApprovalDisplayText } from "./exec-approval-text-sanitize.js";

/** Enable writers only after compatible approval readers have been deployed. */
const DECISION_CARDS_ENV = "OPENCLAW_CONVERSATION_DECISION_CARDS";

export function decisionCardsEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = env[DECISION_CARDS_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/** Plugin-authored business intent for people in the conversation, never execution diagnostics. */
export type BusinessApprovalConversation = { title: string; summary: string };

const LIMITS = { title: 80, summary: 280 } as const;
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;
const VISIBLE = /[^\s\p{Z}\p{Cc}\p{Cf}]/u;

/** Reject rather than truncate: omitted words can change what a person thinks they authorize. */
export function resolveBusinessApprovalConversation(request: {
  conversation?: unknown;
  scope?: ApprovalScope | null;
}): BusinessApprovalConversation | undefined {
  let copy = request.conversation;
  if (copy === undefined && request.scope && request.scope.kind !== "standing-grant") {
    const scope = sanitizeApprovalScope(request.scope);
    if (!scope || scope.kind === "standing-grant") {
      return undefined;
    }
    copy = {
      title:
        scope.kind === "payment"
          ? "Approve a payment"
          : scope.kind === "message-send"
            ? "Send a message"
            : "Publish outside the conversation",
      summary: summarizeApprovalScope(scope),
    };
  }
  if (!copy || typeof copy !== "object" || Array.isArray(copy)) {
    return undefined;
  }
  if (!("title" in copy) || !("summary" in copy)) {
    return undefined;
  }
  const result: BusinessApprovalConversation = { title: "", summary: "" };
  for (const key of ["title", "summary"] as const) {
    const raw = copy[key];
    if (typeof raw !== "string" || raw.length > LIMITS[key] || INVISIBLE.test(raw)) {
      return undefined;
    }
    const text = sanitizeExecApprovalDisplayText(raw).trim();
    if (!VISIBLE.test(text) || text.length > LIMITS[key] || INVISIBLE.test(text)) {
      return undefined;
    }
    result[key] = text;
  }
  return result;
}
