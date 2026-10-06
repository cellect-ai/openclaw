import { AsyncLocalStorage } from "node:async_hooks";
// Durable projection custody; this module never schedules or resumes agent work.
import { createHash } from "node:crypto";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  isDefinitiveRunLifecycle,
} from "../agents/agent-run-terminal-outcome.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  registerAgentEventPersistenceHandler,
  type AgentEventRuntimePayload,
} from "./agent-events.js";
import {
  getAgentRunContext,
  getAgentRunLifecycleGeneration,
  hasAgentRunContextExecutionOwner,
  listCurrentAgentRunIds,
  registerAgentRunAdmissionHandler,
} from "./agent-run-registry.js";
import {
  getDeliveryQueueEntryStatus,
  loadDeliveryQueueEntries,
  loadDeliveryQueueEntry,
  upsertDeliveryQueueEntry,
  type DeliveryQueueEntryState,
} from "./delivery-queue-sqlite.js";
import {
  captureDeliveryQueueStateContext,
  resolveDeliveryQueueStateEnv,
} from "./delivery-queue-state-context.js";
import { executeDeliveryQueueOperation } from "./delivery-queue-worker-store.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";

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
}>;

export type LifecycleObligation = DeliveryQueueEntryState & {
  transportId: string;
  binding: ConversationProjectionBinding;
  runId: string;
  generation: string;
  sessionId: string;
  revision: number;
  state: ConversationLifecycleState;
  resultEventId?: string;
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
};

const QUEUE = "conversation-lifecycle-v2";
const TERMINAL = new Set<ConversationLifecycleState>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "unknown",
]);
const RETENTION = { idPrefix: "lifecycle:", maxAgeMs: 30 * 86400_000, maxEntries: 100_000 };
// Unpublished transitions kept for one run, and for one room across its runs.
// Over the room cap each run keeps only its newest unpublished state.
const RUN_PENDING_CAP = 32;
const ROOM_PENDING_CAP = 256;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
// The silent-run sweep removes a context idle for this long even when it still
// had an execution claim or an open approval. Such a run is given the same
// period again to reappear before it is reported interrupted; a run with
// neither, or one whose context went while still active, is reported at once.
const OWNERLESS_HOLD_MS = 30 * 60_000;
// Unpublished status for a room the homeserver refuses is discarded at this age.
const PARKED_ROW_EXPIRY_MS = 24 * 60 * 60_000;
// Status still owed to a room that has refused every send for this long is given up.
const PARKED_ROW_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
// After this many consecutive failures of a room's oldest row, the next row is
// tried once to tell a row the homeserver rejects from a room that is down.
const HEAD_ROW_FAILURES = 5;
// A refusal can be transient, so a parked room is tried once more at this interval.
const PARKED_PROBE_MS = 60 * 60_000;
const SETTLED = new Set<ConversationLifecycleState>(["completed", "failed", "cancelled"]);

type Retry = { failures: number; notBefore: number };

function defer(retries: Map<string, Retry>, key: string, baseMs: number): number {
  const failures = (retries.get(key)?.failures ?? 0) + 1;
  const delay = Math.min(baseMs * 2 ** Math.min(failures - 1, 16), RETRY_MAX_MS);
  retries.set(key, { failures, notBefore: Date.now() + delay });
  return failures;
}

function identity(bindingId: string, runId: string, generation: string): string {
  return `lifecycle:${createHash("sha256")
    .update(JSON.stringify([bindingId, runId, generation]))
    .digest("hex")}`;
}

