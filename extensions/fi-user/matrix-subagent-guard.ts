/**
 * Fi admits a Matrix turn only from a verified person's own message
 * (matrix-entitlements.ts). A sub-agent of an admitted text turn runs for that
 * same person, room and agent only: the host proves its lineage and Fi
 * re-admits it. Every other spawn from a Matrix turn would start a run that
 * cannot be admitted (Desk, 2026-11-19), so it is refused here, with a reason
 * the model can act on. Slack-origin turns are unaffected: they are not gated
 * per Matrix event.
 */
const MATRIX_SESSION = /^agent:[^:]+:matrix:/;
// Spawned children only: a persistent ACP binding is a conversation session, not a child.
const SUBAGENT_SESSION = /^agent:[^:]+:(?:subagent:|acp:(?!binding:))/;

export const MATRIX_SUBAGENT_REFUSAL =
  "A sub-agent can work for a person in a Fi conversation only as a one-off run of this same agent, started from a turn Fi admitted for that person's own message, and it can't start sub-agents of its own. This spawn is not one, so it would be refused. Do the work in this turn, spawn a one-off run (no agentId, mode or thread) from this turn, or start a new conversation for it with fi_user_desk_handoff if that tool is available to you.";

export const SUBAGENT_RUN_REFUSAL =
  "This sub-agent can't act for a person in a Fi conversation, so its task did not run.";

export function isSubagentSession(sessionKey: string | undefined): boolean {
  return SUBAGENT_SESSION.test(sessionKey ?? "");
}

type SpawnContext = {
  agentId?: string;
  sessionKey?: string;
  requester?: { channel?: string };
  requesterContinuation?: { channel?: string };
};

/** What matrix-entitlements knows of the calling run: an admitted text or voice turn, or a child. */
export type SpawnParent = "text" | "voice" | "child" | undefined;

/**
 * A child inherits the channel its parent's run arrived on, not the session key
 * (a source-linked Matrix turn runs on a Slack-shaped key), so decide by the
 * run's channel and use the key only when no channel is known.
 */
export function matrixSubagentSpawnBlock(
  toolName: string,
  ctx: SpawnContext,
  params: Record<string, unknown> = {},
  parent: SpawnParent = undefined,
): { block: true; blockReason: string } | undefined {
  if (toolName !== "sessions_spawn") {
    return undefined;
  }
  const channels = [ctx.requester?.channel, ctx.requesterContinuation?.channel].filter(Boolean);
  const matrixOrigin = channels.length
    ? channels.includes("matrix")
    : MATRIX_SESSION.test(ctx.sessionKey ?? "");
  if (!matrixOrigin) {
    return undefined;
  }
  const targetAgentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
  // Only a one-off hidden native child of an admitted text turn can be admitted
  // for its person. A thread- or session-bound child would post to the room
  // outside the parent's per-turn audience checks; nesting is not supported.
  const admissible =
    parent === "text" &&
    !isSubagentSession(ctx.sessionKey) &&
    (!targetAgentId || targetAgentId.toLowerCase() === ctx.agentId?.toLowerCase()) &&
    params.mode !== "session" &&
    params.thread !== true &&
    params.runtime !== "acp" &&
    params.visible !== true;
  return admissible ? undefined : { block: true, blockReason: MATRIX_SUBAGENT_REFUSAL };
}
