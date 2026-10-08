// The optional signals of a conversation lifecycle fact (contract v2) and the
// decision card. Pure helpers: nothing here reads a clock, a registry or a
// room. The shapes and limits mirror cellect-threads `kit/src/conversation.ts`
// and `kit/src/decision.ts`, which are the contract; the shared kit fixtures
// are replayed against these functions in conversation-lifecycle-signals.test.ts.
import {
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalFacts,
} from "@openclaw/normalization-core/agent-run-terminal-outcome";
import { isTimeoutError, resolveFailoverReasonFromError } from "../agents/failover-error.js";
import {
  resolveBusinessApprovalConversation,
  type BusinessApprovalConversation,
} from "./business-approval-conversation.js";
import { formatErrorMessage } from "./errors.js";

/** The optional fields of a lifecycle fact. A consumer built before them rejects the whole fact. */
export const LIFECYCLE_SIGNAL_KEYS = [
  "atMs",
  "admittedAtMs",
  "waitingOn",
  "failureKind",
  "stoppedBy",
] as const;

export const RUN_FAILURE_KINDS = [
  "refusal",
  "timeout",
  "rate_limit",
  "context_length",
  "state_contention",
  "unknown",
] as const;
export type RunFailureKind = (typeof RUN_FAILURE_KINDS)[number];

export const RUN_WAITING_ON_KINDS = ["question", "confirmation", "workflowApproval"] as const;
export type RunWaitingOn = { kind: (typeof RUN_WAITING_ON_KINDS)[number]; ref: string };

export const RUN_STOPPED_BY_KINDS = ["person", "coordinator", "auth_revoked"] as const;
export type RunStoppedBy = { kind: (typeof RUN_STOPPED_BY_KINDS)[number] };

export type LifecycleSignals = {
  atMs?: number;
  admittedAtMs?: number;
  waitingOn?: RunWaitingOn;
  failureKind?: RunFailureKind;
  stoppedBy?: RunStoppedBy;
};

/** Producer times are epoch milliseconds in [10^12, 10^13). */
export const LIFECYCLE_TIME_MIN_MS = 1_000_000_000_000;
export const LIFECYCLE_TIME_MAX_MS = 10_000_000_000_000;
export const RUN_REFERENCE_MAX = 128;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** The producer flag: switched on only after the projector, Fi and iOS accept the fields. */
export const LIFECYCLE_SIGNALS_ENV = "OPENCLAW_CONVERSATION_LIFECYCLE_SIGNALS";
export { DECISION_CARDS_ENV, decisionCardsEnabled } from "./business-approval-conversation.js";

function flag(name: string, env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[name]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export function lifecycleSignalsEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return flag(LIFECYCLE_SIGNALS_ENV, env);
}

export function isLifecycleTime(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= LIFECYCLE_TIME_MIN_MS &&
    value < LIFECYCLE_TIME_MAX_MS
  );
}

export function isRunReference(value: unknown): value is string {
  return typeof value === "string" && value.length <= RUN_REFERENCE_MAX && REFERENCE.test(value);
}

/**
 * The signals a fact in `state` may carry, and only valid ones. A signal on a
 * state it does not describe is a producer bug the consumer rejects as a whole,
 * so it is dropped here instead of sent.
 */
export function validSignals(state: string, signals: LifecycleSignals): LifecycleSignals {
  const out: LifecycleSignals = {};
  if (isLifecycleTime(signals.atMs)) {
    out.atMs = signals.atMs;
  }
  if (isLifecycleTime(signals.admittedAtMs)) {
    out.admittedAtMs = signals.admittedAtMs;
  }
  const waiting = signals.waitingOn;
  if (
    state === "waiting" &&
    waiting &&
    RUN_WAITING_ON_KINDS.includes(waiting.kind) &&
    isRunReference(waiting.ref)
  ) {
    out.waitingOn = { kind: waiting.kind, ref: waiting.ref };
  }
  if (
    state === "failed" &&
    signals.failureKind &&
    RUN_FAILURE_KINDS.includes(signals.failureKind)
  ) {
    out.failureKind = signals.failureKind;
  }
  if (
    state === "cancelled" &&
    signals.stoppedBy &&
    RUN_STOPPED_BY_KINDS.includes(signals.stoppedBy.kind)
  ) // Only the kind: the person's Matrix id may be published for a member of
  // the room, and membership is not known here.
  {
    out.stoppedBy = { kind: signals.stoppedBy.kind };
  }
  return out;
}

