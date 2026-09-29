import type { WebClient } from "@slack/web-api";
import { hydrateSlackProjectionNames } from "./projection-actor.js";
import { slackProjectionContent } from "./projection-content.js";
import { createProjectionDeadline } from "./projection-deadline.js";

type Message = { ts?: string; user?: string; text?: string; bot_id?: string; reply_count?: number };
type Page = {
  ok?: boolean;
  messages?: Message[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
};

/** Native DM identity and complete visible history, never an inferred channel roster. */
export async function readSlackDirectIdentity(
  client: WebClient,
  workspaceId: string,
  channelId: string,
  peerSenderId: string,
  read = createProjectionDeadline(),
) {
  if (
    !/^T[A-Z0-9]+$/.test(workspaceId) ||
    !/^D[A-Z0-9]+$/.test(channelId) ||
    !/^[UW][A-Z0-9]+$/.test(peerSenderId)
  ) {
    throw new Error("Invalid Slack direct identity");
  }
  const identity = await read(() => client.auth.test());
  if (!identity.ok || identity.team_id !== workspaceId) {
    throw new Error("Slack reader workspace mismatch");
  }
  const info = await read(() => client.conversations.info({ channel: channelId }));
  const channel = info.channel;
  if (
    !info.ok ||
    channel?.is_im !== true ||
    !("user" in channel) ||
    channel.user !== peerSenderId
  ) {
    throw new Error("Slack DM peer mismatch");
  }
  return { workspaceId, channelId, peerSenderId };
}

export async function readSlackDirectSnapshot(
  client: WebClient,
  workspaceId: string,
  channelId: string,
  peerSenderId: string,
) {
  const read = createProjectionDeadline();
  const directSource = await readSlackDirectIdentity(
    client,
    workspaceId,
    channelId,
    peerSenderId,
    read,
  );
  const messages = new Map<string, Message>();
  const collect = async (fetchPage: (cursor?: string) => Promise<Page>) => {
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await read(() => fetchPage(cursor));
      if (!page.ok || !Array.isArray(page.messages)) {
        throw new Error("Slack DM history unavailable");
      }
      for (const message of page.messages) {
        if (message.ts) {
          messages.set(message.ts, message);
        }
      }
      if (messages.size > 1000) {
        throw new Error("Slack DM history exceeds bounded snapshot");
      }
      cursor = page.response_metadata?.next_cursor?.trim() || undefined;
      if ((page.has_more && !cursor) || (cursor && cursors.has(cursor))) {
        throw new Error("Incomplete Slack DM pagination");
      }
      if (cursor) {
        cursors.add(cursor);
      }
    } while (cursor);
  };
  await collect((cursor) =>
    client.conversations.history({ channel: channelId, limit: 100, cursor }),
  );
  const roots = [...messages.values()].filter((message) => (message.reply_count ?? 0) > 0);
  for (const root of roots) {
    const ts = root.ts;
    if (ts) {
      await collect((cursor) =>
        client.conversations.replies({ channel: channelId, ts, limit: 100, cursor }),
      );
    }
  }
  return {
    directSource,
    messages: await hydrateSlackProjectionNames(
      client,
      workspaceId,
      [...messages.values()]
        .flatMap((message) =>
          message.ts && message.user && typeof message.text === "string"
            ? [
                {
                  messageId: message.ts,
                  senderId: message.user,
                  content: slackProjectionContent(message),
                  bot: Boolean(message.bot_id),
                },
              ]
            : [],
        )
        .toSorted((left, right) => left.messageId.localeCompare(right.messageId)),
      read,
    ),
  };
}
