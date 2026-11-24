import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { isWebchatClient } from "../../utils/message-channel.js";
import {
  armWebchatCompletionDelivery,
  verifyWebchatCompletionDeliveryClaim,
  WEBCHAT_COMPLETION_DELIVERY_SECRET_ENV,
  type WebchatCompletionDeliveryState,
} from "../webchat-completion-delivery.js";
import type { ChatSendAdmissionParams } from "./chat-send-pre-admission.types.js";

export function prepareChatCompletionDelivery(params: ChatSendAdmissionParams) {
  const { request, session, respond, context, client } = params;
  const { p } = request;
  const { selectedAgent, agentId } = session;
  let webchatCompletionDelivery: WebchatCompletionDeliveryState | undefined;
  if (p.completionDeliveryClaim) {
    if (!isWebchatClient(request.clientInfo)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "completion delivery claims are limited to WebChat clients",
        ),
      );
      return { ok: false as const };
    }
    const route = verifyWebchatCompletionDeliveryClaim({
      claim: p.completionDeliveryClaim,
      secret: process.env[WEBCHAT_COMPLETION_DELIVERY_SECRET_ENV],
      expectedAgentId: selectedAgent.agentId ?? agentId,
    });
    if (!route) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid completion delivery claim"),
      );
      return { ok: false as const };
    }
    webchatCompletionDelivery = { route };
    const ownerConnId = normalizeOptionalString(client?.connId);
    if (ownerConnId && context.isConnectionActive?.(ownerConnId) === false) {
      armWebchatCompletionDelivery(webchatCompletionDelivery);
    }
  }
  return { ok: true as const, webchatCompletionDelivery };
}
