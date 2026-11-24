import {
  ErrorCodes,
  errorShape,
  validateChatHandoffArmParams,
  validateChatHandoffSeenParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  getRpcSourceForGateway,
  getRpcSourceIdentity,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import { isWebchatClient } from "../../utils/message-channel.js";
import { isWebchatSessionAllowed } from "../webchat-agent-authorization.js";
import { markWebchatCompletionSeen } from "../webchat-completion-delivery-send.js";
import { armWebchatCompletionDelivery } from "../webchat-completion-delivery.js";
import { resolveChatAbortRequester, type ChatAbortRequester } from "./chat-abort-authorization.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { assertValidParams } from "./validation.js";

function isApprovedWebchat(options: GatewayRequestHandlerOptions) {
  const { client } = options;
  return isWebchatClient(
    client?.pairedClientId
      ? { ...client.connect.client, id: client.pairedClientId }
      : client?.connect.client,
  );
}

function assertRequesterCurrent(options: GatewayRequestHandlerOptions, sessionKey: string) {
  options.signal?.throwIfAborted();
  options.sessionMutationAuthorization?.assertCurrent();
  if (
    options.client?.invalidated ||
    options.hasCurrentClientAuthority?.() === false ||
    !isApprovedWebchat(options) ||
    !isWebchatSessionAllowed({
      cfg: (options.context.getCommittedRuntimeConfig ?? options.context.getRuntimeConfig)(),
      client: options.client,
      sessionKey,
    })
  ) {
    throw new Error("Webchat handoff authority is no longer active");
  }
}

function isOriginalViewer(source: RpcSourceRef, requester: ChatAbortRequester): boolean {
  const owner = source.adapter.requester;
  return owner?.deviceId
    ? owner.deviceId === requester.deviceId
    : Boolean(owner?.connectionId && owner.connectionId === requester.connId);
}

export async function handleChatHandoffArm(options: GatewayRequestHandlerOptions): Promise<void> {
  const { params, respond, context, client } = options;
  if (!assertValidParams(params, validateChatHandoffArmParams, "chat.handoff.arm", respond)) return;
  if (!isApprovedWebchat(options)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "WebChat client required"));
    return;
  }
  const active = getRpcSourceForGateway(params.runId as string, context.resolveGatewayContext);
  const state = active?.adapter.webchatCompletionDelivery;
  if (
    !active ||
    active.adapter.kind === "agent" ||
    active.adapter.controlUiVisible === false ||
    !state
  ) {
    respond(true, { ok: true, armed: false });
    return;
  }
  // Handoff is the original viewer's acknowledgement, not an admin cancellation privilege.
  const requester = { ...resolveChatAbortRequester(client), isAdmin: false };
  if (!isOriginalViewer(active, requester)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
    return;
  }
  assertRequesterCurrent(options, getRpcSourceIdentity(active).sessionKey);
  armWebchatCompletionDelivery(state);
  respond(true, { ok: true, armed: state.armedAtMs !== undefined });
}

export async function handleChatHandoffSeen(options: GatewayRequestHandlerOptions): Promise<void> {
  const { params, respond, context, client } = options;
  if (!assertValidParams(params, validateChatHandoffSeenParams, "chat.handoff.seen", respond))
    return;
  if (!isApprovedWebchat(options)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "WebChat client required"));
    return;
  }
  const requester = { ...resolveChatAbortRequester(client), isAdmin: false };
  const runId = typeof params.runId === "string" ? params.runId : undefined;
  const sessionKey = params.sessionKey as string;
  const assertCurrent = () => {
    assertRequesterCurrent(options, sessionKey);
    const current = resolveChatAbortRequester(client);
    if (current.connId !== requester.connId || current.deviceId !== requester.deviceId) {
      throw new Error("Webchat handoff requester changed");
    }
  };
  assertCurrent();
  const pendingResult = await markWebchatCompletionSeen({
    runId,
    sessionKey,
    requesterConnId: requester.connId,
    requesterDeviceId: requester.deviceId,
    assertCurrent,
  });
  assertCurrent();
  if (pendingResult === "unauthorized") {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
    return;
  }
  if (pendingResult === "seen") {
    respond(true, { ok: true, seen: true });
    return;
  }
  const active = runId ? getRpcSourceForGateway(runId, context.resolveGatewayContext) : undefined;
  const state = active?.adapter.webchatCompletionDelivery;
  if (
    !active ||
    getRpcSourceIdentity(active).sessionKey !== sessionKey ||
    active.adapter.kind === "agent" ||
    active.adapter.controlUiVisible === false ||
    !state
  ) {
    respond(true, { ok: true, seen: false });
    return;
  }
  if (!isOriginalViewer(active, requester)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
    return;
  }
  assertCurrent();
  state.seenAtMs = Date.now();
  respond(true, { ok: true, seen: true });
}
