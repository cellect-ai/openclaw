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
const SHADOW_HOOK_SESSION = /(?:^|:)hook:fi-(?:shadow|rfi|co):/i;
const MAX_ATTESTATION_LENGTH = 256;
const ATTESTATION = /^(?:fsa|fcw):[^:\s]{1,200}:[A-Za-z0-9_-]{43}$/;
const REVIEW_SESSION = /^(?:agent:cellect-fi-user:)?hook:fi-review:[a-f0-9]{40}$/i;
const REVIEW_ATTESTATION = /^pra:[A-Za-z0-9_-]{1,100}:[A-Za-z0-9_-]{43}$/;
export function isPersonalReviewHookSessionKey(sessionKey: string | undefined | null): boolean {
  return typeof sessionKey === "string" && REVIEW_SESSION.test(sessionKey);
}
export function isAttestedBackgroundHookSessionKey(sessionKey: string | undefined | null): boolean {
  return isShadowHookSessionKey(sessionKey) || isPersonalReviewHookSessionKey(sessionKey);
}

/** True for a request or run session key that names a Fi shadow hook. */
export function isShadowHookSessionKey(sessionKey: string | undefined | null): boolean {
  return typeof sessionKey === "string" && SHADOW_HOOK_SESSION.test(sessionKey);
}

/** Well-formed attestation token, or undefined. Never echoes the value. */
export function parseHookRequesterAttestation(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= MAX_ATTESTATION_LENGTH &&
    (ATTESTATION.test(value) || REVIEW_ATTESTATION.test(value))
    ? value
    : undefined;
}

/** Every ingress and active-run owner keeps each opaque receipt in its purpose. */
function attestationPurposeMatches(
  sessionKey: string | undefined | null,
  receipt: string,
): boolean {
  if (isPersonalReviewHookSessionKey(sessionKey)) {
    return REVIEW_ATTESTATION.test(receipt);
  }
  return (
    isShadowHookSessionKey(sessionKey) &&
    (/hook:fi-co:/i.test(sessionKey ?? "")
      ? receipt.startsWith("fcw:")
      : receipt.startsWith("fsa:"))
  );
}
export function hookRequesterScopeAllowed(
  value: { requesterAttestation?: unknown; effectiveAgentId: string },
  sessionKey: string,
): boolean {
  if (value.requesterAttestation === undefined) {
    return !isAttestedBackgroundHookSessionKey(sessionKey);
  }
  const receipt = parseHookRequesterAttestation(value.requesterAttestation);
  return Boolean(
    receipt &&
    attestationPurposeMatches(sessionKey, receipt) &&
    (!isPersonalReviewHookSessionKey(sessionKey) || value.effectiveAgentId === "cellect-fi-user"),
  );
}

/** The first delivery or content-trust field a shadow request may not carry. */
function shadowHookDeliveryKnob(payload: Record<string, unknown>): string | undefined {
  if (payload.deliver === true) {
    return "deliver";
  }
  for (const key of ["channel", "to", "accountId"]) {
    if (payload[key] !== undefined) {
      return key;
    }
  }
  const unsafe = payload.allowUnsafeExternalContent;
  return unsafe !== undefined && unsafe !== false ? "allowUnsafeExternalContent" : undefined;
}

/**
 * The attestation of a `/hooks/agent` request. Both directions are refused:
 * an attestation on any other session, and a shadow session without one.
 */
export function normalizeHookRequesterAttestation(
  payload: Record<string, unknown>,
  sessionKey: string | undefined,
): Result<
  { requesterAttestation?: string; requesterEnvironment?: "dev" | "staging" | "prod" },
  string
