/**
 * Fi admits a Matrix turn only from a verified person's own message
 * (matrix-entitlements.ts). A sub-agent run has neither, so on Matrix every
 * spawned child was refused at once and the parent waited for a result that
 * never came (Desk, 2026-11-19). Refuse the spawn itself, with a reason the
 * model can act on, instead of starting a run that cannot be admitted.
 * Slack-origin turns are unaffected: they are not gated per Matrix event.
 */
const MATRIX_SESSION = /^agent:[^:]+:matrix:/;
const SUBAGENT_SESSION = /^agent:[^:]+:subagent:/;

export const MATRIX_SUBAGENT_REFUSAL =
  "A sub-agent can't work for a person in a Fi conversation: Fi admits only turns that start from that person's own message, so a sub-agent would be refused. Do the work in this turn, or, from Desk, start a new conversation for it with fi_user_desk_handoff.";

export const SUBAGENT_RUN_REFUSAL =
  "This sub-agent can't act for a person in a Fi conversation, so its task did not run.";

export function isSubagentSession(sessionKey: string | undefined): boolean {
  return SUBAGENT_SESSION.test(sessionKey ?? "");
}

export function matrixSubagentSpawnBlock(
  toolName: string,
  sessionKey: string | undefined,
): { block: true; blockReason: string } | undefined {
  return toolName === "sessions_spawn" && MATRIX_SESSION.test(sessionKey ?? "")
    ? { block: true, blockReason: MATRIX_SUBAGENT_REFUSAL }
    : undefined;
}
