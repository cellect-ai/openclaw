// A port of the consumer side of cellect-threads `kit/src/conversation.ts` and
// `kit/src/decision.ts` (the run lifecycle fact, its heartbeat and reduction, and
// the decision card), for tests only. OpenClaw cannot depend on the kit, so what
// keeps this port honest is the shared fixtures next to it: the port must accept
// every `positive` fixture, reject every `negative` one and reproduce every
// `reduce` result (kit-contract.test.ts). Facts the gateway emits are then held
// to the port.

type Obj = Record<string, unknown>;
export class ContractError extends Error {}
function fail(code: string): never {
  throw new ContractError(code);
}
function object(value: unknown, keys: readonly string[]): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("object");
  }
  const o = value as Obj;
  if (Object.keys(o).some((key) => !keys.includes(key))) {
    fail("unknown_field");
  }
  return o;
}
function text(value: unknown, max = 256): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    !value.trim() ||
    Array.from(value).some((char) => char.charCodeAt(0) < 0x20)
  ) {
    fail("string");
  }
  return value as string;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail("integer");
  }
  return value as number;
}

export const LIFECYCLE_TIME_MIN_MS = 1_000_000_000_000;
export const LIFECYCLE_TIME_MAX_MS = 10_000_000_000_000;
export const LIFECYCLE_CLOCK_SKEW_MS = 60_000;
const lifecycleTime = (value: unknown) =>
  integer(value, LIFECYCLE_TIME_MIN_MS, LIFECYCLE_TIME_MAX_MS - 1);
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DISPLAY_USER_ID = /^@[!-9;-~]+:[!-9;-~]+(:\d{1,5})?$/;
const FAILURE_KINDS = new Set([
  "refusal",
  "timeout",
  "rate_limit",
  "context_length",
  "state_contention",
  "unknown",
]);
const WAITING_ON_KINDS = new Set(["question", "confirmation", "workflowApproval"]);
const STOPPED_BY_KINDS = new Set(["person", "coordinator", "auth_revoked"]);
const STATES = new Set([
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "unknown",
]);
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const identityKeys = ["version", "environment", "conversationId", "roomId", "bindingId"];
const signalKeys = ["atMs", "admittedAtMs", "waitingOn", "failureKind", "stoppedBy"];

export type RunLifecycle = {
  version: 2;
  environment: string;
  conversationId: string;
  roomId: string;
  bindingId: string;
  runId: string;
  generation: string;
  revision: number;
  state: string;
  resultEventId?: string;
  atMs?: number;
  admittedAtMs?: number;
  waitingOn?: { kind: string; ref: string };
  failureKind?: string;
  stoppedBy?: { kind: string; userId?: string };
};

export function parseRunLifecycle(value: unknown): RunLifecycle {
  const o = object(value, [
    ...identityKeys,
    "runId",
    "generation",
    "revision",
    "state",
    "resultEventId",
    ...signalKeys,
  ]);
  if (o.version !== 2) {
    fail("version");
  }
  const environment = text(o.environment, 32);
  if (!/^[a-z][a-z0-9]*$/.test(environment)) {
    fail("environment");
  }
  const roomId = text(o.roomId);
  if (!/^![^\s:]+:[^\s]+$/.test(roomId)) {
    fail("room_id");
  }
  if (!STATES.has(o.state as string)) {
    fail("run_state");
  }
  if (
    (o.waitingOn !== undefined && o.state !== "waiting") ||
    (o.failureKind !== undefined && o.state !== "failed") ||
    (o.stoppedBy !== undefined && o.state !== "cancelled")
  ) {
    fail("run_signal_state");
  }
  if (o.failureKind !== undefined && !FAILURE_KINDS.has(o.failureKind as string)) {
    fail("run_failure_kind");
  }
  const resultEventId =
    o.resultEventId === undefined
      ? undefined
      : (() => {
          const v = text(o.resultEventId);
          if (!/^\$\S+$/.test(v)) {
            fail("event_id");
          }
          return v;
        })();
  let waitingOn: RunLifecycle["waitingOn"];
  if (o.waitingOn !== undefined) {
    const w = object(o.waitingOn, ["kind", "ref"]);
    if (!WAITING_ON_KINDS.has(w.kind as string)) {
      fail("run_waiting_on_kind");
    }
    if (typeof w.ref !== "string" || !REFERENCE.test(w.ref) || w.ref.length > 128) {
      fail("run_reference");
    }
    waitingOn = { kind: w.kind as string, ref: w.ref };
  }
  let stoppedBy: RunLifecycle["stoppedBy"];
  if (o.stoppedBy !== undefined) {
    const s = object(o.stoppedBy, ["kind", "userId"]);
    if (!STOPPED_BY_KINDS.has(s.kind as string)) {
      fail("run_stopped_by_kind");
    }
    if (s.userId === undefined) {
      stoppedBy = { kind: s.kind as string };
    } else {
      if (
        s.kind !== "person" ||
        typeof s.userId !== "string" ||
        s.userId.length > 255 ||
        !DISPLAY_USER_ID.test(s.userId)
      ) {
        fail("run_stopped_by_user");
      }
      stoppedBy = { kind: "person", userId: s.userId as string };
    }
  }
  return {
    version: 2,
    environment,
    conversationId: text(o.conversationId),
    roomId,
    bindingId: text(o.bindingId),
    runId: text(o.runId),
    generation: text(o.generation),
    revision: integer(o.revision, 1),
    state: o.state as string,
    ...(resultEventId === undefined ? {} : { resultEventId }),
    ...(o.atMs === undefined ? {} : { atMs: lifecycleTime(o.atMs) }),
    ...(o.admittedAtMs === undefined ? {} : { admittedAtMs: lifecycleTime(o.admittedAtMs) }),
    ...(waitingOn ? { waitingOn } : {}),
    ...(o.failureKind === undefined ? {} : { failureKind: o.failureKind as string }),
    ...(stoppedBy ? { stoppedBy } : {}),
  };
}

