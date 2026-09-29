// Slack permalink parsing for message and file links pasted into a conversation.

export type SlackPermalink =
  | {
      kind: "message";
      channelId: string;
      /** Message timestamp, when the link names one message rather than the conversation. */
      messageTs?: string;
      /** Parent thread timestamp for a reply link. */
      threadTs?: string;
    }
  | {
      kind: "file";
      fileId: string;
    };

const SLACK_PERMALINK_HOST_RE = /(^|\.)slack(-gov)?\.com$/i;
const SLACK_CONVERSATION_ID_RE = /^[CDG][A-Z0-9]{6,}$/i;
const SLACK_FILE_ID_RE = /^F[A-Z0-9]{6,}$/i;
const SLACK_TS_RE = /^\d{10}\.\d{6}$/;

function permalinkTsToSlackTs(raw: string | undefined): string | undefined {
  const match = /^p(\d{10})(\d{6})$/i.exec(raw ?? "");
  return match ? `${match[1]}.${match[2]}` : undefined;
}

function readSlackTsQuery(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key)?.trim();
  return value && SLACK_TS_RE.test(value) ? value : undefined;
}

/**
 * Parses https://<workspace>.slack.com/archives/<conversation>/p<ts> message links
 * and https://<workspace>.slack.com/files/<user>/<file>/<name> file links.
 * Returns undefined for anything that is not a Slack-hosted permalink.
 */
export function parseSlackPermalink(raw: unknown): SlackPermalink | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  // Slack renders links as <url|label>; accept the raw mrkdwn form too.
  const trimmed = raw
    .trim()
    .replace(/^<([^|>]+)(\|[^>]*)?>$/, "$1")
    .trim();
  if (!/^https:\/\//i.test(trimmed)) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || !SLACK_PERMALINK_HOST_RE.test(url.hostname)) {
    return undefined;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] === "archives") {
    const channelId = segments[1]?.toUpperCase();
    if (!channelId || !SLACK_CONVERSATION_ID_RE.test(channelId)) {
      return undefined;
    }
    const messageTs = permalinkTsToSlackTs(segments[2]);
    if (segments[2] && !messageTs) {
      return undefined;
    }
    const threadTs = readSlackTsQuery(url, "thread_ts");
    return {
      kind: "message",
      channelId,
      ...(messageTs ? { messageTs } : {}),
      ...(threadTs && threadTs !== messageTs ? { threadTs } : {}),
    };
  }
  if (segments[0] === "files") {
    // /files/<user>/<file>/<name>
    const fileId = segments[2]?.toUpperCase();
    return fileId && SLACK_FILE_ID_RE.test(fileId) ? { kind: "file", fileId } : undefined;
  }
  if (segments[0] === "files-pri" || segments[0] === "files-tmb") {
    // /files-pri/<team>-<file>/<name>
    const fileId = segments[1]?.split("-").at(-1)?.toUpperCase();
    return fileId && SLACK_FILE_ID_RE.test(fileId) ? { kind: "file", fileId } : undefined;
  }
  return undefined;
}