/**
 * The fact as it is sent. The flag is read by the caller when the fact is sent,
 * not when it is recorded, so switching it off stops the fields at once,
 * backlog included. With it off the fact is exactly the pre-v2 one.
 */
export function factForSend<T extends { state: string } & LifecycleSignals>(
  fact: T,
  options: { signals: boolean; decisionCards: boolean },
): T {
  const base = { ...fact } as T & Record<string, unknown>;
  for (const key of LIFECYCLE_SIGNAL_KEYS) {
    delete base[key];
  }
  if (!options.signals) {
    return base;
  }
  const signals = validSignals(fact.state, fact);
  // A confirmation or workflow approval names a decision card; with cards off
  // there is none, and a wait on a card nobody can see strands the run.
  if (signals.waitingOn && signals.waitingOn.kind !== "question" && !options.decisionCards) {
    delete signals.waitingOn;
  }
  return Object.assign(base, signals);
}

/** Producer time for a fact: the clock, and strictly later than the run's previous fact. */
export function nextAtMs(now: number, previous: number | undefined): number | undefined {
  const next = previous !== undefined && previous >= now ? previous + 1 : now;
  return isLifecycleTime(next) ? next : undefined;
}

/** The chat stream's reading of an error text: refusal, rate limit, context length or timeout, else none. */
export function errorKindOf(error: unknown): RunFailureKind | undefined {
  if (error === undefined) {
    return undefined;
  }
  const message = formatErrorMessage(error).toLowerCase();
  if (
    message.includes("refusal") ||
    message.includes("content_filter") ||
    message.includes("sensitive") ||
    message.includes("unhandled stop reason: refusal_policy")
  ) {
    return "refusal";
  }
  const reason = resolveFailoverReasonFromError(error);
  if (reason === "rate_limit" || reason === "overloaded") {
    return "rate_limit";
  }
  if (reason === "context_overflow") {
    return "context_length";
  }
  return isTimeoutError(error) ? "timeout" : undefined;
}

/**
 * Why a run failed, from the same inputs and in the same order as the chat
 * stream: a recorded timeout classification, then the event's own `errorKind`,
 * then what `data.error` says. (A run that timed out without an answer is
 * published `interrupted`, which carries no failure kind.)
 */
export function failureKindOf(
  outcome: Pick<AgentRunTerminalFacts, "reason">,
  data: { errorKind?: unknown; error?: unknown },
): RunFailureKind {
  if (classifyAgentRunTerminalOutcome(outcome) === "timeout") {
    return "timeout";
  }
  const reported = data.errorKind;
  if (typeof reported === "string" && RUN_FAILURE_KINDS.includes(reported as RunFailureKind)) {
    return reported as RunFailureKind;
  }
  return errorKindOf(data.error) ?? "unknown";
}

/** Who stopped a run, as far as the lifecycle can tell. A person's stop is not recorded on the event. */
export function stoppedByOf(outcomeReason: string | undefined): RunStoppedBy | undefined {
  // A run replaced by a newer writer, or one the gateway aborted for a restart,
  // was stopped by the system. Nothing else names its stopper.
  return outcomeReason === "superseded" ? { kind: "coordinator" } : undefined;
}

/**
 * What a waiting run is blocked on: the first open approval that a person may
 * decide from the conversation, named by the gateway's own approval id (which
 * is also the id of its decision card). An approval nobody may decide there
 * (a command, a change to the gateway itself) names nothing.
 */
