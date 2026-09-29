import type { PluginHookChannelContext } from "../plugins/hook-channel-context.types.js";
import type { ChatSendExplicitOrigin } from "./server-methods/chat-origin-routing.js";
import { relaySessions, type RelaySession } from "./talk/relay/state.js";

type MatrixRoute = NonNullable<RelaySession["matrixRoute"]>;

/** Private, live relay authority; never accepted from chat.send wire parameters. */
export type TalkRelayConsultAdmission = {
  assertCurrent(
    sessionKey: string,
    connId: string | undefined,
    origin: ChatSendExplicitOrigin | undefined,
  ): void;
  /**
   * The Matrix speaker the app server attested when it minted the Talk binding
   * (operator-scoped `talk.binding.resolve`). It is the consult run's requester.
   */
  readonly speakerMxid?: string;
  /** Host-only Talk identity; chat.send wire input cannot supply this context. */
  readonly channelContext?: PluginHookChannelContext;
};

export function prepareTalkRelayConsultAdmission(params: {
  relaySessionId: string;
  connId: string;
  sessionKey: string;
  callId: string;
  matrixRoute: MatrixRoute;
}): TalkRelayConsultAdmission {
  const { relaySessionId, connId: ownerConnId, sessionKey: ownerSessionKey, callId } = params;
  const relay = relaySessions.get(relaySessionId);
  const route = { ...params.matrixRoute };
  const assertCurrent: TalkRelayConsultAdmission["assertCurrent"] = (
    sessionKey,
    connId,
    origin,
  ) => {
    if (
      !relay ||
      relaySessions.get(relaySessionId) !== relay ||
      relay.closeDisposition !== undefined ||
      !Number.isFinite(relay.expiresAtMs) ||
      relay.expiresAtMs <= Date.now() ||
      relay.connId !== ownerConnId ||
      connId !== ownerConnId ||
      relay.sessionTarget.canonicalKey !== ownerSessionKey ||
      sessionKey !== ownerSessionKey ||
      relay.matrixRoute?.channel !== route.channel ||
      relay.matrixRoute.roomId !== route.roomId ||
      relay.matrixRoute.threadRootEventId !== route.threadRootEventId ||
      relay.matrixRoute.accountId !== route.accountId ||
      !relay.toolCalls.has(callId) ||
      relay.toolCalls.isAgentCompleted(callId) ||
      relay.toolCalls.hasCancelled(callId) ||
      origin?.originatingChannel !== route.channel ||
      origin.originatingTo !== `room:${route.roomId}` ||
      origin.accountId !== route.accountId ||
      origin.messageThreadId !== route.threadRootEventId
    ) {
      throw new Error("Matrix Talk consultation authority is no longer current");
    }
  };
  assertCurrent(ownerSessionKey, ownerConnId, {
    originatingChannel: route.channel,
    originatingTo: `room:${route.roomId}`,
    accountId: route.accountId,
    messageThreadId: route.threadRootEventId,
  });
  return Object.freeze({
    assertCurrent,
    ...(relay?.speakerMxid ? { speakerMxid: relay.speakerMxid } : {}),
    ...(relay?.speakerMxid
      ? {
          channelContext: Object.freeze({
            sender: Object.freeze({ id: relay.speakerMxid }),
            chat: Object.freeze({
              id: route.roomId,
              talkThreadRootEventId: route.threadRootEventId,
            }),
          }),
        }
      : {}),
  });
}
