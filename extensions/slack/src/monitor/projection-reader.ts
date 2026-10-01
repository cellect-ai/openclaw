import type { WebClient } from "@slack/web-api";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { readSlackDirectIdentity, readSlackDirectSnapshot } from "./direct-snapshot.js";
import {
  FI_CHAT_POINTER_EVENT,
  fiChatPointerText,
  sourcePointerCoversLatest,
} from "./fi-chat-pointer.js";
import { readSlackProjectionChannel, readSlackThreadSnapshot } from "./thread-snapshot.js";

const pointerPosts = new KeyedAsyncQueue();

/**
 * Slack source snapshots for the Fi projection reconciler, plus an idempotent
 * notice that points at the Fi conversation. Snapshots never include that notice.
 * A later Slack message (file, reply) after the last notice gets a fresh one.
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
      coversLatest?: boolean;
    }): Promise<"posted" | "existing" | "skipped"> => {
      const text = fiChatPointerText(input.chatUrl);
      if (!text || !/^[CDG][A-Z0-9]+$/.test(input.channelId)) {
        return "skipped";
      }
      if (input.rootMessageId && !/^\d+\.\d+$/.test(input.rootMessageId)) {
        return "skipped";
      }
      const key = `${workspaceId}:${input.channelId}:${input.rootMessageId ?? "direct"}`;
      return pointerPosts.enqueue(key, async () => {
        if (input.coversLatest) {
          return "existing";
        }
        if (input.rootMessageId) {
          const snapshot = await readSlackThreadSnapshot(
            client,
            workspaceId,
            input.channelId,
            input.rootMessageId,
          );
          if (snapshot.sourcePointerCurrent) {
            return "existing";
          }
        } else {
          const history = await client.conversations.history({
            channel: input.channelId,
            limit: 200,
          });
          if (sourcePointerCoversLatest(history.messages ?? [])) {
            return "existing";
          }
        }
        const result = await writeClient.chat.postMessage({
          channel: input.channelId,
          text,
          unfurl_links: false,
          unfurl_media: false,
          ...(input.rootMessageId ? { thread_ts: input.rootMessageId } : {}),
          metadata: {
            event_type: FI_CHAT_POINTER_EVENT,
            event_payload: { v: 1 },
          },
        });
        return result.ok ? "posted" : "skipped";
      });
    },
  };
}
