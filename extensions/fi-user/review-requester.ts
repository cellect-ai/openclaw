/** The host carries this opaque review receipt; neither prompts nor model input select a person. */
const REVIEW = /^(?:agent:(cellect-fi-user|cellect-fi-admin):)?hook:fi-review:[a-f0-9]{40}$/i;
const ATTESTATION = /^pra:[A-Za-z0-9_-]{1,100}:[A-Za-z0-9_-]{43}$/;
export function reviewRunClaimed(context: { sessionKey?: string }): boolean {
  return /(?:^|:)hook:fi-review:/i.test(context.sessionKey ?? "");
}
/** The review's agent: the user agent or the admin agent. A run key naming another agent is refused. */
export function reviewRunAgent(context: {
  agentId?: string;
  sessionKey?: string;
}): "cellect-fi-user" | "cellect-fi-admin" | undefined {
  const keyed = REVIEW.exec(context.sessionKey ?? "");
  if (
    !keyed ||
    (context.agentId !== "cellect-fi-user" && context.agentId !== "cellect-fi-admin") ||
    (keyed[1] && keyed[1].toLowerCase() !== context.agentId)
  ) {
    return undefined;
  }
  return context.agentId;
}
export function reviewToolAttestation(context: {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  hookRequesterAttestation?: string;
}): string | undefined {
  const token = context.hookRequesterAttestation;
  return reviewRunAgent(context) !== undefined &&
    Boolean(context.runId) &&
    typeof token === "string" &&
    token.length <= 256 &&
    ATTESTATION.test(token)
    ? token
    : undefined;
}
