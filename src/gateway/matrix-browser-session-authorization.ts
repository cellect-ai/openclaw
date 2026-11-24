import type { GatewayClientInfo } from "../../packages/gateway-protocol/src/client-info.js";
import { extractDeliveryInfo } from "../config/sessions/delivery-info.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isUnscopedSessionKeySentinel,
  parseAgentSessionKey,
  parseSessionDeliveryRoute,
} from "../routing/session-key.js";
import { sessionDeliveryChannel, sessionDeliveryRoute } from "../utils/delivery-context.read.js";
import { isBrowserOperatorUiClient, isWebchatClient } from "../utils/message-channel.js";
import type { GatewayClient } from "./server-methods/types.js";
import { isWebchatSessionAllowed } from "./webchat-agent-authorization.js";

/**
 * Matrix session keys contain channel locators and are not browser authority.
 * A browser may mutate one only after an app-authorized binding has been
 * redeemed and pinned by the owning operation.
 */
type MatrixBrowserSessionAuthorization = {
  cfg: OpenClawConfig;
  clientInfo?: GatewayClientInfo | null;
  pairedClientId?: string;
  sessionKey: string;
  authorizedByBinding: boolean;
  /** Channel from the current native session row, never from the browser request. */
  deliveryChannel?: string;
  /** null is absence proven by the caller's current, alias-qualified native read owner. */
  sessionEntry?: SessionEntry | null;
};

export function isUnauthorizedRawMatrixBrowserSession(
  params: MatrixBrowserSessionAuthorization,
): boolean {
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
    params.deliveryChannel ??
    sessionDeliveryRoute(params.sessionEntry ?? undefined)?.channel ??
    sessionDeliveryChannel(params.sessionEntry ?? undefined);
  if (channel?.trim()) {
    return channel.trim().toLowerCase() === "matrix";
  }
  if (params.sessionEntry === null) {
    return false;
  }
  // Agent-qualified keys and the unscoped global/unknown sentinels are canonical, so a
  // current native row under one with no external route is an internal session.
  const canonical =
    Boolean(parseAgentSessionKey(params.sessionKey)?.agentId) ||
    isUnscopedSessionKeySentinel(params.sessionKey);
  if (params.sessionEntry && canonical && params.sessionEntry.delivery?.kind !== "external") {
    return false;
  }
  // An unproven existing route cannot acquire owning-app authority through a missing channel.
  return true;
}

/** Prepare detached route facts; the caller must revalidate its native read owner after awaiting. */
export async function prepareRawMatrixBrowserSessionAuthorization(
  params: MatrixBrowserSessionAuthorization,
): Promise<boolean> {
  if (!isUnauthorizedRawMatrixBrowserSession(params)) {
    return false;
  }
  if (
    parseSessionDeliveryRoute(params.sessionKey)?.channel ||
    params.deliveryChannel ||
    params.sessionEntry !== undefined
  ) {
    return true;
  }
  const info = await extractDeliveryInfo(params.sessionKey, { cfg: params.cfg });
  return isUnauthorizedRawMatrixBrowserSession({
    ...params,
    deliveryChannel: info.deliveryContext?.channel,
  });
}

/** Apply custom device and owning-app boundaries inside a native synchronous publication frame. */
export function isBrowserSessionReadAllowed(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null | undefined;
  sessionKey: string;
  sessionEntry?: SessionEntry | null;
}): boolean {
  return (
    isWebchatSessionAllowed(params) &&
    !isUnauthorizedRawMatrixBrowserSession({
      ...params,
      clientInfo: params.client?.connect.client,
      pairedClientId: params.client?.pairedClientId,
      authorizedByBinding: false,
    })
  );
}

export function requiresBrowserSessionReadBoundary(
  client: GatewayClient | null | undefined,
): boolean {
  const info = client?.pairedClientId
    ? { ...client.connect.client, id: client.pairedClientId }
    : client?.connect.client;
  return (
    client?.allowedAgentIds !== undefined ||
    isWebchatClient(info) ||
    isBrowserOperatorUiClient(info)
  );
}
