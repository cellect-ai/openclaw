/** Log categories, never upstream error text, request bodies or credentials. */
export function projectionFailureKind(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "unknown";
  }
  const value = error as { message?: unknown; code?: unknown; data?: { error?: unknown } };
  const slackCode = value.data?.error;
  if (
    typeof slackCode === "string" &&
    [
      "ratelimited",
      "not_authed",
      "invalid_auth",
      "missing_scope",
      "not_in_channel",
      "channel_not_found",
      "thread_not_found",
    ].includes(slackCode)
  ) {
    return `slack_${slackCode}`;
  }
  const message = typeof value.message === "string" ? value.message : "";
  const http = /^Fi channel projection failed \(([1-5]\d\d)\)$/.exec(message);
  if (http) {
    return `fi_http_${http[1]}`;
  }
  if (message === "Slack thread reader unavailable for this account") {
    return "source_reader_unavailable";
  }
  if (message === "Slack snapshot deadline exceeded") {
    return "source_deadline";
  }
  if (value.code === "ETIMEDOUT" || value.code === "ECONNRESET") {
    return "transport_unavailable";
  }
  return "unknown";
}
