import { createHash } from "node:crypto";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  isDefinitiveRunLifecycle,
} from "../agents/agent-run-terminal-outcome.js";
import type { AgentEventRuntimePayload } from "./agent-events.types.js";
import {
  resolveBusinessApprovalConversation,
  type BusinessApprovalConversation,
} from "./business-approval-conversation.js";
import {
  CHAT_DECIDABLE_APPROVAL_KINDS,
  failureKindOf,
  isLifecycleTime,
  isRunReference,
  nextAtMs,
  stoppedByOf,
  waitingOnOf,
  type DecisionStatus,
  type LifecycleSignals,
  type RunFailureKind,
  type RunStoppedBy,
} from "./conversation-lifecycle-signals.js";
import type { DeliveryQueueEntryState } from "./delivery-queue-sqlite.types.js";
import {
  isPersonRunStopReason,
  matchesVerifiedRunStopActor,
  readRunStopActor,
} from "./run-stop-actor.js";

export type ConversationLifecycleState =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  // No path emits `unknown` any more; it remains only so rows persisted by an
  // earlier build stay readable and settled.
  | "unknown";

export type ConversationProjectionBinding = Readonly<{
  environment: string;
  conversationId: string;
  roomId: string;
  bindingId: string;
  accountId: string;
  threadRootEventId: string;
  sessionKey: string;
  agentId: string;
}>;

export type ConversationLifecyclePublication = Readonly<{
  version: 2;
  environment: string;
  conversationId: string;
  roomId: string;
  bindingId: string;
  runId: string;
  generation: string;
  revision: number;
  state: ConversationLifecycleState;
  resultEventId?: string;
}> &
  /** Contract v2. Recorded always, sent only while the producer flag is on. */
  LifecycleSignals;

/** A decision card the room is owed, by the gateway approval id it is the card of. */
export type LifecycleDecisionCard = {
  revision: number;
  status: DecisionStatus;
  expiresAtMs: number;
  /** Persisted human action copy; no command, raw tool arguments or diagnostic output. */
  conversation?: BusinessApprovalConversation;
  decisions?: ("approve" | "decline")[];
  /** Highest revision the destination accepted. */
  sent: number;
};

export type LifecycleObligation = DeliveryQueueEntryState & {
  transportId: string;
  binding: ConversationProjectionBinding;
  runId: string;
  generation: string;
  sessionId: string;
  revision: number;
  state: ConversationLifecycleState;
  resultEventId?: string;
  /** Last sequenced occurrence, so replay cannot restore a superseded approval. */
  occurrence?: { seq: number; fingerprint: string };
  pendingApprovals: string[];
  pending: ConversationLifecyclePublication[];
  /** Highest revision the destination acknowledged; 0 while it has heard nothing of the run. */
  acked?: number;
  /** A send was started and not refused, so the destination may hold a state it never acknowledged. */
  attempted?: true;
  /** Whether the owner held an execution claim or an open approval at the last transition. */
  live?: boolean;
  /** When that transition was recorded. */
  activeAt?: number;
  /** Set while this row alone keeps failing; it is retried at the probe interval, out of order. */
  stuckAt?: number;
  /** When a held run's owner was first found missing; the hold is measured from here. */
  missingSince?: number;
  /**
   * The v2 fields of each pending fact, by revision, kept beside the facts and
   * not in them, and recorded only while the signals switch is on. The facts
   * stay exactly what the earlier contract stored, so a build without the
   * fields that reads this row sends none of them.
   */
  signals?: Record<number, LifecycleSignals>;
  /** When the run was admitted, read once from its registry context. Never filled in later. */
  admittedAtMs?: number;
  /** `atMs` of the row's newest fact, so the next one is strictly later. */
  lastAtMs?: number;
  /** When the row last produced a heartbeat. */
  heartbeatAt?: number;
  /** Pending approvals a person may decide from the conversation (plugin approvals). */
  confirmations?: string[];
  /** The `waitingOn` reference of the row's newest waiting fact. */
  waitingRef?: string;
  /** What a failed or cancelled run reported, kept for a republish of the same state. */
  failureKind?: RunFailureKind;
  stoppedBy?: RunStoppedBy;
  /** Decision cards owed to the room, by approval id. Only recorded while cards are switched on. */
  cards?: Record<string, LifecycleDecisionCard>;
};

