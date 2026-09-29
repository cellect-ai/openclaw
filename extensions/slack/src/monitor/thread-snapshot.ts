import type { WebClient } from "@slack/web-api";
import { hydrateSlackProjectionNames } from "./projection-actor.js";
import { slackProjectionContent } from "./projection-content.js";
import { createProjectionDeadline } from "./projection-deadline.js";

/** Complete, account-authorized source snapshot; partial pagination never grants access. */
export async function readSlackThreadSnapshot(
  client: WebClient,
  workspaceId: string,
  channelId: string,
  rootMessageId: string,
) {
  const channel = await readSlackProjectionChannel(client, workspaceId, channelId);
  return channel.readThread(rootMessageId);
}

/** One bounded sweep scope; roster is never cached across background sweeps. */
export async function readSlackProjectionChannel(
  client: WebClient,
  workspaceId: string,
  channelId: string,
  /** Every Claw bot user in the workspace; a channel can hold several. */
  clawBotUserIds: Iterable<string> = [],
) {
  const read = createProjectionDeadline();
  if (!/^T[A-Z0-9]+$/.test(workspaceId) || !/^[CG][A-Z0-9]+$/.test(channelId)) {
    throw new Error("Invalid Slack thread identity");
  }
  const identity = await read(() => client.auth.test());
  if (!identity.ok || identity.team_id !== workspaceId) {
    throw new Error("Slack reader workspace mismatch");
  }
  const memberSenderIds: string[] = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    const page = await read(() =>
      client.conversations.members({ channel: channelId, limit: 200, cursor }),
    );
    if (!page.ok || !Array.isArray(page.members)) {
      throw new Error("Slack membership unavailable");
    }
    memberSenderIds.push(...page.members);
    cursor = page.response_metadata?.next_cursor?.trim() || undefined;
    if (cursor && cursors.has(cursor)) {
      throw new Error("Slack membership pagination incomplete");
    }
    if (cursor) {
      cursors.add(cursor);
    }
  } while (cursor);
  const source = { workspaceId, channelId, memberSenderIds: [...new Set(memberSenderIds)] };
  const clawUsers = new Set([...clawBotUserIds, identity.user_id].filter(Boolean) as string[]);
  const readerBotId = identity.bot_id;
  const mentionsClaw = (text: string) =>
    [...clawUsers].some((id) => text.includes(`<@${id}>`) || text.includes(`<@${id}|`));
  const involvesClaw = (message: {
    ts?: string;
    thread_ts?: string;
    user?: string;
    bot_id?: string;
    text?: string;
    reply_count?: number;
    reply_users?: string[];
  }) => {
    // A reply broadcast to the channel is part of its thread, not a new root.
    if (message.thread_ts && message.thread_ts !== message.ts) {
      return false;
    }
    const authored =
      Boolean(readerBotId && message.bot_id === readerBotId) ||
      Boolean(message.user && clawUsers.has(message.user));
    return (
      (authored && (message.reply_count ?? 0) > 0) ||
      Boolean(message.reply_users?.some((id) => clawUsers.has(id))) ||
      mentionsClaw(message.text ?? "")
    );
  };
  return {
    ...source,
    readHistoryPage: async (historyCursor?: string) => {
      const page = await read(() =>
        client.conversations.history({ channel: channelId, limit: 100, cursor: historyCursor }),
      );
      if (!page.ok || !Array.isArray(page.messages)) {
        throw new Error("Slack channel history unavailable");
      }
      const nextCursor = page.response_metadata?.next_cursor?.trim() || undefined;
      if ((page.has_more && !nextCursor) || (nextCursor && nextCursor === historyCursor)) {
        throw new Error("Incomplete Slack channel history pagination");
      }
      // Only conversations a Claw bot is part of are projected: one was
      // mentioned in the root, replied in the thread, or wrote a root someone
      // answered.
      // A bot post nobody replied to (a notification) is not a conversation;
      // human-only threads and other apps' posts stay in Slack.
      return {
        roots: page.messages.flatMap((message) =>
          message.ts && involvesClaw(message) ? [message.ts] : [],
        ),
        nextCursor,
      };
    },
    readThread: async (rootMessageId: string) => {
      if (!/^\d+\.\d+$/.test(rootMessageId)) {
        throw new Error("Invalid Slack thread identity");
      }
      const messages: Array<{
        messageId: string;
        senderId: string;
        content: string;
        bot: boolean;
      }> = [];
      const messageCursors = new Set<string>();
      let messageCursor: string | undefined;
      do {
        const page = await read(() =>
          client.conversations.replies({
            channel: channelId,
            ts: rootMessageId,
            limit: 100,
            cursor: messageCursor,
          }),
        );
        if (!page.ok || !Array.isArray(page.messages)) {
          throw new Error("Slack thread unavailable");
        }
        for (const message of page.messages) {
          if (message.ts && message.user && typeof message.text === "string") {
            messages.push({
              messageId: message.ts,
              senderId: message.user,
              content: slackProjectionContent(message),
              bot: Boolean(message.bot_id),
            });
          }
        }
        messageCursor = page.response_metadata?.next_cursor?.trim() || undefined;
        if (
          (page.has_more && !messageCursor) ||
          (messageCursor && messageCursors.has(messageCursor))
        ) {
          throw new Error("Slack thread pagination incomplete");
        }
        if (messageCursor) {
          messageCursors.add(messageCursor);
        }
      } while (messageCursor);
      return {
        workspaceId,
        channelId,
        rootMessageId,
        memberSenderIds: [...new Set(memberSenderIds)],
        messages: await hydrateSlackProjectionNames(client, workspaceId, messages, read),
      };
    },
  };
}
