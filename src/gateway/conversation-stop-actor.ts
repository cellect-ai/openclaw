import { getLoadedChannelPlugin } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRunStopUserId, type VerifiedRunStopActor } from "../infra/run-stop-actor.js";
import { ADMIN_SCOPE } from "./method-scopes.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { resolveMatrixTalkBinding } from "./talk-matrix-binding.js";

export type ConversationStopActorAssertion = {
  userId: string;
  roomId: string;
  threadRootEventId: string;
  agentMxid: string;
};

const ROOM_ID = /^![^\s:]+:[^\s]+$/;

/** The paired application service attests its user's authorization;
 * the channel independently proves its native target and current membership.
 * A gateway operator alone is not an application attribution issuer.
 */
export async function resolveConversationStopActor(params: {
  cfg: OpenClawConfig;
  client: GatewayRequestHandlerOptions["client"];
  assertion: ConversationStopActorAssertion | undefined;
  sessionKey: string;
  agentId: string;
  assertCurrent: () => void;
  env?: NodeJS.ProcessEnv;
}): Promise<VerifiedRunStopActor | undefined> {
  if (params.assertion === undefined) {
    return undefined;
  }
  const { client } = params;
  const assertion = { ...params.assertion };
  const current = () => {
    params.assertCurrent();
    client?.connectionSignal?.throwIfAborted();
    const issuers = new Set(
      (params.env ?? process.env).OPENCLAW_CONVERSATION_CONTROL_ISSUER_DEVICE_IDS?.split(
        /[\s,]+/,
      ).filter((value) => /^[a-f0-9]{64}$/.test(value)) ?? [],
    );
    const deviceId = client?.connect.device?.id;
    if (
      !deviceId ||
      !issuers.has(deviceId) ||
      !client?.pairedClientId ||
      client.invalidated ||
      client.connect.role !== "operator" ||
      client.internal?.syntheticClient ||
      !client.connect.scopes?.includes(ADMIN_SCOPE)
    ) {
      throw new Error("Conversation control attribution issuer is unavailable");
    }
  };
  current();
  if (
    !isRunStopUserId(assertion.userId) ||
    !isRunStopUserId(assertion.agentMxid) ||
    !ROOM_ID.test(assertion.roomId) ||
    !/^\$[^\s]{1,254}$/.test(assertion.threadRootEventId)
  ) {
    throw new Error("Conversation control attribution target is invalid");
  }
  const route = await resolveMatrixTalkBinding({
    cfg: params.cfg,
    roomId: assertion.roomId,
    threadRootEventId: assertion.threadRootEventId,
    agentMxid: assertion.agentMxid,
  });
  current();
  if (route.sessionKey !== params.sessionKey || route.agentId !== params.agentId) {
    throw new Error("Conversation control attribution target does not match");
  }
  const membership = getLoadedChannelPlugin("matrix")?.groups?.isJoinedMember;
  if (
    !membership ||
    !(await membership({
      cfg: params.cfg,
      accountId: route.accountId,
      expectedAccountUserId: assertion.agentMxid,
      groupId: assertion.roomId,
      userId: assertion.userId,
      assertCurrent: current,
    }))
  ) {
    throw new Error("Conversation control attribution membership is unavailable");
  }
  current();
  return Object.freeze({
    userId: assertion.userId,
    roomId: assertion.roomId,
    threadRootEventId: assertion.threadRootEventId,
    sessionKey: route.sessionKey,
    agentId: route.agentId,
  });
}
