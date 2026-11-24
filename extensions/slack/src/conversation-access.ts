// Slack plugin module answers who can see a conversation or file, for permalink reads.
import { getClient, type SlackActionClientOpts } from "./actions.js";

const SLACK_MEMBERSHIP_PAGE_LIMIT = 1000;
const SLACK_MEMBERSHIP_MAX_PAGES = 20;

/**
 * Reports whether a user belongs to a conversation, using conversations.members.
 * Slack returns an error (for example channel_not_found) when the calling token
 * cannot see the conversation; that error propagates so callers can explain it.
 */
export async function isSlackConversationMember(
  channelId: string,
  userId: string,
  opts: SlackActionClientOpts = {},
): Promise<boolean> {
  const client = await getClient(opts);
  const wanted = userId.trim().toUpperCase();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < SLACK_MEMBERSHIP_MAX_PAGES; page += 1) {
    const result = await client.conversations.members({
      channel: channelId,
      limit: SLACK_MEMBERSHIP_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    if ((result.members ?? []).some((member) => member.toUpperCase() === wanted)) {
      return true;
    }
    cursor = result.response_metadata?.next_cursor?.trim() || undefined;
    if (!cursor || cursors.has(cursor)) {
      return false;
    }
    cursors.add(cursor);
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Lists the conversations a Slack file has been shared into, from fresh files.info metadata. */
export async function listSlackFileShareChannelIds(
  fileId: string,
  opts: SlackActionClientOpts = {},
): Promise<string[]> {
  const client = await getClient(opts);
  const info = await client.files.info({ file: fileId });
  const file = isRecord(info.file) ? info.file : undefined;
  if (!file) {
    return [];
  }
  const ids = new Set<string>();
  for (const group of [file.channels, file.groups, file.ims]) {
    for (const entry of Array.isArray(group) ? group : []) {
      if (typeof entry === "string" && entry.trim()) {
        ids.add(entry.trim());
      }
    }
  }
  const shares = isRecord(file.shares) ? file.shares : {};
  for (const scope of [shares.public, shares.private]) {
    for (const channelId of Object.keys(isRecord(scope) ? scope : {})) {
      if (channelId.trim()) {
        ids.add(channelId.trim());
      }
    }
  }
  return Array.from(ids);
}
