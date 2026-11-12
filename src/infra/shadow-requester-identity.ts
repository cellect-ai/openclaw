// The email Fi resolved for a shadow attestation, kept after the run ends.
//
// The attestation token itself stays opaque and is released when the run
// settles. Announce happens later, as its own operator call, so the only
// identity the gateway may compare an owner email against is the member Fi
// named while resolving that same shadow session. A request email with no
// matching record is refused. Nothing here is written into the prompt.

import { isShadowHookSessionKey } from "./hook-requester-attestation.js";
import { pruneMapToMaxSize } from "./map-size.js";

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const MAX_EMAIL_LENGTH = 254;
// Fi's shadow attestation lives 30 minutes. Announce follows the turn inside that window.
const IDENTITY_TTL_MS = 30 * 60 * 1000;
const MAX_IDENTITIES = 512;
const SHADOW_MARKER = "hook:fi-shadow:";

type RecordedIdentity = { email: string; expiresAt: number };

const identities = new Map<string, RecordedIdentity>();

/** The `hook:fi-shadow:` tail, so a bare key and its agent-qualified form match. */
function canonicalShadowKey(sessionKey: string): string | undefined {
  if (!isShadowHookSessionKey(sessionKey)) {
    return undefined;
  }
  const normalized = sessionKey.trim().toLowerCase();
  const index = normalized.indexOf(SHADOW_MARKER);
  return index === -1 ? undefined : normalized.slice(index);
}

function pruneExpired(now: number): void {
  for (const [key, recorded] of identities) {
    if (recorded.expiresAt <= now) {
      identities.delete(key);
    }
  }
}

/**
 * Records the member Fi resolved for this shadow session.
 * A non-shadow key or a value that is not a plain address is ignored.
 */
export function registerShadowRequesterIdentity(sessionKey: string, email: string): void {
  const key = canonicalShadowKey(sessionKey);
  const normalized = email.trim().toLowerCase();
  if (!key || normalized.length > MAX_EMAIL_LENGTH || !EMAIL.test(normalized)) {
    return;
  }
  const now = Date.now();
  pruneExpired(now);
  if (!identities.has(key) && identities.size >= MAX_IDENTITIES) {
    pruneMapToMaxSize(identities, MAX_IDENTITIES - 1);
  }
  identities.set(key, { email: normalized, expiresAt: now + IDENTITY_TTL_MS });
}

/** The attested requester email for this shadow session, or undefined when none is current. */
export function lookupShadowRequesterIdentity(sessionKey: string): string | undefined {
  const key = canonicalShadowKey(sessionKey);
  if (!key) {
    return undefined;
  }
  const recorded = identities.get(key);
  if (!recorded) {
    return undefined;
  }
  if (recorded.expiresAt <= Date.now()) {
    identities.delete(key);
    return undefined;
  }
  return recorded.email;
}
