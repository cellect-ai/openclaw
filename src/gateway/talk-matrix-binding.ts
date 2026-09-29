import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getLoadedChannelPlugin } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOutboundSessionRoute } from "../infra/outbound/outbound-session.js";
import { resolveLoadedPluginConversationRouteOwner } from "./conversation-route-ownership.js";

export async function resolveMatrixTalkBinding(params: {
  cfg: OpenClawConfig;
  roomId: string;
  threadRootEventId: string;
  agentMxid: string;
}): Promise<{ sessionKey: string; agentId: string; accountId: string }> {
  const roomId = normalizeOptionalString(params.roomId);
  const threadRootEventId = normalizeOptionalString(params.threadRootEventId);
  const agentMxid = normalizeOptionalString(params.agentMxid);
  if (!roomId || !threadRootEventId || !agentMxid) {
    throw new Error("Matrix Talk binding requires roomId, threadRootEventId, and agentMxid");
  }

  // Account credentials may come from the Matrix credential store rather than
  // openclaw.json, so account identity must be resolved by the loaded channel
  // plugin. Core must not import an optional extension: plugin-pruned Docker
  // images otherwise retain a dangling dist import.
  const matrixPlugin = getLoadedChannelPlugin("matrix");
  if (!matrixPlugin) {
    throw new Error("Matrix Talk channel is unavailable");
  }
  const matches = matrixPlugin.config.listAccountIds(params.cfg).filter((accountId) => {
    const account = matrixPlugin.config.resolveAccount(params.cfg, accountId) as {
      userId?: unknown;
    };
    return normalizeOptionalString(account.userId) === agentMxid;
  });
  if (matches.length !== 1) {
    throw new Error("Matrix Talk agent account did not resolve uniquely");
  }
  const accountId = matches[0]!;
  const owner = resolveLoadedPluginConversationRouteOwner({
    config: params.cfg,
    conversation: {
      channel: "matrix",
      accountId,
      kind: "channel",
      peerId: roomId,
      nativeChannelId: roomId,
      target: `room:${roomId}`,
      threadId: threadRootEventId,
    },
  });
  if (owner && "unavailable" in owner) {
    throw new Error("Matrix Talk agent route is temporarily unavailable");
  }
  const agentId = normalizeOptionalString(owner?.agentId);
  if (!agentId) {
    throw new Error("Matrix Talk agent route is not configured");
  }
  const route = await resolveOutboundSessionRoute({
    cfg: params.cfg,
    channel: "matrix",
    agentId,
    accountId,
    target: `room:${roomId}`,
    threadId: threadRootEventId,
  });
  if (!route) {
    throw new Error("Matrix Talk conversation route is unavailable");
  }
  return { sessionKey: route.sessionKey, agentId, accountId };
}
