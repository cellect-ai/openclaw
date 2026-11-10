// Fi shadow-turn requester attestation (Cellect fork).
//
// Fi wakes a background ("shadow") turn through the authenticated hooks API
// with an opaque attestation it minted and will verify itself. The gateway
// only forwards it: it accepts the field on a `hook:fi-shadow:` session alone,
// keeps it out of the prompt, job payload and transcript, and records it for
// the one isolated run that hook started. Plugin tool and before_agent_reply
// contexts of that run read it back as `hookRequesterAttestation`.

import type { Result } from "@openclaw/normalization-core/result";

export const SHADOW_HOOK_SESSION_PREFIX = "hook:fi-shadow:";
const SHADOW_HOOK_SESSION = /(?:^|:)hook:fi-shadow:/i;
const MAX_ATTESTATION_LENGTH = 256;
const ATTESTATION = /^fsa:[^:\s]{1,200}:[A-Za-z0-9_-]{43}$/;

/** True for a request or run session key that names a Fi shadow hook. */
export function isShadowHookSessionKey(sessionKey: string | undefined | null): boolean {
  return typeof sessionKey === "string" && SHADOW_HOOK_SESSION.test(sessionKey);
}

/** Well-formed attestation token, or undefined. Never echoes the value. */
export function parseHookRequesterAttestation(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= MAX_ATTESTATION_LENGTH &&
    ATTESTATION.test(value)
    ? value
    : undefined;
}

/**
 * The attestation of a `/hooks/agent` request. Both directions are refused:
 * an attestation on any other session, and a shadow session without one.
 */
export function normalizeHookRequesterAttestation(
  payload: Record<string, unknown>,
  sessionKey: string | undefined,
): Result<{ requesterAttestation?: string }, string> {
  const raw = payload.requesterAttestation;
  const shadow = sessionKey?.startsWith(SHADOW_HOOK_SESSION_PREFIX) === true;
  if (raw === undefined) {
    return isShadowHookSessionKey(sessionKey)
      ? { ok: false, error: "requesterAttestation is required on a hook:fi-shadow: session" }
      : { ok: true, value: {} };
  }
  if (!shadow) {
    return {
      ok: false,
      error: "requesterAttestation is only accepted on a hook:fi-shadow: session",
    };
  }
  const attestation = parseHookRequesterAttestation(raw);
  if (!attestation) {
    return { ok: false, error: "requesterAttestation is malformed" };
  }
  return { ok: true, value: { requesterAttestation: attestation } };
}

type Recorded = { sessionKey: string; attestation: string };

// Bounded by live hook-run concurrency; the cap only guards a leaked release.
const MAX_TRACKED_ATTESTATIONS = 512;
const activeAttestations = new Map<string, Recorded>();

/** Records the attestation for one active shadow run; returns its release. */
export function registerHookRequesterAttestation(params: {
  runId: string;
  sessionKey: string;
  attestation: string | undefined;
}): () => void {
  const key = params.runId.trim();
  const attestation = parseHookRequesterAttestation(params.attestation);
  if (!key || !attestation || !isShadowHookSessionKey(params.sessionKey)) {
    return () => {};
  }
  if (activeAttestations.size >= MAX_TRACKED_ATTESTATIONS && !activeAttestations.has(key)) {
    const oldest = activeAttestations.keys().next().value;
    if (oldest !== undefined) {
      activeAttestations.delete(oldest);
    }
  }
  const recorded = { sessionKey: params.sessionKey.trim().toLowerCase(), attestation };
  activeAttestations.set(key, recorded);
  return () => {
    if (activeAttestations.get(key) === recorded) {
      activeAttestations.delete(key);
    }
  };
}

/** The attestation of this exact active shadow run and session, or undefined. */
export function lookupHookRequesterAttestation(
  runId: string | undefined,
  sessionKey: string | undefined,
): string | undefined {
  if (!runId || !sessionKey || !isShadowHookSessionKey(sessionKey)) {
    return undefined;
  }
  const recorded = activeAttestations.get(runId.trim());
  return recorded && recorded.sessionKey === sessionKey.trim().toLowerCase()
    ? recorded.attestation
    : undefined;
}