export const QUEUE = "conversation-lifecycle-v2";
export const TERMINAL = new Set<ConversationLifecycleState>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "unknown",
]);
export const RETENTION = { idPrefix: "lifecycle:", maxAgeMs: 30 * 86400_000, maxEntries: 100_000 };
// Unpublished transitions kept for one run, and for one room across its runs.
// Over the room cap each run keeps only its newest unpublished state.
export const RUN_PENDING_CAP = 32;
export const ROOM_PENDING_CAP = 256;
export const RETRY_BASE_MS = 5_000;
export const RETRY_MAX_MS = 5 * 60_000;
// The silent-run sweep removes a context idle for this long even when it still
// had an execution claim or an open approval. Such a run is given the same
// period again to reappear before it is reported interrupted; a run with
// neither, or one whose context went while still active, is reported at once.
export const OWNERLESS_HOLD_MS = 30 * 60_000;
// Unpublished status for a room the homeserver refuses is discarded at this age.
export const PARKED_ROW_EXPIRY_MS = 24 * 60 * 60_000;
// Status still owed to a room that has refused every send for this long is given up.
export const PARKED_ROW_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
// After this many consecutive failures of a room's oldest row, the next row is
// tried once to tell a row the homeserver rejects from a room that is down.
export const HEAD_ROW_FAILURES = 5;
// A refusal can be transient, so a parked room is tried once more at this interval.
export const PARKED_PROBE_MS = 60 * 60_000;
export const SETTLED = new Set<ConversationLifecycleState>(["completed", "failed", "cancelled"]);
// A live run's heartbeat: its current state again with a newer `atMs`, at most
// this often, and only while nothing else of the run waits to be sent.
export const HEARTBEAT_INTERVAL_MS = 60_000;
// A run that waits on a person is vouched for for this long. A claim held for
// longer than an approval is normally open says less about the run than about
// an answer that is not coming, so past it the wait is reported as it stands.
export const HEARTBEAT_WAIT_LIMIT_MS = 60 * 60_000;

export type Retry = { failures: number; notBefore: number };

export function defer(retries: Map<string, Retry>, key: string, baseMs: number): number {
  const failures = (retries.get(key)?.failures ?? 0) + 1;
  const delay = Math.min(baseMs * 2 ** Math.min(failures - 1, 16), RETRY_MAX_MS);
  retries.set(key, { failures, notBefore: Date.now() + delay });
  return failures;
}

export function identity(bindingId: string, runId: string, generation: string): string {
  return `lifecycle:${createHash("sha256")
    .update(JSON.stringify([bindingId, runId, generation]))
    .digest("hex")}`;
}

export function lifecycleState(
  event: AgentEventRuntimePayload,
): ConversationLifecycleState | undefined {
  if (event.stream === "admission") return "queued";
  if (event.stream === "approval") {
    if (event.data.phase === "requested" && event.data.status === "pending") return "waiting";
    if (event.data.phase === "resolved") return "running";
    return;
  }
  if (event.stream !== "lifecycle") return;
  const phase = event.data.phase;
  if (phase === "start") return "running";
  if (phase !== "end" && phase !== "error") return;
  // Intermediate fallback failure is not the admitted run's terminal outcome.
  if (!isDefinitiveRunLifecycle({ phase, data: event.data })) return;
  const outcome = buildAgentRunTerminalOutcomeFromLifecycleEvent({ phase, data: event.data });
  if (outcome.reason === "completed") return "completed";
  if (["aborted", "cancelled", "superseded"].includes(outcome.reason)) return "cancelled";
  // A timed-out run stopped without an answer. Observers must see that it died:
  // `unknown` reads as neither live nor failed and is never resolved downstream.
  return outcome.reason === "timed_out" ? "interrupted" : "failed";
}

