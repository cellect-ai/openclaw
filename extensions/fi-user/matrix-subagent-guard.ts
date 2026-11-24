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
// Swarm collectors launch later, outside the parent's turn, and may be retargeted
// by tools.swarm.defaultAgentId; none of their options is allowed from Matrix.
const COLLECTOR_PARAMS = ["collect", "outputSchema", "fastMode", "groupId"];

export const MATRIX_SUBAGENT_REFUSAL =
  "A sub-agent can work for a person in a Fi conversation only as a one-off run of this same agent whose result comes back to you, started from a turn Fi admitted for that person's own message, and it can't start sub-agents of its own. This spawn is not one, so it would be refused. Do the work in this turn; or spawn with completionTarget \"parent\" (no agentId, mode, thread or collector options) and then call sessions_yield to wait for its result; or start a new conversation for it with fi_user_desk_handoff if that tool is available to you.";

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
  // With no collector option the host targets the requester's own agent, so the
  // effective target is params.agentId when given and the caller's agent otherwise.
  const requested = typeof params.agentId === "string" ? params.agentId.trim() : "";
  const targetAgentId = (requested || ctx.agentId || "").toLowerCase();
  const collector =
    COLLECTOR_PARAMS.some((key) => Object.hasOwn(params, key)) ||
    Object.getOwnPropertySymbols(params).length > 0;
  // Only a one-off hidden native child of an admitted text turn, whose result
  // returns privately to its parent, can be admitted for its person. A thread- or
  // session-bound child would post to the room outside the parent's per-turn
  // audience checks; nesting is not supported.
  const admissible =
    parent === "text" &&
    !isSubagentSession(ctx.sessionKey) &&
    Boolean(ctx.agentId) &&
    targetAgentId === ctx.agentId?.toLowerCase() &&
    !collector &&
    params.completionTarget === "parent" &&
    params.expectsCompletionMessage !== false &&
    params.mode !== "session" &&
    params.thread !== true &&
    params.runtime !== "acp" &&
    params.visible !== true;
  return admissible ? undefined : { block: true, blockReason: MATRIX_SUBAGENT_REFUSAL };
}
