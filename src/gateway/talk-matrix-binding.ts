import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveChannelAccount } from "../channels/account-resolution.js";
import { getLoadedChannelPlugin } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOutboundSessionRoute } from "../infra/outbound/outbound-session.js";
import { prepareSessionBindingInspections } from "../infra/outbound/session-binding-service.js";

export async function prepareMatrixTalkBinding(params: {
  cfg: OpenClawConfig;
  roomId: string;
  threadRootEventId: string;
  agentMxid: string;
  readCurrentConfig?: () => OpenClawConfig;
}) {
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
  // A token-only account (MATRIX_<ACCOUNT>_ACCESS_TOKEN) learns its MXID from
  // the credential store; the synchronous hook deliberately never reads that
  // store, so it reports no userId for every such account. Use the operational
  // hook, exactly as channel startup does.
  let active = true;
  const releases: Array<() => void> = [];
  const dispose = () => {
    active = false;
    for (const release of releases.splice(0)) release();
  };
  const assertPluginCurrent = () => {
    if (
      !active ||
      getLoadedChannelPlugin("matrix") !== matrixPlugin ||
      (params.readCurrentConfig && params.readCurrentConfig() !== params.cfg)
    ) {
      throw new Error("Matrix Talk binding owner changed");
    }
  };
  try {
    const matches: string[] = [];
    for (const accountId of matrixPlugin.config.listAccountIds(params.cfg)) {
      const account = (await resolveChannelAccount({
        plugin: matrixPlugin,
        cfg: params.cfg,
        accountId,
      })) as { userId?: unknown };
      assertPluginCurrent();
      if (normalizeOptionalString(account.userId) === agentMxid) {
        matches.push(accountId);
      }
    }
    if (matches.length !== 1) {
      throw new Error("Matrix Talk agent account did not resolve uniquely");
    }
    const accountId = matches[0]!;
    const input = {
      cfg: params.cfg,
      accountId,
      conversation: {
        kind: "channel" as const,
        peerId: roomId,
        nativeChannelId: roomId,
        target: `room:${roomId}`,
        threadId: threadRootEventId,
      },
    };
    const prepare = matrixPlugin.messaging?.prepareConversationRouteOwnersAsync;
    if (!prepare) throw new Error("Matrix Talk native binding owner is unavailable");
    let preparing = true;
    const resolvers = await prepare([input], async (refs) => {
      if (!preparing) throw new Error("Matrix Talk route preparation closed");
      const snapshot = await prepareSessionBindingInspections(refs);
      releases.push(snapshot.dispose);
      return () => snapshot.inspect();
    }).finally(() => {
      preparing = false;
    });
    assertPluginCurrent();
    if (resolvers.length !== 1) throw new Error("Matrix Talk binding selection is incomplete");
    const readOwner = () => {
      assertPluginCurrent();
      const owner = resolvers[0]!(input);
      if (!owner || owner.kind !== "agent") {
        throw new Error("Matrix Talk agent route is unavailable");
      }
      return normalizeOptionalString(owner.agentId);
    };
    const agentId = readOwner();
    if (!agentId) throw new Error("Matrix Talk agent route is not configured");
    const assertCurrent = () => {
      if (readOwner() !== agentId) throw new Error("Matrix Talk binding owner changed");
    };
    const route = await resolveOutboundSessionRoute({
      cfg: params.cfg,
      channel: "matrix",
      agentId,
      accountId,
      target: `room:${roomId}`,
      threadId: threadRootEventId,
    });
    assertCurrent();
    if (!route) {
      throw new Error("Matrix Talk conversation route is unavailable");
    }
    return { sessionKey: route.sessionKey, agentId, accountId, assertCurrent, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** One-shot callers consume detached route facts; effects retain prepareMatrixTalkBinding. */
export async function resolveMatrixTalkBinding(
  params: Parameters<typeof prepareMatrixTalkBinding>[0],
) {
  const binding = await prepareMatrixTalkBinding(params);
  try {
    binding.assertCurrent();
    return {
      sessionKey: binding.sessionKey,
      agentId: binding.agentId,
      accountId: binding.accountId,
    };
  } finally {
    binding.dispose();
  }
}
