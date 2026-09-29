import { createHash } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  validateConversationContinueParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveMatrixTalkBinding } from "../talk-matrix-binding.js";
import { deliverWebchatCompletionFallback } from "../webchat-completion-delivery-send.js";
import {
  verifyWebchatCompletionDeliveryClaim,
  WEBCHAT_COMPLETION_DELIVERY_SECRET_ENV,
} from "../webchat-completion-delivery.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { assertValidParams } from "./validation.js";

export async function handleConversationContinue({
  params,
  respond,
  context,
}: GatewayRequestHandlerOptions): Promise<void> {
  if (
    !assertValidParams(params, validateConversationContinueParams, "conversation.continue", respond)
  ) {
    return;
  }
  const source = params.source as {
    channel: "matrix";
    roomId: string;
    threadRootEventId: string;
    agentMxid: string;
  };
  const cfg = context.getRuntimeConfig();
  let sourceBinding: Awaited<ReturnType<typeof resolveMatrixTalkBinding>>;
  try {
    sourceBinding = await resolveMatrixTalkBinding({ cfg, ...source });
  } catch {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Matrix conversation is not bound to an agent"),
    );
    return;
  }
  const { agentId } = sourceBinding;
  const route = verifyWebchatCompletionDeliveryClaim({
    claim: params.destinationClaim as string,
    secret: process.env[WEBCHAT_COMPLETION_DELIVERY_SECRET_ENV],
    expectedAgentId: agentId,
  });
  if (!route || route.channel !== "slack" || !/^user:[^:]+$/i.test(route.to.trim())) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "invalid private Slack destination"),
    );
    return;
  }
  const intent = createHash("sha256")
    .update(sourceBinding.sessionKey)
    .update("\0")
    .update(route.channel)
    .update("\0")
    .update(route.accountId ?? "default")
    .update("\0")
    .update(route.to)
    .digest("hex");
  const result = await deliverWebchatCompletionFallback({
    cfg,
    state: { route, armedAtMs: 0 },
    startedAtMs: 0,
    nowMs: Date.now(),
    runId: `conversation-continue:${intent}`,
    sessionId: source.threadRootEventId,
    sessionKey: sourceBinding.sessionKey,
    agentId,
    ctx: { SessionKey: sourceBinding.sessionKey },
    replies: [{ kind: "final", payload: { text: "This conversation is ready in Slack." } }],
    deliveryIntentId: `conversation-continue:${intent}`,
    continuationMarker: true,
    log: { warn: (message) => context.logGateway.warn(message) },
  });
  if (result !== "handled") {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "continuation delivery failed"));
    return;
  }
  respond(true, { status: "continued" });
}
