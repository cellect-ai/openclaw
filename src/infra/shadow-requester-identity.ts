// The email Fi resolved for a shadow attestation, kept after the run ends.
//
// The attestation token itself stays opaque and is released when the run
// settles. Announce happens later, as its own operator call, so the only
// identity the gateway may compare an owner email against is the member Fi
// named while resolving that same shadow session. A request email with no
// matching record is refused. Nothing here is written into the prompt.

import { createCorePluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import { isShadowHookSessionKey } from "./hook-requester-attestation.js";

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const MAX_EMAIL_LENGTH = 254;
// Fi's shadow attestation lives 30 minutes. Announce follows the turn inside that window.
const IDENTITY_TTL_MS = 30 * 60 * 1000;
const MAX_IDENTITIES = 512;
const SHADOW_MARKER = "hook:fi-shadow:";

type RecordedIdentity = { email: string; expiresAt: number };

// Tool execution and announce RPCs can live in different workers. The canonical
// state owner shares only the resolved email and expiry, never the attestation.
const identityStore = () =>
  createCorePluginStateKeyedStore<RecordedIdentity>({
    ownerId: "core:fi-shadow-requester",
    namespace: "requester-identities",
    maxEntries: MAX_IDENTITIES,
    defaultTtlMs: IDENTITY_TTL_MS,
  });

/** The `hook:fi-shadow:` tail, so a bare key and its agent-qualified form match. */
function canonicalShadowKey(sessionKey: string): string | undefined {
  if (!isShadowHookSessionKey(sessionKey)) {
    return undefined;
  }
  const normalized = sessionKey.trim().toLowerCase();
  const index = normalized.indexOf(SHADOW_MARKER);
  return index === -1 ? undefined : normalized.slice(index);
}

/**
 * Records the member Fi resolved for this shadow session.
 * A non-shadow key or a value that is not a plain address is ignored.
 */
export async function registerShadowRequesterIdentity(
  sessionKey: string,
  email: string,
): Promise<void> {
  const key = canonicalShadowKey(sessionKey);
  const normalized = email.trim().toLowerCase();
  if (!key || normalized.length > MAX_EMAIL_LENGTH || !EMAIL.test(normalized)) {
    return;
  }
  await identityStore().register(key, {
    email: normalized,
    expiresAt: Date.now() + IDENTITY_TTL_MS,
  });
}

/** The attested requester email for this shadow session, or undefined when none is current. */
export async function lookupShadowRequesterIdentity(
  sessionKey: string,
): Promise<string | undefined> {
  const key = canonicalShadowKey(sessionKey);
  if (!key) {
    return undefined;
  }
  const recorded = await identityStore().lookup(key);
  if (!recorded) {
    return undefined;
  }
  if (
    typeof recorded.email !== "string" ||
    !EMAIL.test(recorded.email) ||
    !Number.isFinite(recorded.expiresAt) ||
    recorded.expiresAt <= Date.now()
  ) {
    return undefined;
  }
  return recorded.email;
}
