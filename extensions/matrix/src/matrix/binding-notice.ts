// Binding notices are transport chatter, not conversation content. The texts
// live here so the binder that posts them and the snapshot reconciler that
// retires them from source transcripts cannot drift apart.
export const READ_ONLY_SOURCE_HISTORY_NOTICE =
  "Read-only Slack conversation history. Continue in Slack.";
export const SOURCE_HISTORY_SYNCHRONIZED_NOTICE = "Slack conversation history synchronized.";

const SESSION_ACTIVE_NOTICE =
  /^⚙️ [^\n]{1,200} session active\. Messages here go directly to this session\.$/u;

export function isMatrixBindingNoticeText(body: unknown): boolean {
  if (typeof body !== "string") {
    return false;
  }
  const text = body.trim();
  return (
    text === READ_ONLY_SOURCE_HISTORY_NOTICE ||
    text === SOURCE_HISTORY_SYNCHRONIZED_NOTICE ||
    SESSION_ACTIVE_NOTICE.test(text)
  );
}