export function approvalIdOf(event: AgentEventRuntimePayload): string | undefined {
  return [event.data.approvalId, event.data.itemId, event.data.toolCallId].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

/**
 * Whether an approval may be decided from the conversation: its kind is on the
 * allowlist AND its emitter said so. The marker is opt-in because a kind alone
 * is not enough: the Codex bridge calls file-change and permission-escalation
 * approvals "plugin", and exec and system-agent approvals are never decided
 * from chat.
 */
export function conversationDecisionOf(data: Record<string, unknown>):
  | {
      expiresAtMs: number;
      conversation: BusinessApprovalConversation;
      decisions: ("approve" | "decline")[];
    }
  | undefined {
  if (
    !CHAT_DECIDABLE_APPROVAL_KINDS.some((kind) => kind === data.kind) ||
    data.chatDecidable !== true ||
    !isLifecycleTime(data.expiresAtMs) ||
    !Array.isArray(data.allowedDecisions) ||
    !data.allowedDecisions.includes("deny")
  ) {
    return undefined;
  }
  const conversation = resolveBusinessApprovalConversation({ conversation: data.conversation });
  if (!conversation) {
    return undefined;
  }
  return {
    expiresAtMs: data.expiresAtMs,
    conversation,
    decisions: data.allowedDecisions.includes("allow-once") ? ["approve", "decline"] : ["decline"],
  };
}

/**
 * Applies an approval to the holder's open set; undefined when the event
 * carries no change. `track` also records which open approvals a person may
 * decide, which only the v2 fields and cards use.
 */
export function transition(
  holder: { pendingApprovals: string[]; confirmations?: string[] },
  event: AgentEventRuntimePayload,
  incomingState: ConversationLifecycleState,
  track = false,
): ConversationLifecycleState | undefined {
  if (event.stream !== "approval") return incomingState;
  const approvalId = approvalIdOf(event);
  if (!approvalId) return;
  if (event.data.phase === "requested") {
    if (!holder.pendingApprovals.includes(approvalId)) holder.pendingApprovals.push(approvalId);
    // Only a plugin approval, named by the gateway's own approval id, is one a
    // person may decide from the conversation. A command or a change to the
    // gateway is decided elsewhere, so a run waiting on one names nothing.
    if (
      track &&
      conversationDecisionOf(event.data) !== undefined &&
      event.data.approvalId === approvalId &&
      isRunReference(approvalId) &&
      !holder.confirmations?.includes(approvalId)
    ) {
      holder.confirmations = [...(holder.confirmations ?? []), approvalId];
    }
  } else {
    if (!holder.pendingApprovals.includes(approvalId)) return;
    holder.pendingApprovals = holder.pendingApprovals.filter((id) => id !== approvalId);
    if (holder.confirmations?.includes(approvalId)) {
      const remaining = holder.confirmations.filter((id) => id !== approvalId);
      if (remaining.length) {
        holder.confirmations = remaining;
      } else {
        delete holder.confirmations;
      }
    }
  }
  return holder.pendingApprovals.length ? "waiting" : "running";
}

/** What a failed or cancelled run reports about itself, from its terminal event. */
export function terminalSignalsOf(
  event: AgentEventRuntimePayload,
  state: ConversationLifecycleState,
  binding: ConversationProjectionBinding,
): { failureKind?: RunFailureKind; stoppedBy?: RunStoppedBy } | undefined {
  if (state !== "failed" && state !== "cancelled") {
    return undefined;
  }
  const phase = event.data.phase;
  if (phase !== "end" && phase !== "error") {
    return undefined;
  }
  const outcome = buildAgentRunTerminalOutcomeFromLifecycleEvent({ phase, data: event.data });
  if (state === "failed") {
    return { failureKind: failureKindOf(outcome, event.data) };
  }
  const actor = readRunStopActor(event.data.stopActor);
  if (
    (outcome.reason === "aborted" || outcome.reason === "cancelled") &&
    isPersonRunStopReason(event.data.stopReason) &&
    matchesVerifiedRunStopActor(actor, binding)
  ) {
    return { stoppedBy: { kind: "person", userId: actor.userId } };
  }
  const stoppedBy = stoppedByOf(outcome.reason, outcome.stopReason);
  return stoppedBy ? { stoppedBy } : undefined;
}

/**
 * The v2 signals for the fact the row has just recorded, kept beside the
 * pending facts under its revision. Advances the row's clock. Called only
 * while the signals switch is on, so nothing is stored otherwise.
 */
export function stamp(
  row: LifecycleObligation,
  state: ConversationLifecycleState,
  now = Date.now(),
): void {
  const atMs = nextAtMs(now, row.lastAtMs);
  if (atMs !== undefined) {
    row.lastAtMs = atMs;
  }
  const waitingOn =
    state === "waiting" ? waitingOnOf(row.pendingApprovals, row.confirmations) : undefined;
  if (state === "waiting") {
    row.waitingRef = waitingOn?.ref;
  }
  const signals: LifecycleSignals = {
    ...(atMs !== undefined ? { atMs } : {}),
    ...(row.admittedAtMs !== undefined ? { admittedAtMs: row.admittedAtMs } : {}),
    ...(waitingOn ? { waitingOn } : {}),
    ...(state === "failed" && row.failureKind ? { failureKind: row.failureKind } : {}),
    ...(state === "cancelled" && row.stoppedBy ? { stoppedBy: row.stoppedBy } : {}),
  };
  const kept = new Set(row.pending.map((fact) => fact.revision));
  const earlier = Object.entries(row.signals ?? {}).filter(([revision]) =>
    kept.has(Number(revision)),
  );
  row.signals = Object.fromEntries([...earlier, [String(row.revision), signals]]);
}

export function publication(
  row: LifecycleObligation,
  state: ConversationLifecycleState,
): ConversationLifecyclePublication {
  const { environment, conversationId, roomId, bindingId } = row.binding;
  return {
    version: 2,
    environment,
    conversationId,
    roomId,
    bindingId,
    runId: row.runId,
    generation: row.generation,
    revision: row.revision,
    state,
    ...(row.resultEventId ? { resultEventId: row.resultEventId } : {}),
  };
}

export function appendTransition(
  row: LifecycleObligation,
  state: ConversationLifecycleState,
  cap = RUN_PENDING_CAP,
  terminal?: { failureKind?: RunFailureKind; stoppedBy?: RunStoppedBy },
  signals = false,
  now = Date.now(),
): void {
  // A room that cannot be reached must not fail the run or other rooms, so a
  // full backlog sheds its oldest unpublished transitions instead of throwing.
  // Observers order by revision and tolerate gaps, and nothing is appended
  // after a terminal state except that same state again, so the newest entry
  // kept here is always the run's current state and a terminal is never lost.
  if (row.pending.length >= cap) {
    row.pending.splice(0, row.pending.length - cap + 1);
  }
  if (terminal?.failureKind) {
    row.failureKind = terminal.failureKind;
  }
  if (terminal?.stoppedBy) {
    row.stoppedBy = terminal.stoppedBy;
  }
  row.revision += 1;
  row.state = state;
  row.pending.push(publication(row, state));
  if (signals) {
    stamp(row, state, now);
  }
}

/**
 * The run's current state again under the next revision with a newer `atMs`:
 * proof of life, nothing else. Only ever added to an empty backlog, so it
 * sheds nothing and is never queued behind a fact it could overtake.
 */
export function appendHeartbeat(row: LifecycleObligation): void {
  row.revision += 1;
  row.heartbeatAt = Date.now();
  row.pending.push(publication(row, row.state));
  stamp(row, row.state);
}

/** Closes every open card of a row whose run ended without its answer. */
export function cancelOpenCards(row: LifecycleObligation): void {
  for (const card of Object.values(row.cards ?? {})) {
    if (card.status !== "pending") {
      continue;
    }
    card.revision += 1;
    card.status = "cancelled";
  }
}

/** Gives up the cards a row owes, because its room is given up too. */
export function giveUpCards(row: LifecycleObligation): void {
  for (const card of Object.values(row.cards ?? {})) {
    card.sent = card.revision;
  }
}

/**
 * Records the decision cards a row owes the room: one per plugin approval a
 * person may decide, opened when it is requested and closed when it resolves
 * or the run ends. Cards are sent from `deliver`, newest revision only.
 */
export function noteDecisionCards(
  row: Pick<LifecycleObligation, "confirmations" | "cards">,
  event: AgentEventRuntimePayload,
  state: ConversationLifecycleState,
): void {
  if (event.stream === "approval") {
    const id = approvalIdOf(event);
    const decision = conversationDecisionOf(event.data);
    if (
      id &&
      event.data.phase === "requested" &&
      event.data.status === "pending" &&
      row.confirmations?.includes(id) &&
      decision &&
      !row.cards?.[id]
    ) {
      row.cards = {
        ...row.cards,
        [id]: {
          revision: 1,
          status: "pending",
          ...decision,
          sent: 0,
        },
      };
    } else if (id && event.data.phase === "resolved" && row.cards?.[id]?.status === "pending") {
      const card = row.cards[id];
      card.revision += 1;
      card.status =
        event.data.status === "approved"
          ? "approved"
          : event.data.status === "denied"
            ? "declined"
            : event.data.reason === "timeout"
              ? "expired"
              : "cancelled";
    }
  }
  if (TERMINAL.has(state)) {
    for (const card of Object.values(row.cards ?? {})) {
      if (card.status !== "pending") {
        continue;
      }
      card.revision += 1;
      card.status = "cancelled";
    }
  }
}
