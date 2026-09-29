import type { GatewayClientInfo } from "../../packages/gateway-protocol/src/client-info.js";
import { extractDeliveryInfo } from "../config/sessions/delivery-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseSessionDeliveryRoute } from "../routing/session-key.js";
import { isBrowserOperatorUiClient, isWebchatClient } from "../utils/message-channel.js";

/**
 * Matrix session keys contain channel locators and are not browser authority.
 * A browser may mutate one only after an app-authorized binding has been
 * redeemed and pinned by the owning operation.
 */
export function isUnauthorizedRawMatrixBrowserSession(params: {
  cfg: OpenClawConfig;
  clientInfo?: GatewayClientInfo | null;
  pairedClientId?: string;
  sessionKey: string;
  authorizedByBinding: boolean;
}): boolean {
  if (params.authorizedByBinding) {
    return false;
  }
  const approvedClientInfo = params.pairedClientId
    ? { ...params.clientInfo, id: params.pairedClientId }
    : params.clientInfo;
  if (!isWebchatClient(approvedClientInfo) && !isBrowserOperatorUiClient(approvedClientInfo)) {
    return false;
  }
  const channel =
    parseSessionDeliveryRoute(params.sessionKey)?.channel ??
    extractDeliveryInfo(params.sessionKey, { cfg: params.cfg }).deliveryContext?.channel;
  return channel?.trim().toLowerCase() === "matrix";
}
