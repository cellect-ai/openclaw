import {
  MAX_CHECKED_SESSIONS,
  type TurnAuthorship,
  PERSON,
  MAX_CHILD_MS,
  type Turn,
  parseAuthorship,
  isBrief,
} from "./matrix-entitlements.policy.js";

export function createMatrixEntitlementTurnCustody(
  turns: Map<string, Turn>,
  briefEvents: Map<string, TurnAuthorship>,
  deskTaskRooms: Set<string>,
) {
  const roomKey = (turn: Turn) => `${turn.accountId}\u0000${turn.roomId}`;

  const remember = <T>(store: Map<string, T> | Set<string>, key: string, value?: T) => {
    store.delete(key);
    if (store instanceof Map) {
      store.set(key, value as T);
    } else {
      store.add(key);
    }
    for (const oldest of store.keys()) {
      if (store.size <= MAX_CHECKED_SESSIONS) {
        break;
      }
      store.delete(oldest);
    }
  };

  const eventKey = (turn: Turn) =>
    turn.mode === "text" ? `${turn.accountId}\u0000${turn.roomId}\u0000${turn.eventId}` : undefined;

  /** A turn is a brief when Fi said so for it, its parent, or its event, at any point in the run. */
  const authorshipOf = (turn: Turn): TurnAuthorship => {
    if (isBrief(turn.authorship)) {
      return turn.authorship!;
    }
    const parent = turn.parentRunId ? turns.get(turn.parentRunId) : undefined;
    if (parent && isBrief(parent.authorship)) {
      return parent.authorship!;
    }
    const key = eventKey(turn);
    return (key && briefEvents.get(key)) || PERSON;
  };

  // Only moves one way within a run: a later answer of person never lifts a brief.
  const markBrief = (turn: Turn, authorship: TurnAuthorship) => {
    remember(deskTaskRooms, roomKey(turn));
    const key = eventKey(turn);
    if (key) {
      remember(briefEvents, key, authorship);
    }
    if (!isBrief(turn.authorship)) {
      turn.authorship = authorship;
    }
  };

  const noteAuthorship = (turn: Turn, result: object) => {
    const authorship = parseAuthorship(result, turn);
    // Strict and additive: only a literal true marks the room; an older Fi sends nothing.
    if ("deskTaskRoom" in result && result.deskTaskRoom === true) {
      remember(deskTaskRooms, roomKey(turn));
    }
    if (isBrief(authorship)) {
      markBrief(turn, authorship);
    } else if (!turn.authorship) {
      turn.authorship = authorship;
    }
  };

  const retireTurn = (runId: string) => {
    const turn = turns.get(runId);
    if (!turn) {
      return;
    }
    turn.authorization.abort();
    clearTimeout(turn.custodyTimer);
    turns.delete(runId);
    for (const child of turn.children) {
      retireTurn(child);
    }
    const parentRunId = turn.parentRunId;
    const parent = parentRunId ? turns.get(parentRunId) : undefined;
    if (
      parentRunId &&
      parent?.children.delete(runId) &&
      parent.settled &&
      !parent.children.size &&
      !parent.pendingSpawns
    ) {
      retireTurn(parentRunId);
    }
  };

  // A settled parent with live or not yet started children stays as their
  // custody, until the last child ends or the latest bound passes; it runs no
  // tools meanwhile. A child can start after its parent has already replied.
  const settleTurn = (runId: string) => {
    const turn = turns.get(runId);
    const bounds = [...(turn?.children ?? [])].map((child) => turns.get(child)?.expiresAt ?? 0);
    if (turn?.pendingSpawns) {
      bounds.push(Date.now() + MAX_CHILD_MS);
    }
    if (!turn || turn.parentRunId || !bounds.length) {
      retireTurn(runId);
      return;
    }
    turn.settled = true;
    clearTimeout(turn.custodyTimer);
    turn.custodyTimer = setTimeout(
      () => turns.get(runId) === turn && retireTurn(runId),
      Math.max(0, Math.max(...bounds) - Date.now()),
    );
    turn.custodyTimer.unref?.();
  };

  /** A child is current only while its lineage, bound and admitted parent all are. */
  const childCurrent = (turn: Turn): boolean => {
    const lineage = turn.lineage;
    const parent = turn.parentRunId ? turns.get(turn.parentRunId) : undefined;
    if (
      !lineage ||
      !parent?.admitted ||
      !parent.children.has(lineage.childRunId) ||
      turns.get(lineage.childRunId) !== turn ||
      Date.now() >= (turn.expiresAt ?? 0) ||
      parent.agentId !== turn.agentId ||
      parent.accountId !== turn.accountId ||
      parent.roomId !== turn.roomId ||
      parent.senderId !== turn.senderId ||
      parent.orgId !== turn.orgId
    ) {
      return false;
    }
    try {
      lineage.assertCurrent();
      return true;
    } catch {
      return false;
    }
  };

  const retireAll = () => {
    for (const runId of turns.keys()) {
      retireTurn(runId);
    }
  };
  return {
    roomKey,
    remember,
    authorshipOf,
    markBrief,
    noteAuthorship,
    retireTurn,
    settleTurn,
    childCurrent,
    retireAll,
  };
}
