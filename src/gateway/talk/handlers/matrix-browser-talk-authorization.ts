import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  isUnauthorizedRawMatrixBrowserSession,
  prepareRawMatrixBrowserSessionAuthorization,
} from "../../matrix-browser-session-authorization.js";
import type { GatewayClient } from "../../server-methods/types.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "../../session-utils-store-worker.js";

/**
 * Browser Talk may not reach a Matrix conversation through a raw key. The
 * route proof comes from the current native row (null when it is absent), so
 * a fresh internal session is admitted and an unrouted alias of a Matrix row
 * is not. The caller revalidates its own owner after awaiting.
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
  const { entry } = await loadGatewaySessionEntryReadOnlyInWorker({
    cfg: params.cfg,
    key: params.sessionKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  return prepareRawMatrixBrowserSessionAuthorization({ ...facts, sessionEntry: entry ?? null });
}
