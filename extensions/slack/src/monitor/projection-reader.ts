import type { WebClient } from "@slack/web-api";
import { readSlackDirectIdentity, readSlackDirectSnapshot } from "./direct-snapshot.js";
import { readSlackProjectionChannel, readSlackThreadSnapshot } from "./thread-snapshot.js";

/**
 * The `thread-read-projection` runtime context: read-only Slack access for the
 * Fi projection reconciler, bound to one workspace and read client.
 */
export function createSlackProjectionReader(params: {
  client: WebClient;
  workspaceId: string;
  botUserId: string;
  /** When the Socket Mode connection last (re)started; undefined before the first. */
  socketConnectedAt: () => number | undefined;
}) {
  const { client, workspaceId } = params;
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
  };
}
