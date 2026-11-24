import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  resolveRequestedSessionAgentId,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "../session-request-agent.js";
import { resolveSessionStoreKey } from "../session-utils.js";
import { respondError } from "./response.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export function resolveChatAbortRequestTarget({
  params,
  respond,
  abortCfg,
}: {
  params: import("../../../packages/gateway-protocol/src/index.js").ChatAbortParams;
  respond: GatewayRequestHandlerOptions["respond"];
  abortCfg: ReturnType<GatewayRequestHandlerOptions["context"]["getRuntimeConfig"]>;
}) {
  const rawSessionKey = params.sessionKey;
  const agentIdOverride = normalizeOptionalString(params.agentId);
  const parsedAbortSessionKey = parseAgentSessionKey(rawSessionKey);
  const compatibilityDefaultAgentId = tryResolveSessionCompatibilityOwnerAgentId(
    abortCfg,
    rawSessionKey,
  );
  const bareSessionAgentResolution = !parsedAbortSessionKey
    ? resolveRequestedSessionAgentId(abortCfg, rawSessionKey, agentIdOverride)
    : undefined;
  if (bareSessionAgentResolution && !bareSessionAgentResolution.ok) {
    respond(false, undefined, bareSessionAgentResolution.error);
    return;
  }
  const abortAgentId = parsedAbortSessionKey
    ? (agentIdOverride ?? normalizeAgentId(parsedAbortSessionKey.agentId))
    : bareSessionAgentResolution?.agentId;
  if (!abortAgentId) {
    respondError(
      respond,
      ErrorCodes.INVALID_REQUEST,
      rawSessionKey.trim().toLowerCase() === "global"
        ? "agentId is required for global chat.abort when no compatibility owner exists"
        : "agentId is required for unscoped chat.abort when no compatibility owner exists",
    );
    return;
  }
  if (
    agentIdOverride &&
    parsedAbortSessionKey &&
    normalizeAgentId(parsedAbortSessionKey.agentId) !== normalizeAgentId(agentIdOverride)
  ) {
    respondError(
      respond,
      ErrorCodes.INVALID_REQUEST,
      `agentId "${agentIdOverride}" does not match session key "${rawSessionKey}"`,
    );
    return;
  }
  const canonicalAbortSessionKey = resolveSessionStoreKey({
    cfg: abortCfg,
    sessionKey: rawSessionKey,
    storeAgentId: abortAgentId,
  });
  return { abortAgentId, canonicalAbortSessionKey, compatibilityDefaultAgentId };
}