> {
  const raw = payload.requesterAttestation;
  if (isPersonalReviewHookSessionKey(sessionKey)) {
    const knob = shadowHookDeliveryKnob(payload);
    if (knob) {
      return { ok: false, error: `${knob} is not accepted on a hook:fi-review: session` };
    }
    if (raw === undefined) {
      return { ok: false, error: "requesterAttestation is required on a hook:fi-review: session" };
    }
    if (
      typeof raw !== "string" ||
      raw.length > MAX_ATTESTATION_LENGTH ||
      !REVIEW_ATTESTATION.test(raw)
    ) {
      return { ok: false, error: "requesterAttestation is malformed" };
    }
    return { ok: true, value: { requesterAttestation: raw } };
  }
  const construction = /(?:^|:)hook:fi-(?:rfi|co):/i.test(sessionKey ?? "");
  const environment = payload.requesterEnvironment;
  const mail = /^hook:fi-mail:/i.test(sessionKey ?? "");
  if (
    construction
      ? typeof environment !== "string" || !["dev", "staging", "prod"].includes(environment)
      : environment !== undefined &&
        (!mail ||
          typeof environment !== "string" ||
          !["dev", "staging", "prod"].includes(environment))
  ) {
    return {
      ok: false,
      error: "requesterEnvironment requires a Fi source hook and a supported environment",
    };
  }
  if (isShadowHookSessionKey(sessionKey)) {
    // A shadow turn is silent background work: nothing it produces is routed,
    // delivered or trusted as external content by the caller's say-so.
    const knob = shadowHookDeliveryKnob(payload);
    if (knob) {
      return { ok: false, error: `${knob} is not accepted on a hook:fi-shadow: session` };
    }
  }
  const shadow = isShadowHookSessionKey(sessionKey);
  if (raw === undefined) {
    return isShadowHookSessionKey(sessionKey)
      ? { ok: false, error: "requesterAttestation is required on a hook:fi-shadow: session" }
      : {
          ok: true,
          value:
            mail && environment
              ? { requesterEnvironment: environment as "dev" | "staging" | "prod" }
              : {},
        };
  }
  if (!shadow) {
    return {
      ok: false,
      error: "requesterAttestation is only accepted on a hook:fi-shadow: session",
    };
  }
  const attestation = parseHookRequesterAttestation(raw);
  if (!attestation || !attestationPurposeMatches(sessionKey, attestation)) {
    return { ok: false, error: "requesterAttestation is malformed" };
  }
  return {
    ok: true,
    value: {
      requesterAttestation: attestation,
      ...(construction ? { requesterEnvironment: environment as "dev" | "staging" | "prod" } : {}),
    },
  };
}

type Recorded = {
  sessionKey: string;
  attestation: string;
  environment?: "dev" | "staging" | "prod";
};

// Bounded by live hook-run concurrency; the cap only guards a leaked release.
const MAX_TRACKED_ATTESTATIONS = 512;
const activeAttestations = new Map<string, Recorded>();

/** Records the attestation for one active shadow run; returns its release. */
export function registerHookRequesterAttestation(params: {
  runId: string;
  sessionKey: string;
  attestation: string | undefined;
  environment?: "dev" | "staging" | "prod";
}): () => void {
  const key = params.runId.trim();
  const attestation = parseHookRequesterAttestation(params.attestation);
  if (
    /(?:^|:)hook:fi-(?:rfi|co):/i.test(params.sessionKey) &&
    !["dev", "staging", "prod"].includes(params.environment ?? "")
  ) {
    return () => {};
  }
  if (!key || !attestation || !attestationPurposeMatches(params.sessionKey, attestation)) {
    return () => {};
  }
  if (activeAttestations.size >= MAX_TRACKED_ATTESTATIONS && !activeAttestations.has(key)) {
    const oldest = activeAttestations.keys().next().value;
    if (oldest !== undefined) {
      activeAttestations.delete(oldest);
    }
  }
  const recorded: Recorded = {
    sessionKey: params.sessionKey.trim().toLowerCase(),
    attestation,
    environment: params.environment,
  };
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
  if (!runId || !sessionKey || !isAttestedBackgroundHookSessionKey(sessionKey)) {
    return undefined;
  }
  const recorded = activeAttestations.get(runId.trim());
  return recorded && recorded.sessionKey === sessionKey.trim().toLowerCase()
    ? recorded.attestation
    : undefined;
}

/** Host metadata follows the same exact run/session custody as its attestation. */
export function lookupHookRequesterEnvironment(
  runId: string | undefined,
  sessionKey: string | undefined,
): "dev" | "staging" | "prod" | undefined {
  if (!lookupHookRequesterAttestation(runId, sessionKey)) {
    return undefined;
  }
  return activeAttestations.get(runId!.trim())?.environment;
}