/** The fact as the 2026-09-18 contract knows it. */
export function baseRunLifecycle(value: RunLifecycle): RunLifecycle {
  const parsed = parseRunLifecycle(value);
  for (const key of signalKeys) {
    delete (parsed as Obj)[key];
  }
  return parsed;
}

function untimed(run: RunLifecycle): RunLifecycle {
  const { atMs: _at, admittedAtMs: _admitted, ...rest } = run;
  return rest as RunLifecycle;
}

export function isRunHeartbeat(current: RunLifecycle, incoming: RunLifecycle): boolean {
  return (
    incoming.revision > current.revision &&
    incoming.atMs !== undefined &&
    (current.atMs === undefined || incoming.atMs > current.atMs) &&
    JSON.stringify({ ...untimed(parseRunLifecycle(current)), revision: 0 }) ===
      JSON.stringify({ ...untimed(parseRunLifecycle(incoming)), revision: 0 })
  );
}

export function reduceRunLifecycle(
  current: RunLifecycle | null,
  incoming: RunLifecycle,
  receipt?: { receivedAtMs: number },
): RunLifecycle {
  const parsed = parseRunLifecycle(incoming);
  const limit =
    typeof receipt === "object" && receipt !== null
      ? integer(receipt.receivedAtMs) + LIFECYCLE_CLOCK_SKEW_MS
      : undefined;
  const next =
    parsed.atMs === undefined || limit === undefined || parsed.atMs <= limit
      ? parsed
      : { ...parsed, atMs: limit };
  if (!current) {
    return next;
  }
  if (
    identityKeys.some((k) => (current as Obj)[k] !== (next as Obj)[k]) ||
    current.runId !== next.runId ||
    current.generation !== next.generation
  ) {
    fail("run_ownership");
  }
  if (
    next.revision === current.revision &&
    JSON.stringify(untimed(current)) !== JSON.stringify(untimed(next))
  ) {
    fail("conflicting_run_revision");
  }
  if (
    next.revision > current.revision &&
    TERMINAL.has(current.state) &&
    next.state !== current.state
  ) {
    fail("terminal_regression");
  }
  const state = next.revision > current.revision ? next : current;
  const admitted = [current.admittedAtMs, next.admittedAtMs].filter(
    (v): v is number => v !== undefined,
  );
  const seen = [current.atMs, next.atMs].filter((v): v is number => v !== undefined);
  if (admitted.length === 0 && seen.length === 0) {
    return state;
  }
  return {
    ...untimed(state),
    ...(seen.length ? { atMs: Math.max(...seen) } : {}),
    ...(admitted.length ? { admittedAtMs: Math.min(...admitted) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Decision card

const CARD_KEYS = new Set([
  "type",
  "version",
  "kind",
  "id",
  "revision",
  "status",
  "runId",
  "title",
  "summary",
  "decisions",
  "expiresAtMs",
  "workflowRef",
  "requesterUserId",
  "decidedByUserId",
]);
const CARD_STATUSES = new Set([
  "pending",
  "approved",
  "declined",
  "expired",
  "superseded",
  "cancelled",
]);
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const VISIBLE = /[^\s\p{Z}\p{Cc}\p{Cf}]/u;
const isRef = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 128 && REFERENCE.test(v);
const isUser = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 255 && DISPLAY_USER_ID.test(v);
const isText = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length <= max && VISIBLE.test(v) && !UNSAFE_TEXT.test(v);

export function isDecisionCard(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const v = value as Obj;
  if (Object.keys(v).some((key) => !CARD_KEYS.has(key))) {
    return false;
  }
  if (v.type !== "m.cellect.decision" || v.version !== 1) {
    return false;
  }
  if (v.kind !== "confirmation" && v.kind !== "workflowApproval") {
    return false;
  }
  if (!isRef(v.id)) {
    return false;
  }
  if (typeof v.revision !== "number" || !Number.isSafeInteger(v.revision) || v.revision < 1) {
    return false;
  }
  if (!CARD_STATUSES.has(v.status as string)) {
    return false;
  }
  if (v.runId !== undefined && !isText(v.runId, 256)) {
    return false;
  }
  if (!isText(v.title, 80) || !isText(v.summary, 280)) {
    return false;
  }
  const decisions = v.decisions;
  if (
    !Array.isArray(decisions) ||
    decisions.length < 1 ||
    new Set(decisions).size !== decisions.length
  ) {
    return false;
  }
  if (!decisions.every((choice) => choice === "approve" || choice === "decline")) {
    return false;
  }
  if (
    typeof v.expiresAtMs !== "number" ||
    !Number.isSafeInteger(v.expiresAtMs) ||
    v.expiresAtMs < LIFECYCLE_TIME_MIN_MS ||
    v.expiresAtMs >= LIFECYCLE_TIME_MAX_MS
  ) {
    return false;
  }
  if (v.kind === "workflowApproval") {
    if (!isRef(v.workflowRef) || v.requesterUserId !== undefined) {
      return false;
    }
  } else if (v.workflowRef !== undefined) {
    return false;
  }
  if (v.requesterUserId !== undefined && !isUser(v.requesterUserId)) {
    return false;
  }
  if (
    v.decidedByUserId !== undefined &&
    (!isUser(v.decidedByUserId) || (v.status !== "approved" && v.status !== "declined"))
  ) {
    return false;
  }
  return true;
}