function lifecycleState(event: AgentEventRuntimePayload): ConversationLifecycleState | undefined {
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

/** Applies an approval to the holder's open set; undefined when the event carries no change. */
function transition(
  holder: { pendingApprovals: string[] },
  event: AgentEventRuntimePayload,
  incomingState: ConversationLifecycleState,
): ConversationLifecycleState | undefined {
  if (event.stream !== "approval") return incomingState;
  const approvalId = [event.data.approvalId, event.data.itemId, event.data.toolCallId].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (!approvalId) return;
  if (event.data.phase === "requested") {
    if (!holder.pendingApprovals.includes(approvalId)) holder.pendingApprovals.push(approvalId);
  } else {
    if (!holder.pendingApprovals.includes(approvalId)) return;
    holder.pendingApprovals = holder.pendingApprovals.filter((id) => id !== approvalId);
  }
  return holder.pendingApprovals.length ? "waiting" : "running";
}

function appendTransition(
  row: LifecycleObligation,
  state: ConversationLifecycleState,
  cap = RUN_PENDING_CAP,
): void {
  // A room that cannot be reached must not fail the run or other rooms, so a
  // full backlog sheds its oldest unpublished transitions instead of throwing.
  // Observers order by revision and tolerate gaps, and nothing is appended
  // after a terminal state except that same state again, so the newest entry
  // kept here is always the run's current state and a terminal is never lost.
  if (row.pending.length >= cap) row.pending.splice(0, row.pending.length - cap + 1);
  row.revision += 1;
  row.state = state;
  const { environment, conversationId, roomId, bindingId } = row.binding;
  row.pending.push({
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
  });
}

/** Install only for a trusted transport with already-persisted canonical bindings. */
export function registerConversationLifecycleTransport(options: {
  transportId: string;
  resolveBindings: (
    owner: Readonly<{ sessionKey: string; sessionId: string; agentId: string }>,
  ) => readonly ConversationProjectionBinding[];
  publish: (
    binding: ConversationProjectionBinding,
    event: ConversationLifecyclePublication,
    transactionId: string,
  ) => Promise<void>;
  /** `detail` names the affected room only; it never carries event content. */
  onError: (
    error: unknown,
    detail?: Readonly<{
      roomId: string;
      reason:
        | "delivery_failed"
        | "backlog_capped"
        | "room_parked"
        | "terminal_after_interrupted"
        | "status_abandoned"
        | "row_stuck";
      failures: number;
    }>,
  ) => void;
  /** True when the destination refused the transport outright and retrying cannot help. */
  isDestinationGone?: (error: unknown) => boolean;
  stateDir?: string;
}) {
  let stopped = false;
  // Delivery failures back off per room, so an unreachable room costs one
  // attempt per period and never delays other rooms. Within a room rows are
  // sent in admission order, so a newer run's state does not overtake an
  // older run's. The one exception is a row set aside as stuck (`heads`).
  // The room's oldest row while it keeps failing, and how often in a row.
  const heads = new Map<string, { id: string; failures: number }>();
  const roomRetries = new Map<string, Retry>();
  let cappedRooms = new Set<string>();
  // Rooms the homeserver refused (bot removed, room gone), by when. A parked
  // room gets one attempt per PARKED_PROBE_MS, and is tried again at once when
  // a new run is admitted for it or an accepted final result proves it open.
  const parked = new Map<string, number>();
  // Whether each open row's owner last held an execution claim or an open
  // approval, when it was last active, and since when it has been missing.
  // The row carries the same evidence from its last transition, so a parked
  // room or a reload cannot leave this empty or stale.
  const liveness = new Map<string, { live: boolean; activeAt: number; missingSince?: number }>();
  // Rows whose interrupted state may have reached the room. In-memory only: a
  // new generation never accepts events for these rows anyway.
  const interruptedSent = new Set<string>();
  const lateTerminals = new Set<string>();
  // Rows whose unsent interrupted was replaced; a delivery already holding the
  // older copy must not send it.
  const superseded = new Set<string>();
  // Runs admitted before any binding existed (typically the first turn of a
  // conversation started outside Matrix). Their state is tracked here so the
  // room learns the current state once the binding appears.
  const unbound = new Map<
    string,
    {
      runId: string;
      generation: string;
      state: ConversationLifecycleState;
      pendingApprovals: string[];
      attempts: number;
      notBefore: number;
      missingSince?: number;
    }
  >();
  // A durable status obligation belongs to this transport, not to the agent
  // event's temporary read/request scope. Retrying after that scope closes must
  // retain the transport's own authority rather than a revoked producer scope.
  const inOwnerContext = AsyncLocalStorage.snapshot();
  const stateContext = captureDeliveryQueueStateContext(options.stateDir);
  let draining: Promise<void> | undefined;
  const owners = new Map<string, readonly ConversationProjectionBinding[]>();
  const retireTimers = new Set<ReturnType<typeof setTimeout>>();
  const read = (id: string) =>
    loadDeliveryQueueEntry(QUEUE, id, options.stateDir) as LifecycleObligation | null;
  const write = (row: LifecycleObligation) => {
    upsertDeliveryQueueEntry({ queueName: QUEUE, entry: row, stateDir: options.stateDir });
  };
  // Plugin replacement may keep the gateway generation alive. Rehydrate frozen
  // destinations before registering hooks so a new UI selection cannot retarget
  // an already admitted run during that replacement window.
  for (const row of loadDeliveryQueueEntries(QUEUE, options.stateDir) as LifecycleObligation[]) {
    if (
      row.transportId !== options.transportId ||
      row.generation !== getAgentRunLifecycleGeneration()
    )
      continue;
    const key = `${row.generation}:${row.runId}`;
    owners.set(key, [...(owners.get(key) ?? []), Object.freeze({ ...row.binding })]);
    // The previous registration may have sent this interrupted and lost the
    // response. The room may hold it, so it is never replaced after a reload.
    if (row.state === "interrupted") interruptedSent.add(row.id);
  }

  const record = (event: AgentEventRuntimePayload) => {
    const incomingState = lifecycleState(event);
    if (!incomingState) return;
    const context = getAgentRunContext(event.runId);
    if (
      context?.isHeartbeat ||
      context?.projectSessionLifecycle === false ||
      context?.projectSessionMessages === false
    )
      return;
    // Ownership is read explicitly; generation is intentionally nonenumerable
    // on public events. Caller-supplied run/session strings confer no authority.
    const generation = event.lifecycleGeneration;
    if (
      !context?.sessionKey ||
      !context.sessionId ||
      !context.agentId ||
      !generation ||
      generation !== getAgentRunLifecycleGeneration() ||
      context.lifecycleGeneration !== generation ||
      (event.sessionId !== undefined && event.sessionId !== context.sessionId) ||
      (event.sessionKey !== undefined && event.sessionKey !== context.sessionKey) ||
      (event.agentId !== undefined && event.agentId !== context.agentId)
    )
      return;
    const sessionId = context.sessionId;
    const ownerKey = `${generation}:${event.runId}`;
    let bindings = owners.get(ownerKey);
    if (!bindings) {
      bindings = options
        .resolveBindings({
          sessionKey: context.sessionKey,
          sessionId: context.sessionId,
          agentId: context.agentId,
        })
        .filter(
          (binding) =>
            binding.sessionKey === context.sessionKey && binding.agentId === context.agentId,
        )
        .map((binding) => Object.freeze({ ...binding }));
      if (!bindings.length) {
        // An empty lookup is not frozen for the run: the binding can be created
        // after admission. Later transitions and the bounded flush retry look
        // again; a run that ends unbound is forgotten.
        let tracked = unbound.get(ownerKey);
        if (TERMINAL.has(incomingState)) {
          unbound.delete(ownerKey);
          return;
        }
        if (!tracked && unbound.size < 10_000) {
          tracked = {
            runId: event.runId,
            generation,
            state: "queued",
            pendingApprovals: [],
            attempts: 0,
            notBefore: Date.now() + RETRY_BASE_MS,
          };
          unbound.set(ownerKey, tracked);
        }
        // As for a bound run, a repeated admission never rewinds the state.
        const state =
          tracked && incomingState !== "queued"
            ? transition(tracked, event, incomingState)
            : undefined;
        if (tracked && state) tracked.state = state;
        return;
      }
      if (owners.size >= 10_000) throw new Error("Conversation lifecycle owners are full");
      owners.set(ownerKey, bindings);
      // A newly admitted run is a good moment to try a parked room once more.
      for (const binding of bindings) parked.delete(binding.roomId);
    }
    const late = unbound.get(ownerKey);
    let adopted = !late;
    const overtaken: string[] = [];
    // The synchronous event contract persists before observers. Its retained
    // transaction also services worker admission while waiting for the writer;
    // raw autocommit writes could deadlock against a worker's commit grant.
    runOpenClawStateWriteTransaction(
      () => {
        for (const binding of bindings) {
          const id = identity(binding.bindingId, event.runId, generation);
          if (getDeliveryQueueEntryStatus(QUEUE, id, options.stateDir) === "completed") continue;
          const existing = read(id);
          if (existing && TERMINAL.has(existing.state)) {
            // A false sweep can close a run that then finishes. Its real outcome
            // replaces an interrupted that has not been sent; once the room may
            // have seen interrupted, the contract forbids changing it.
            if (existing.state !== "interrupted" || !SETTLED.has(incomingState)) continue;
            if (interruptedSent.has(id) || existing.pending.at(-1)?.state !== "interrupted") {
              if (!lateTerminals.has(id)) overtaken.push(binding.roomId);
              lateTerminals.add(id);
              continue;
            }
            existing.pending = existing.pending.filter((event) => event.state !== "interrupted");
            superseded.add(id);
          }
          // Compaction moves a live run to a successor session. The same run id
          // in the same generation is the same run, so the row follows it.
          if (existing) existing.sessionId = sessionId;
          // Registry metadata can be enriched repeatedly after admission. It must
          // never rewind an already started run back into the queue.
          if (existing && incomingState === "queued") continue;
          const row: LifecycleObligation = existing ?? {
            id,
            enqueuedAt: Date.now(),
            retryCount: 0,
            completionRetention: RETENTION,
            transportId: options.transportId,
            binding,
            runId: event.runId,
            generation,
            sessionId,
            revision: 0,
            state: incomingState,
            pending: [],
            pendingApprovals: late ? [...late.pendingApprovals] : [],
            acked: 0,
          };
          let state = transition(row, event, incomingState);
          if (!state) continue;
          // A binding found by re-resolution announces where the run already
          // is; the re-resolving admission must not present it as queued.
          if (!existing && late && incomingState === "queued") state = late.state;
          if (!existing || existing.state !== state)
            appendTransition(row, state, cappedRooms.has(binding.roomId) ? 1 : RUN_PENDING_CAP);
          row.live =
            hasAgentRunContextExecutionOwner(event.runId) || row.pendingApprovals.length > 0;
          row.activeAt = Date.now();
          delete row.missingSince;
          liveness.set(id, { live: row.live, activeAt: row.activeAt });
          write(row);
          adopted = true;
        }
      },
      { env: resolveDeliveryQueueStateEnv(options.stateDir, stateContext) },
      { operationLabel: "record conversation lifecycle transition" },
    );
    // Carried approvals are kept until a row holds them.
    if (adopted) unbound.delete(ownerKey);
    for (const roomId of overtaken)
      options.onError(new Error("Conversation lifecycle run finished after interrupted"), {
        roomId,
        reason: "terminal_after_interrupted",
        failures: 0,
      });
    // Final payload delivery may follow the terminal lifecycle callback. Keep
    // the immutable presentation correlation until bounded lifecycle cleanup.
    if (TERMINAL.has(incomingState)) {
      const timer = setTimeout(() => {
        owners.delete(ownerKey);
        retireTimers.delete(timer);
      }, 30 * 60_000);
      timer.unref();
      retireTimers.add(timer);
    }
    queueMicrotask(() => {
      void flush().catch(options.onError);
    });
  };

  const admit = (runId: string) => {
    const owner = getAgentRunContext(runId);
    if (!owner) return;
    record({
      runId,
      stream: "admission",
      seq: 0,
      ts: Date.now(),
      data: {},
      lifecycleGeneration: owner.lifecycleGeneration,
      sessionKey: owner.sessionKey,
      sessionId: owner.sessionId,
      agentId: owner.agentId,
    });
  };

  // Looks again for the binding of each live unbound run: every 5s for the
  // first minute, then once a minute. Ownership and binding identity are
  // re-validated by `record` exactly as for the original admission.
  const adoptLateBindings = () => {
    const now = Date.now();
    for (const [key, run] of unbound) {
      if (run.generation !== getAgentRunLifecycleGeneration()) {
        unbound.delete(key);
        continue;
      }
      if (!getAgentRunContext(run.runId)) {
        // A swept run can return. Its tracked state is kept for one hold
        // period, so it is not admitted again as queued whatever it was doing.
        run.missingSince ??= now;
        if (now - run.missingSince >= OWNERLESS_HOLD_MS) unbound.delete(key);
        continue;
      }
      run.missingSince = undefined;
      if (run.notBefore > now) continue;
      run.attempts += 1;
      run.notBefore = now + (run.attempts < 12 ? RETRY_BASE_MS : 60_000);
      admit(run.runId);
    }
  };

  const ownerPresent = (row: LifecycleObligation) =>
    row.generation === getAgentRunLifecycleGeneration() && !!getAgentRunContext(row.runId);

  const heldForOwner = (row: LifecycleObligation) => {
    if (row.generation !== getAgentRunLifecycleGeneration()) return false;
    // Without evidence the run is assumed to have held a claim: a late
    // interrupted is recoverable, a false one is terminal.
    const seen = liveness.get(row.id) ?? { live: row.live ?? true, activeAt: row.activeAt ?? 0 };
    liveness.set(row.id, seen);
    const now = Date.now();
    if (!seen.live || now - seen.activeAt < OWNERLESS_HOLD_MS) return false;
    // Measured from the row when a reload has emptied the in-memory record.
    seen.missingSince ??= row.missingSince ?? now;
    return now - seen.missingSince < OWNERLESS_HOLD_MS;
  };

  /** Compare-and-swap in the worker; a row that changed meanwhile is left as it is. */
  const replace = (expected: string, replacement: LifecycleObligation, check?: () => void) =>
    executeDeliveryQueueOperation(
      stateContext,
      options.stateDir,
      {
        type: "deliveryQueue.lifecycleRecover",
        input: { id: replacement.id, expected, replacement },
      },
      {
        createAdmission: () => ({
          nativeLocations: [],
          admission: createSqliteWorkerOperationAdmission((_, grant) => {
            if (stopped) throw new Error("Conversation lifecycle transport stopped");
            check?.();
            grant();
          }),
        }),
      },
    );

  /** Removes a marker from a row unless the row changed meanwhile. */
  const unset = async (id: string, key: "missingSince" | "attempted" | "stuckAt") => {
    const row = (
      await executeDeliveryQueueOperation(stateContext, options.stateDir, {
        type: "deliveryQueue.lifecycleRead",
        input: { id },
      })
    )[0];
    if (!row || row[key] === undefined) return;
    const expected = JSON.stringify(row);
    delete row[key];
    await replace(expected, row);
  };

  // The room knows the run when a send was acknowledged, or failed in a way
  // that can hide a send that landed. Rows from before `acked` existed count.
  const told = (row: LifecycleObligation) => row.acked !== 0 || row.attempted === true;

  const markAttempted = async (id: string): Promise<void> => {
    const row = (
      await executeDeliveryQueueOperation(stateContext, options.stateDir, {
        type: "deliveryQueue.lifecycleRead",
        input: { id },
      })
    )[0];
    if (row && !told(row)) await replace(JSON.stringify(row), { ...row, attempted: true });
  };

  /**
   * Marks a row as stuck, or renews the mark before a retry. Only its newest
   * state is kept: a run's superseded state is never sent after a newer one.
   */
  const setAside = async (id: string): Promise<void> => {
    const row = (
      await executeDeliveryQueueOperation(stateContext, options.stateDir, {
        type: "deliveryQueue.lifecycleRead",
        input: { id },
      })
    )[0];
    if (!row || stopped) return;
    await replace(JSON.stringify(row), {
      ...row,
      stuckAt: Date.now(),
      pending: row.pending.slice(-1),
    });
  };

  const expireParked = async (id: string): Promise<void> => {
    const row = (
      await executeDeliveryQueueOperation(stateContext, options.stateDir, {
        type: "deliveryQueue.lifecycleRead",
        input: { id },
      })
    )[0];
    if (!row || stopped || Date.now() - row.enqueuedAt < PARKED_ROW_EXPIRY_MS) return;
    const open = !TERMINAL.has(row.state);
    if (open && (ownerPresent(row) || heldForOwner(row))) return;
    const expected = JSON.stringify(row);
    if (open) appendTransition(row, "interrupted");
    // A room that was told of the run must still learn how it ended, or the
    // run stays live there for good: only superseded states are dropped and
    // the newest one stays queued for the probe. A run the room never heard
    // of is dropped whole.
    const abandoned = told(row) && Date.now() - row.enqueuedAt >= PARKED_ROW_MAX_AGE_MS;
    row.pending = told(row) && !abandoned ? row.pending.slice(-1) : [];
    if (JSON.stringify(row) === expected) return;
    await replace(expected, row);
    if (abandoned)
      options.onError(new Error("Conversation lifecycle status abandoned"), {
        roomId: row.binding.roomId,
        reason: "status_abandoned",
        failures: 0,
      });
  };

  /** Resolves to the number of publications the destination accepted. */
  const deliver = async (id: string): Promise<number> => {
    let row = (
      await executeDeliveryQueueOperation(stateContext, options.stateDir, {
        type: "deliveryQueue.lifecycleRead",
        input: { id },
      })
    )[0];
    if (!row || stopped) return 0;
    // Restart or the silent-run sweep removed the owner, so nothing can ever
    // report this run again: close it as interrupted. No run is inferred
    // complete and no execution is re-admitted or resumed by recovery. A live
    // owner in this generation is the run itself, whatever session it is on.
    const owner = ownerPresent(row) ? getAgentRunContext(row.runId) : undefined;
    if (!TERMINAL.has(row.state) && owner) {
      liveness.set(id, {
        live: hasAgentRunContextExecutionOwner(row.runId) || row.pendingApprovals.length > 0,
        activeAt: owner.lastActiveAt ?? owner.registeredAt ?? 0,
      });
      // The owner is back, so an earlier absence no longer counts toward a
      // later hold, even when the run returned without recording a transition.
      if (row.missingSince !== undefined) {
        await unset(id, "missingSince");
        delete row.missingSince;
      }
    } else if (!TERMINAL.has(row.state) && heldForOwner(row)) {
      // The hold is bounded in wall time across reloads, so its start is kept.
      const missingSince = liveness.get(id)?.missingSince;
      if (row.missingSince === undefined && missingSince !== undefined)
        await replace(JSON.stringify(row), { ...row, missingSince });
    } else if (!TERMINAL.has(row.state)) {
      const expected = JSON.stringify(row);
      appendTransition(row, "interrupted");
      const recovered = row;
      await replace(expected, recovered, () => {
        if (ownerPresent(recovered)) throw new Error("Conversation lifecycle owner became current");
      });
      row = (
        await executeDeliveryQueueOperation(stateContext, options.stateDir, {
          type: "deliveryQueue.lifecycleRead",
          input: { id },
        })
      )[0];
    }
    let sent = 0;
    let firstSend = false;
    while (row?.pending.length && !stopped) {
      // A send can land and the process die before its response. The row is
      // marked before its first send, once per row, so the run then counts as
      // known to the room; reading it back confirms the mark was written.
      if (!told(row)) {
        await replace(JSON.stringify(row), { ...row, attempted: true });
        firstSend = true;
        row = (
          await executeDeliveryQueueOperation(stateContext, options.stateDir, {
            type: "deliveryQueue.lifecycleRead",
            input: { id },
          })
        )[0];
        continue;
      }
      const event = row.pending[0]!;
      // `record` is synchronous, so it either replaced this interrupted before
      // this check or sees it marked as sent; the copy read here may be stale.
      if (event.state === "interrupted" && superseded.has(id)) {
        superseded.delete(id);
        row = (
          await executeDeliveryQueueOperation(stateContext, options.stateDir, {
            type: "deliveryQueue.lifecycleRead",
            input: { id },
          })
        )[0];
        continue;
      }
      if (event.state === "interrupted") interruptedSent.add(id);
      try {
        await options.publish(row.binding, event, `${row.id}:${event.revision}`);
      } catch (error) {
        // A refusal is the response: the row's first send did not land.
        if (firstSend && options.isDestinationGone?.(error))
          await unset(id, "attempted").catch(options.onError);
        throw error;
      }
      firstSend = false;
      sent += 1;
      // A synchronous lifecycle transition can append while publish awaits;
      // reload its custody rather than overwriting the newer terminal fact.
      row = await executeDeliveryQueueOperation(stateContext, options.stateDir, {
        type: "deliveryQueue.lifecycleAck",
        input: { id, revision: event.revision },
      });
    }
    return sent;
  };

  const flush = (): Promise<void> => {
    if (draining) return draining;
    if (stopped) return Promise.resolve();
    try {
      adoptLateBindings();
    } catch (error) {
      options.onError(error);
    }
    draining = inOwnerContext(async () => {
      // Admission persistence stays synchronous until the event dispatcher has an
      // acknowledged async persistence contract. Delivery never waits for SQLite
      // on that thread: an accepted send is acknowledged by its worker owner.
      const rows = await executeDeliveryQueueOperation(stateContext, options.stateDir, {
        type: "deliveryQueue.lifecycleRead",
        input: {},
      });
      const backlog = new Map<string, number>();
      for (const row of rows) {
        if (row.transportId !== options.transportId) continue;
        const roomId = row.binding.roomId;
        backlog.set(roomId, (backlog.get(roomId) ?? 0) + row.pending.length);
      }
      const capped = new Set<string>();
      for (const [roomId, count] of backlog) {
        if (count < ROOM_PENDING_CAP) continue;
        capped.add(roomId);
        if (!cappedRooms.has(roomId))
          options.onError(new Error("Conversation lifecycle room backlog is capped"), {
            roomId,
            reason: "backlog_capped",
            failures: roomRetries.get(roomId)?.failures ?? 0,
          });
      }
      cappedRooms = capped;
      const present = new Set(rows.map((row) => row.id));
      for (const kept of [liveness, interruptedSent, lateTerminals, superseded])
        for (const id of kept.keys()) if (!present.has(id)) kept.delete(id);
      for (const roomId of parked.keys()) if (!backlog.has(roomId)) parked.delete(roomId);
      for (const roomId of roomRetries.keys()) if (!backlog.has(roomId)) roomRetries.delete(roomId);
      for (const roomId of heads.keys()) if (!backlog.has(roomId)) heads.delete(roomId);
      // Each parked room whose interval has passed probes with its oldest row
      // that still has status worth sending: unexpired, or owed to a room that
      // already knows the run.
      const probes = new Map<string, LifecycleObligation>();
      for (const row of rows) {
        const roomId = row.binding.roomId;
        const parkedAt = parked.get(roomId);
        const now = Date.now();
        if (
          row.transportId === options.transportId &&
          parkedAt !== undefined &&
          now - parkedAt >= PARKED_PROBE_MS &&
          row.pending.length &&
          (now - row.enqueuedAt < PARKED_ROW_EXPIRY_MS ||
            (told(row) && now - row.enqueuedAt < PARKED_ROW_MAX_AGE_MS)) &&
          row.enqueuedAt < (probes.get(roomId)?.enqueuedAt ?? Infinity)
        )
          probes.set(roomId, row);
      }
      // Rooms whose failing oldest row is passed over in this pass.
      const trials = new Map<string, string>();
      for (const [index, initial] of rows.entries()) {
        if (stopped || initial.transportId !== options.transportId) continue;
        // Settled lifecycle rows may intentionally wait for a final-result
        // correlation. They have no publication obligation until noteResult.
        if (!initial.pending.length && TERMINAL.has(initial.state)) continue;
        const roomId = initial.binding.roomId;
        const now = Date.now();
        const probing = parked.has(roomId) && probes.get(roomId)?.id === initial.id;
        if (!parked.has(roomId) && initial.stuckAt !== undefined) {
          // A stuck row never holds back or backs off its room.
          if (now - initial.stuckAt >= PARKED_PROBE_MS)
            // An accepted send clears the mark in the worker; with nothing to
            // send the row is not stuck either, so the run is normal again.
            await setAside(initial.id)
              .then(() => deliver(initial.id))
              .then((sent) => (sent ? undefined : unset(initial.id, "stuckAt")))
              .catch(() => {});
          continue;
        }
        if (!parked.has(roomId) && (roomRetries.get(roomId)?.notBefore ?? 0) > now) continue;
        const head = heads.get(roomId);
        if (
          !parked.has(roomId) &&
          head?.id === initial.id &&
          head.failures >= HEAD_ROW_FAILURES &&
          rows
            .slice(index + 1)
            .some(
              (row) =>
                row.transportId === options.transportId &&
                row.binding.roomId === roomId &&
                row.stuckAt === undefined &&
                row.pending.length > 0,
            )
        ) {
          trials.set(roomId, initial.id);
          continue;
        }
        try {
          if (parked.has(roomId) && !probing) {
            await expireParked(initial.id);
            continue;
          }
          const sent = await deliver(initial.id);
          // Only an accepted send proves a parked room is open again.
          if (probing && !sent) continue;
          parked.delete(roomId);
          roomRetries.delete(roomId);
          const aside = trials.get(roomId);
          if (aside && sent) {
            // A later row went through, so the room is fine and the row is not.
            const failures = heads.get(roomId)?.failures ?? 0;
            trials.delete(roomId);
            heads.delete(roomId);
            await setAside(aside).catch(options.onError);
            options.onError(new Error("Conversation lifecycle row is stuck"), {
              roomId,
              reason: "row_stuck",
              failures,
            });
          } else if (heads.get(roomId)?.id === initial.id) heads.delete(roomId);
        } catch (error) {
          if (stopped) return;
          if (options.isDestinationGone?.(error)) {
            parked.set(roomId, Date.now());
            const failures = (roomRetries.get(roomId)?.failures ?? 0) + 1;
            options.onError(error, { roomId, reason: "room_parked", failures });
            continue;
          }
          // Any other failure is an ordinary outage: back off instead of parking.
          parked.delete(roomId);
          // Its response may have been lost after the send landed.
          await markAttempted(initial.id).catch(options.onError);
          const failures = defer(roomRetries, roomId, RETRY_BASE_MS);
          // The row after a failing head failed as well: it is the room.
          if (trials.delete(roomId)) heads.delete(roomId);
          else
            heads.set(roomId, {
              id: initial.id,
              failures:
                (heads.get(roomId)?.id === initial.id ? heads.get(roomId)!.failures : 0) + 1,
            });
          // A room that stays down reports at 1, 2, 4, 8... failures, not each one.
          if ((failures & (failures - 1)) === 0)
            options.onError(error, { roomId, reason: "delivery_failed", failures });
        }
      }
    }).finally(() => {
      draining = undefined;
    });
    return draining;
  };

  const unsubscribe = registerAgentEventPersistenceHandler(record);
  const unsubscribeAdmission = registerAgentRunAdmissionHandler(admit);
  // A reload forgets which live runs were still waiting for a binding. Each
  // live run without a row is admitted again at the state the registry holds
  // for it, so it gets a row now or is adopted when its binding appears.
  try {
    const generation = getAgentRunLifecycleGeneration();
    // Assumes an ended run's context is cleared: a context left behind after its
    // terminal event would be admitted here as a live run.
    for (const runId of listCurrentAgentRunIds()) {
      const key = `${generation}:${runId}`;
      const context = getAgentRunContext(runId);
      if (
        !context ||
        owners.has(key) ||
        context.isHeartbeat ||
        context.projectSessionLifecycle === false ||
        context.projectSessionMessages === false
      )
        continue;
      const pendingApprovals = [...(context.executionActivity?.pendingApprovalIds ?? [])];
      unbound.set(key, {
        runId,
        generation,
        state: pendingApprovals.length
          ? "waiting"
          : context.lifecycleStartedAt === undefined
            ? "queued"
            : "running",
        pendingApprovals,
        attempts: 0,
        notBefore: Date.now() + RETRY_BASE_MS,
      });
      admit(runId);
    }
  } catch (error) {
    options.onError(error);
  }
  const timer = setInterval(() => {
    void flush().catch(options.onError);
  }, 5_000);
  timer.unref();
  queueMicrotask(() => {
    void flush().catch(options.onError);
  });
  return {
    flush,
    noteResult: (result: {
      runId: string;
      generation: string;
      bindingId: string;
      resultEventId: string;
    }) =>
      runOpenClawStateWriteTransaction(
        () => {
          if (stopped || !result.resultEventId.startsWith("$") || result.resultEventId.length > 255)
            return;
          const row = read(identity(result.bindingId, result.runId, result.generation));
          if (
            !row ||
            row.transportId !== options.transportId ||
            row.resultEventId === result.resultEventId
          )
            return;
          if (row.resultEventId) throw new Error("Conversation final result cannot change");
          row.resultEventId = result.resultEventId;
          // An accepted final event proves the room takes this bot's sends again.
          parked.delete(row.binding.roomId);
          // Terminal can precede visible delivery. Only an accepted final event
          // proves a notification target; a preliminary answer never calls here.
          if (TERMINAL.has(row.state)) appendTransition(row, row.state);
          write(row);
          queueMicrotask(() => {
            void flush().catch(options.onError);
          });
        },
        { env: resolveDeliveryQueueStateEnv(options.stateDir, stateContext) },
        { operationLabel: "record conversation lifecycle result" },
      ),
    resolveRun: (runId: string, sessionKey: string) => {
      const generation = getAgentRunLifecycleGeneration();
      const bindings = owners
        .get(`${generation}:${runId}`)
        ?.filter((binding) => binding.sessionKey === sessionKey);
      return bindings?.length ? { generation, bindings } : undefined;
    },
    stop: () => {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
      unsubscribeAdmission();
      owners.clear();
      unbound.clear();
      for (const retireTimer of retireTimers) clearTimeout(retireTimer);
      retireTimers.clear();
    },
  };
}
