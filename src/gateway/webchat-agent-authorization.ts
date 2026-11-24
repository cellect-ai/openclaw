import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentIdStrict, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveSessionStoreAgentId, resolveSessionStoreKey } from "./session-store-key.js";

export type WebchatAgentCeilingClient = {
  allowedAgentIds?: readonly string[];
};

function normalizeExplicitAgentId(agentId: string): string | null {
  const normalized = normalizeAgentIdStrict(agentId);
  return normalized.ok ? normalized.value : null;
}

/**
 * Applies the server-attested agent ceiling carried by a webchat device.
 * Clients without a ceiling retain the existing unrestricted behavior.
 */
export function isWebchatAgentAllowed(
  client: WebchatAgentCeilingClient | null | undefined,
  agentId: string,
): boolean {
  const ceiling = client?.allowedAgentIds;
  if (ceiling === undefined) {
    return true;
  }
  const requestedAgentId = normalizeExplicitAgentId(agentId);
  if (!requestedAgentId) {
    return false;
  }
  return ceiling.some(
    (allowedAgentId) => normalizeExplicitAgentId(allowedAgentId) === requestedAgentId,
  );
}

/**
 * Resolves session ownership from the canonical store key, never from mutable
 * delivery metadata such as lastChannel or accountId. Invalid or ambiguous
 * keys have no authorizable owner.
 */
export function resolveWebchatSessionAgentId(
  cfg: OpenClawConfig,
  sessionKey: string,
): string | null {
  const raw = sessionKey.trim();
  if (!raw) {
    return null;
  }
  if (raw.toLowerCase().startsWith("agent:") && !parseAgentSessionKey(raw)) {
    return null;
  }
  try {
    const canonicalKey = resolveSessionStoreKey({ cfg, sessionKey: raw });
    return normalizeExplicitAgentId(resolveSessionStoreAgentId(cfg, canonicalKey));
  } catch {
    return null;
  }
}

/** Fail-closed session authorization for clients carrying a webchat ceiling. */
export function isWebchatSessionAllowed(params: {
  cfg: OpenClawConfig;
  client: WebchatAgentCeilingClient | null | undefined;
  sessionKey: string;
}): boolean {
  if (params.client?.allowedAgentIds === undefined) {
    return true;
  }
  const ownerAgentId = resolveWebchatSessionAgentId(params.cfg, params.sessionKey);
  return ownerAgentId !== null && isWebchatAgentAllowed(params.client, ownerAgentId);
}
