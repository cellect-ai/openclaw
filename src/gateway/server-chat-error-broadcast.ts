import type { ChatEvent } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import {
  findDispatchOwnedChatErrorSource,
  getRpcSource,
} from "../sessions/session-controller.rpc-sources.js";
import { claimChatErrorTerminalBroadcast } from "./chat-abort-lifecycle-internal.js";
import type {
  GatewayBroadcastFn,
  GatewayBroadcastOpts,
  GatewayBroadcastToConnIdsFn,
} from "./server-broadcast-types.js";

/** False when this error frame was already sent for the source. Other events pass through. */
function claimDeliveredChatError(
  event: "agent" | "chat",
  payload: ChatEvent | AgentEventPayload,
): boolean {
  return !(
    event === "chat" &&
    "state" in payload &&
    payload.state === "error" &&
    !claimChatErrorTerminalBroadcast(payload.runId)
  );
}

export function deliverLiveChatPayload(params: {
  event: "agent" | "chat";
  payload: ChatEvent | AgentEventPayload;
  visible: boolean;
  broadcastOpts: GatewayBroadcastOpts;
  deliverySessionKeys: string[] | undefined;
  broadcast: GatewayBroadcastFn;
  nodeSendToSession: (
    sessionKey: string,
    event: string,
    payload: unknown,
    opts?: GatewayBroadcastOpts,
  ) => void;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  subscribers: (deliveryKey: string) => Iterable<string>;
}): boolean {
  const { event, payload, broadcastOpts } = params;
  if (params.visible) {
    if (!claimDeliveredChatError(event, payload)) {
      return false;
    }
    params.broadcast(event, payload, broadcastOpts);
    const firstDeliveryKey = params.deliverySessionKeys?.[0];
    if (firstDeliveryKey) {
      params.nodeSendToSession(firstDeliveryKey, event, payload, broadcastOpts);
    }
    return true;
  }
  const recipients = new Set<string>();
  for (const deliveryKey of params.deliverySessionKeys ?? []) {
    for (const connId of params.subscribers(deliveryKey)) {
      recipients.add(connId);
    }
  }
  if (recipients.size === 0) {
    return true;
  }
  if (!claimDeliveredChatError(event, payload)) {
    return false;
  }
  params.broadcastToConnIds(event, payload, recipients, {
    ...broadcastOpts,
    sessionSubscriptionVerified: true,
  });
  return true;
}

/**
 * A dispatch-owned terminal persists natively and broadcasts one client error.
 * Lifecycle must not add a second frame, including an abort-classified one.
 */
export function skipOwnedChatError(
  runId: string,
  hasChatLink: boolean,
  delegateChatError: (runId: string) => boolean,
  terminalState?: string,
): boolean {
  // Success and yielded-final frames stay with lifecycle. An owned failure may be
  // classified aborted; that frame would contradict the dispatch error broadcast.
  if (terminalState !== undefined && terminalState !== "error" && terminalState !== "aborted") {
    return false;
  }
  const source = findDispatchOwnedChatErrorSource(runId) ?? getRpcSource(runId);
  const dispatchOwnsTerminal = source?.adapter.dispatchOwnsChatErrorTerminal === true;
  if (dispatchOwnsTerminal && source) {
    source.adapter.chatErrorDispatchOwned = true;
  }
  if (dispatchOwnsTerminal) {
    return true;
  }
  return terminalState !== "aborted" && !hasChatLink && delegateChatError(runId);
}
