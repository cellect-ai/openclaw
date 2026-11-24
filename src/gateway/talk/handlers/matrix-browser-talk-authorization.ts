import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { parseSessionDeliveryRoute } from "../../../routing/session-key.js";
import {
  isUnauthorizedRawMatrixBrowserSession,
  prepareRawMatrixBrowserSessionAuthorization,
} from "../../matrix-browser-session-authorization.js";
import type { GatewayClient } from "../../server-methods/types.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "../../session-utils-store-worker.js";

/**
 * Browser Talk may not reach a Matrix conversation through a raw key. The
 * route proof comes from the current native row (null when it is absent) under
 * the canonical key it resolves to, so a fresh or internal session such as an
 * aliased main is admitted and an alias of a Matrix row is not. The caller
 * revalidates its own owner after awaiting.
 */
export async function prepareTalkMatrixBrowserRefusal(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null | undefined;
  sessionKey: string;
  agentId?: string;
  authorizedByBinding: boolean;
}): Promise<boolean> {
  const facts = {
    cfg: params.cfg,
    clientInfo: params.client?.connect?.client,
    pairedClientId: params.client?.pairedClientId,
    sessionKey: params.sessionKey,
    authorizedByBinding: params.authorizedByBinding,
  };
  if (!isUnauthorizedRawMatrixBrowserSession(facts)) {
    return false;
  }
  // A raw key that itself names a Matrix route stays refused whatever it aliases.
  if (parseSessionDeliveryRoute(params.sessionKey)?.channel?.trim()) {
    return true;
  }
  const { entry, canonicalKey } = await loadGatewaySessionEntryReadOnlyInWorker({
    cfg: params.cfg,
    key: params.sessionKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  // Judge the alias-qualified row under the key the native read resolved it to.
  return prepareRawMatrixBrowserSessionAuthorization({
    ...facts,
    sessionKey: canonicalKey,
    sessionEntry: entry ?? null,
  });
}
