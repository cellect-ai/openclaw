import type { WebClient } from "@slack/web-api";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { readSlackDirectIdentity, readSlackDirectSnapshot } from "./direct-snapshot.js";
import {
  FI_CHAT_POINTER_EVENT,
  fiChatPointerText,
  isSlackFiChatPointer,
  type SlackPointerCandidate,
} from "./fi-chat-pointer.js";
import { readSlackProjectionChannel, readSlackThreadSnapshot } from "./thread-snapshot.js";

const pointerPosts = new KeyedAsyncQueue();

/**
 * Slack source snapshots for the Fi projection reconciler, plus an idempotent
 * notice that points at the Fi conversation. Snapshots never include that notice.
 * Only accepted native activity can create a notice; later activity edits it in place.
 */
export function createSlackProjectionReader(params: {
  client: WebClient;
  writeClient?: WebClient;
  workspaceId: string;
  botUserId: string;
  /** When the Socket Mode connection last (re)started; undefined before the first. */
  socketConnectedAt: () => number | undefined;
}) {
  const { client, workspaceId } = params;
  const writeClient = params.writeClient ?? client;
  const postChatMessage = writeClient.chat.postMessage.bind(writeClient.chat);
  return {
    workspaceId,
    botUserId: params.botUserId,
    readDirectIdentity: (channelId: string, peerSenderId: string) =>
      readSlackDirectIdentity(client, workspaceId, channelId, peerSenderId),
    readDirect: (channelId: string, peerSenderId: string) =>
      readSlackDirectSnapshot(client, workspaceId, channelId, peerSenderId),
    readChannel: (channelId: string, clawBotUserIds?: Iterable<string>) =>
      readSlackProjectionChannel(client, workspaceId, channelId, clawBotUserIds),
    readThread: (channelId: string, rootMessageId: string) =>
      readSlackThreadSnapshot(client, workspaceId, channelId, rootMessageId),
    socketConnectedAt: params.socketConnectedAt,
    postChatPointer: async (input: {
      channelId: string;
      chatUrl: string;
      rootMessageId?: string;
      nativeEventId: string;
      nativeEventTs: number;
      isCurrent: () => Promise<boolean>;
    }): Promise<"posted" | "updated" | "existing" | "skipped"> => {
      const text = fiChatPointerText(input.chatUrl);
      if (
        !input.nativeEventId?.startsWith("$") ||
        !Number.isSafeInteger(input.nativeEventTs) ||
        input.nativeEventTs < 0 ||
        typeof input.isCurrent !== "function"
      ) {
        return "skipped";
      }
      if (!text || !/^[CDG][A-Z0-9]+$/.test(input.channelId)) {
        return "skipped";
      }
      if (input.rootMessageId && !/^\d+\.\d+$/.test(input.rootMessageId)) {
        return "skipped";
      }
      const key = `${workspaceId}:${input.channelId}:${input.rootMessageId ?? "direct"}`;
      return pointerPosts.enqueue(key, async () => {
        // Re-read complete source history, including metadata. A restart uses
        // Slack's own receipt, not a process-local remembered post timestamp.
        const identity = await writeClient.auth.test();
        if (
          !identity.ok ||
          identity.team_id !== workspaceId ||
          identity.user_id !== params.botUserId
        ) {
          return "skipped";
        }
        if (input.rootMessageId) {
          await readSlackThreadSnapshot(client, workspaceId, input.channelId, input.rootMessageId);
        }
        const messages: SlackPointerCandidate[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = input.rootMessageId
            ? await client.conversations.replies({
                channel: input.channelId,
                ts: input.rootMessageId,
                limit: 100,
                include_all_metadata: true,
                cursor,
              })
            : await client.conversations.history({
                channel: input.channelId,
                limit: 100,
                include_all_metadata: true,
                cursor,
              });
          if (!page.ok || !Array.isArray(page.messages)) {
            throw new Error("Slack pointer history unavailable");
          }
          messages.push(...(page.messages ?? []));
          const next = page.response_metadata?.next_cursor?.trim();
          if ((page.has_more && !next) || (next && cursors.has(next))) {
            throw new Error("Slack pointer history incomplete");
          }
          if (next && cursors.size >= 100) {
            throw new Error("Slack pointer history exceeds read budget");
          }
          if (next) {
            cursors.add(next);
          }
          cursor = next || undefined;
        } while (cursor);
        const conversationId = new URL(input.chatUrl).searchParams.get("fiConversation");
        const canonicalUrl = new URL(input.chatUrl).href;
        const notices = messages
          .filter((message) => {
            if (
              !(message.bot_id || message.user === params.botUserId) ||
              !isSlackFiChatPointer(message) ||
              !message.ts
            ) {
              return false;
            }
            return (message.text?.match(/https:\/\/[^\s>|]+/gi) ?? []).some((candidate) => {
              try {
                return new URL(candidate).href === canonicalUrl;
              } catch {
                return false;
              }
            });
          })
          .toSorted((a, b) => a.ts!.localeCompare(b.ts!));
        const pointer = notices.find((message) => message.user === params.botUserId);
        // Source ownership can change. A previous bot's exact link already
        // serves this thread; never append a duplicate or mutate its message.
        if (!pointer && notices.length > 0) {
          return "existing";
        }
        const receipt = pointer?.metadata?.event_payload;
        if (
          receipt?.conversationId === conversationId &&
          typeof receipt.nativeEventTs === "number" &&
          (receipt.nativeEventTs > input.nativeEventTs ||
            (receipt.nativeEventTs === input.nativeEventTs &&
              typeof receipt.nativeEventId === "string" &&
              receipt.nativeEventId >= input.nativeEventId))
        ) {
          return "existing";
        }
        if (!(await input.isCurrent())) {
          return "skipped";
        }
        const metadata = {
          event_type: FI_CHAT_POINTER_EVENT,
          event_payload: {
            v: 2,
            conversationId: conversationId!,
            nativeEventId: input.nativeEventId,
            nativeEventTs: input.nativeEventTs,
          },
        };
        if (pointer?.ts) {
          const updated = await writeClient.chat.update({
            channel: input.channelId,
            ts: pointer.ts,
            text,
            metadata,
          });
          return updated.ok ? "updated" : "skipped";
        }
        const result = await postChatMessage({
          channel: input.channelId,
          text,
          unfurl_links: false,
          unfurl_media: false,
          ...(input.rootMessageId ? { thread_ts: input.rootMessageId } : {}),
          metadata,
          reply_broadcast: false,
        });
        return result.ok ? "posted" : "skipped";
      });
    },
  };
}
