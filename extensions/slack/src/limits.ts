export const SLACK_TEXT_LIMIT = 8000;

// Slack recommends no more than 4,000 characters for chat.postMessage text.
// Longer fallback posts can be split while the API returns only one timestamp.
// https://api.slack.com/methods/chat.postMessage#truncating
export const SLACK_MESSAGE_TEXT_RECOMMENDED_LIMIT = 4_000;

// chat.update documents 4,000 characters but rejects text above 4,000 UTF-8 bytes in live use.
// https://docs.slack.dev/reference/methods/chat.update/#errors
export const SLACK_EDIT_TEXT_MAX_BYTES = 4_000;

// Slack truncates chat.postMessage text above 40,000 characters.
// https://api.slack.com/methods/chat.postMessage#truncating
export const SLACK_MESSAGE_TEXT_HARD_LIMIT = 40_000;

// Default cap for Slack files the gateway downloads (inbound attachments and the
// download-file action). Files stream to disk, so the cap bounds disk use and
// transfer time rather than memory. Override per account with mediaMaxMb.
export const SLACK_DEFAULT_MEDIA_MAX_MB = 100;

export function resolveSlackMediaMaxBytes(mediaMaxMb: number | undefined): number {
  const mb =
    typeof mediaMaxMb === "number" && Number.isFinite(mediaMaxMb) && mediaMaxMb > 0
      ? mediaMaxMb
      : SLACK_DEFAULT_MEDIA_MAX_MB;
  return Math.floor(mb * 1024 * 1024);
}

/** Refuses a Slack file whose reported size is above the download cap, naming the cap. */
export function assertSlackFileWithinDownloadCap(
  fileId: string,
  size: number | undefined,
  maxBytes: number,
): void {
  if (typeof size !== "number" || size <= maxBytes) {
    return;
  }
  const toMb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
  throw new Error(
    `Slack file ${fileId} is ${toMb(size)} MB, above the ${toMb(maxBytes)} MB download cap for this Slack account (raise channels.slack.mediaMaxMb to allow it).`,
  );
}
