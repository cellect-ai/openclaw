const MAIL_WAKE_SESSION_PREFIX = "hook:fi-mail:";
import type { Result } from "@openclaw/normalization-core/result";

const MAIL_REQUESTER_EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

const MAIL_REQUESTER_SLACK = /^U[A-Z0-9]{8,32}$/;

/**
 * Shared-mail wakes name the Fi member they act as. Empty strings are absent.
 * Any other session, including a mapped webhook, is refused so a template
 * cannot copy a requester out of message content.
 */
export function normalizeMailWakeRequester(
  payload: Record<string, unknown>,
  sessionKey: string | undefined,
): Result<{ mailRequesterEmail?: string; mailRequesterSlackUserId?: string }, string> {
  const emailRaw = payload.mailRequesterEmail;
  const slackRaw = payload.mailRequesterSlackUserId;
  if (emailRaw === undefined && slackRaw === undefined) {
    return { ok: true, value: {} };
  }
  if (
    (emailRaw !== undefined && typeof emailRaw !== "string") ||
    (slackRaw !== undefined && typeof slackRaw !== "string")
  ) {
    return { ok: false, error: "mail requester must be a string" };
  }
  const email = typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";
  const slack = typeof slackRaw === "string" ? slackRaw.trim().toUpperCase() : "";
  if (!email && !slack) {
    return { ok: true, value: {} };
  }
  if (!sessionKey?.startsWith(MAIL_WAKE_SESSION_PREFIX)) {
    return {
      ok: false,
      error: "mail requester fields are only accepted on a hook:fi-mail: session",
    };
  }
  if (email && (email.length > 254 || !MAIL_REQUESTER_EMAIL.test(email))) {
    return { ok: false, error: "mailRequesterEmail must be an email address" };
  }
  if (slack && !MAIL_REQUESTER_SLACK.test(slack)) {
    return { ok: false, error: "mailRequesterSlackUserId must be a Slack user id" };
  }
  return {
    ok: true,
    value: {
      ...(email ? { mailRequesterEmail: email } : {}),
      ...(slack ? { mailRequesterSlackUserId: slack } : {}),
    },
  };
}
