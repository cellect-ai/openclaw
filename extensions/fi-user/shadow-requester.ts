/**
 * Fi shadow turns: a background turn Fi starts for one member through the
 * authenticated hooks API, on a `hook:fi-shadow:` session, with an opaque
 * attestation Fi minted for that job. The gateway hands the attestation to
 * this run's plugin contexts as `hookRequesterAttestation`; only Fi can say
 * whom it names, so it is sent back to Fi as the delegation requester and is
 * never logged, shown to the model or stored.
 */

const SHADOW_WAKE_SESSION = /(?:^|:)hook:fi-shadow:/i;
const ATTESTATION = /^fsa:[^:\s]{1,200}:[A-Za-z0-9_-]{43}$/;

/** The attestation of a shadow-hook cron run, or undefined for any other run. */
export function shadowWakeAttestation(
  sessionKey: string | undefined,
  trigger: string | undefined,
  attestation: unknown,
): string | undefined {
  return trigger === "cron" &&
    typeof sessionKey === "string" &&
    SHADOW_WAKE_SESSION.test(sessionKey) &&
    typeof attestation === "string" &&
    attestation.length <= 256 &&
    ATTESTATION.test(attestation)
    ? attestation
    : undefined;
}

/**
 * The attestation a plugin tool context carries for a shadow run. The host
 * sets the field only for the run a `hook:fi-shadow:` hook started, so the
 * context has no trigger to check; the session must still be a shadow one.
 */
export function shadowToolAttestation(context: {
  sessionKey?: string;
  hookRequesterAttestation?: string;
}): string | undefined {
  return shadowWakeAttestation(context.sessionKey, "cron", context.hookRequesterAttestation);
}
