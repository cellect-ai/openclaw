/** The host carries this opaque review receipt; neither prompts nor model input select a person. */
const REVIEW = /^(?:agent:cellect-fi-user:)?hook:fi-review:[a-f0-9]{40}$/i;
const ATTESTATION = /^pra:[A-Za-z0-9_-]{1,100}:[A-Za-z0-9_-]{43}$/;
export function reviewRunClaimed(context: { sessionKey?: string }): boolean {
  return /(?:^|:)hook:fi-review:/i.test(context.sessionKey ?? "");
}
export function reviewToolAttestation(context: {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  hookRequesterAttestation?: string;
}): string | undefined {
  const token = context.hookRequesterAttestation;
  return context.agentId === "cellect-fi-user" &&
    Boolean(context.runId) &&
    REVIEW.test(context.sessionKey ?? "") &&
    typeof token === "string" &&
    token.length <= 256 &&
    ATTESTATION.test(token)
    ? token
    : undefined;
}
