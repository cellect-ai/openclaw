import {
  ErrorCodes,
  errorShape,
  validateChatHandoffArmParams,
  validateChatHandoffSeenParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { isWebchatClient } from "../../utils/message-channel.js";
import { markWebchatCompletionSeen } from "../webchat-completion-delivery-send.js";
import { armWebchatCompletionDelivery } from "../webchat-completion-delivery.js";
import { canRequesterAbortChatRun, resolveChatAbortRequester } from "./chat-abort-authorization.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { assertValidParams } from "./validation.js";

export async function handleChatHandoffArm({
  params,
  respond,
  context,
  client,
}: GatewayRequestHandlerOptions): Promise<void> {
  if (!assertValidParams(params, validateChatHandoffArmParams, "chat.handoff.arm", respond)) {
    return;
  }
  if (!isWebchatClient(client?.connect?.client)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "WebChat client required"));
    return;
  }
  const active = context.chatAbortControllers.get(params.runId as string);
  if (
    !active ||
    active.kind === "agent" ||
    active.controlUiVisible === false ||
    !active.webchatCompletionDelivery
  ) {
    respond(true, { ok: true, armed: false });
    return;
  }
  if (
    !canRequesterAbortChatRun(active, resolveChatAbortRequester(client), {
      requireOwnerMatch: true,
    })
  ) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
    return;
  }
  armWebchatCompletionDelivery(active.webchatCompletionDelivery);
  respond(true, {
    ok: true,
    armed: active.webchatCompletionDelivery.armedAtMs !== undefined,
  });
}

export async function handleChatHandoffSeen({
  params,
  respond,
  context,
  client,
}: GatewayRequestHandlerOptions): Promise<void> {
  if (!assertValidParams(params, validateChatHandoffSeenParams, "chat.handoff.seen", respond)) {
    return;
  }
  if (!isWebchatClient(client?.connect?.client)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "WebChat client required"));
    return;
  }
  const requester = resolveChatAbortRequester(client);
  const runId = typeof params.runId === "string" ? params.runId : undefined;
  const sessionKey = params.sessionKey as string;
  const pendingResult = await markWebchatCompletionSeen({
    runId,
    sessionKey,
    requesterConnId: requester.connId,
    requesterDeviceId: requester.deviceId,
  });
  if (pendingResult === "unauthorized") {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
    return;
  }
  if (pendingResult === "seen") {
    respond(true, { ok: true, seen: true });
    return;
  }
  const active = runId ? context.chatAbortControllers.get(runId) : undefined;
  if (!active || active.sessionKey !== sessionKey || !active.webchatCompletionDelivery) {
    respond(true, { ok: true, seen: false });
    return;
  }
  if (
    !canRequesterAbortChatRun(active, requester, {
      requireOwnerMatch: true,
    })
  ) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
    return;
  }
  active.webchatCompletionDelivery.seenAtMs = Date.now();
  respond(true, { ok: true, seen: true });
}
