/** Proof supplied only by the authenticated conversation Stop admission owner. */
export type VerifiedRunStopActor = Readonly<{
  userId: string;
  roomId: string;
  threadRootEventId: string;
  agentId: string;
  sessionKey: string;
}>;

/** The shared kit's display-only Matrix identity contract. */
export function isRunStopUserId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 255 &&
    /^@[!-9;-~]+:[!-9;-~]+(:\d{1,5})?$/.test(value)
  );
}

/** Human Stop causes; watchdog, restart and credential revocation retain their own semantics. */
export function isPersonRunStopReason(value: unknown): value is "rpc" | "stop" | "aborted" {
  return value === "rpc" || value === "stop" || value === "aborted";
}

/** Decode retained internal evidence; shape alone never authorizes a Stop. */
export function readRunStopActor(value: unknown): VerifiedRunStopActor | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const actor = value as Record<string, unknown>;
  if (
    !isRunStopUserId(actor.userId) ||
    typeof actor.roomId !== "string" ||
    !actor.roomId ||
    typeof actor.threadRootEventId !== "string" ||
    !actor.threadRootEventId ||
    typeof actor.agentId !== "string" ||
    !actor.agentId ||
    typeof actor.sessionKey !== "string" ||
    !actor.sessionKey
  ) {
    return undefined;
  }
  return Object.freeze({
    userId: actor.userId,
    roomId: actor.roomId,
    threadRootEventId: actor.threadRootEventId,
    agentId: actor.agentId,
    sessionKey: actor.sessionKey,
  });
}

/** Matching does not grant authority; it prevents an admitted actor crossing owners. */
export function matchesVerifiedRunStopActor(
  actor: VerifiedRunStopActor | undefined,
  owner: { sessionKey?: string; agentId?: string; roomId?: string; threadRootEventId?: string },
): actor is VerifiedRunStopActor {
  return Boolean(
    actor &&
    actor.sessionKey === owner.sessionKey &&
    actor.agentId === owner.agentId &&
    (owner.roomId === undefined || actor.roomId === owner.roomId) &&
    (owner.threadRootEventId === undefined || actor.threadRootEventId === owner.threadRootEventId),
  );
}

/** Local owner-held signal reason, never reconstructed from wire JSON. */
export class ConversationRunStopReason extends Error {
  readonly actor: VerifiedRunStopActor;
  constructor(actor: VerifiedRunStopActor) {
    super("Conversation run stopped");
    this.name = "ConversationRunStopReason";
    this.actor = Object.freeze({ ...actor });
  }
}