export function waitingOnOf(
  pendingApprovals: readonly string[],
  confirmations: readonly string[] | undefined,
): RunWaitingOn | undefined {
  const ref = pendingApprovals.find((id) => confirmations?.includes(id) && isRunReference(id));
  return ref ? { kind: "confirmation", ref } : undefined;
}

/**
 * The gateway approval kinds a person may decide from a conversation: today
 * exactly `plugin`, as in Fi's `CHAT_DECIDABLE_APPROVAL_KINDS`. An `exec`
 * approval grants a shell command and a `system-agent` approval changes the
 * gateway itself; neither is ever decidable from chat, and adding one here
 * needs a new owner decision first. The kind is not enough on its own: an
 * approval is offered only when its emitter also sets `chatDecidable`.
 */
export const CHAT_DECIDABLE_APPROVAL_KINDS = ["plugin"] as const;

// ---------------------------------------------------------------------------
// Decision card (kit `decision.ts`, version 1).

export const DECISION_CARD_TYPE = "m.cellect.decision";
export const CARD_CONTENT_KEY = "ai.cellect.card";
export const DECISION_TITLE_MAX = 80;
export const DECISION_SUMMARY_MAX = 280;
export const DECISION_STATUSES = [
  "pending",
  "approved",
  "declined",
  "expired",
  "superseded",
  "cancelled",
] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export type DecisionCard = {
  type: typeof DECISION_CARD_TYPE;
  version: 1;
  kind: "confirmation";
  id: string;
  revision: number;
  status: DecisionStatus;
  runId?: string;
  title: string;
  summary: string;
  decisions: ("approve" | "decline")[];
  expiresAtMs: number;
};

const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const VISIBLE = /[^\s\p{Z}\p{Cc}\p{Cf}]/u;

/** One line of plain text, no control or format characters, never empty, cut to `max`. */
export function cardText(value: string, max: number, fallback: string): string {
  const flat = value
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const text = flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
  return VISIBLE.test(text) && !UNSAFE_TEXT.test(text) ? text : fallback;
}

/** A business confirmation, using the owner's separate conversation-safe copy and actual choices. */
export function buildConfirmationCard(params: {
  id: string;
  revision: number;
  status: DecisionStatus;
  runId: string;
  expiresAtMs: number;
  conversation?: BusinessApprovalConversation;
  decisions?: readonly ("approve" | "decline")[];
}): DecisionCard | undefined {
  if (!isRunReference(params.id) || !isLifecycleTime(params.expiresAtMs)) {
    return undefined;
  }
  if (!Number.isSafeInteger(params.revision) || params.revision < 1) {
    return undefined;
  }
  const conversation = resolveBusinessApprovalConversation({ conversation: params.conversation });
  const decisions = params.decisions;
  if (
    !conversation ||
    !decisions?.length ||
    decisions.length > 2 ||
    new Set(decisions).size !== decisions.length ||
    decisions.some((decision) => decision !== "approve" && decision !== "decline")
  )
    return undefined;
  const runId = cardText(params.runId, 256, "");
  return {
    type: DECISION_CARD_TYPE,
    version: 1,
    kind: "confirmation",
    id: params.id,
    revision: params.revision,
    status: params.status,
    ...(runId ? { runId } : {}),
    ...conversation,
    decisions: [...decisions],
    expiresAtMs: params.expiresAtMs,
  };
}

/** The message that carries a card: the `ai.cellect.card` envelope of an `m.notice`. */
export function decisionCardContent(
  card: DecisionCard,
  threadRootEventId: string | undefined,
): Record<string, unknown> {
  return {
    msgtype: "m.notice",
    body: card.title,
    [CARD_CONTENT_KEY]: card,
    ...(threadRootEventId
      ? {
          "m.relates_to": {
            rel_type: "m.thread",
            event_id: threadRootEventId,
            is_falling_back: true,
            "m.in_reply_to": { event_id: threadRootEventId },
          },
        }
      : {}),
  };
}
