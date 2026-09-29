// Durable projection custody; this module never schedules or resumes agent work.
import { createHash } from "node:crypto";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  isDefinitiveRunLifecycle,
} from "../agents/agent-run-terminal-outcome.js";
import {
  registerAgentEventPersistenceHandler,
  type AgentEventRuntimePayload,
} from "./agent-events.js";
import {
  getAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunAdmissionHandler,
} from "./agent-run-registry.js";
import {
  completeDeliveryQueueEntry,
  getDeliveryQueueEntryStatus,
  loadDeliveryQueueEntries,
  loadDeliveryQueueEntry,
  upsertDeliveryQueueEntry,
  type DeliveryQueueEntryState,
} from "./delivery-queue-sqlite.js";

export type ConversationLifecycleState =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
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

type LifecycleObligation = DeliveryQueueEntryState & {
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
};

const QUEUE = "conversation-lifecycle-v2";
const TERMINAL = new Set<ConversationLifecycleState>([
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);
const RETENTION = { idPrefix: "lifecycle:", maxAgeMs: 30 * 86400_000, maxEntries: 100_000 };

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
  return outcome.reason === "timed_out" ? "unknown" : "failed";
}

function appendTransition(row: LifecycleObligation, state: ConversationLifecycleState): void {
  // Unresolved obligations are never evicted. Backpressure is explicit rather
  // than dropping a transition while advertising durable custody to observers.
  if (row.pending.length >= 256) throw new Error("Conversation lifecycle custody is full");
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
  onError: (error: unknown) => void;
  stateDir?: string;
}) {
  let stopped = false;
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
    const ownerKey = `${generation}:${event.runId}`;
    let bindings = owners.get(ownerKey);
    if (!bindings) {
      if (owners.size >= 10_000) throw new Error("Conversation lifecycle owners are full");
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
      owners.set(ownerKey, bindings);
    }
    for (const binding of bindings) {
      const id = identity(binding.bindingId, event.runId, generation);
      if (getDeliveryQueueEntryStatus(QUEUE, id, options.stateDir) === "completed") continue;
      const existing = read(id);
      if (existing && existing.sessionId !== context.sessionId) continue;
      if (existing && TERMINAL.has(existing.state)) continue;
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
        sessionId: context.sessionId,
        revision: 0,
        state: incomingState,
        pending: [],
        pendingApprovals: [],
      };
      let state = incomingState;
      if (event.stream === "approval") {
        const approvalId = [event.data.approvalId, event.data.itemId, event.data.toolCallId].find(
          (value): value is string => typeof value === "string" && value.length > 0,
        );
        if (!approvalId) continue;
        if (event.data.phase === "requested") {
          if (!row.pendingApprovals.includes(approvalId)) row.pendingApprovals.push(approvalId);
        } else {
          if (!row.pendingApprovals.includes(approvalId)) continue;
          row.pendingApprovals = row.pendingApprovals.filter((id) => id !== approvalId);
        }
        state = row.pendingApprovals.length ? "waiting" : "running";
      }
      if (!existing || existing.state !== state) appendTransition(row, state);
      write(row);
    }
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

  const flush = (): Promise<void> => {
    if (draining) return draining;
    if (stopped) return Promise.resolve();
    draining = (async () => {
      const rows = loadDeliveryQueueEntries(QUEUE, options.stateDir) as LifecycleObligation[];
      for (const initial of rows) {
        if (stopped || initial.transportId !== options.transportId) continue;
        let row = read(initial.id);
        if (!row) continue;
        // Restart closes only projection liveness. No run is inferred complete
        // and no execution is re-admitted or resumed by delivery recovery.
        const currentOwner = getAgentRunContext(row.runId);
        if (
          (row.generation !== getAgentRunLifecycleGeneration() ||
            !currentOwner ||
            currentOwner.sessionId !== row.sessionId) &&
          !TERMINAL.has(row.state)
        ) {
          appendTransition(row, "unknown");
          write(row);
        }
        while (row?.pending.length && !stopped) {
          const event = row.pending[0]!;
          await options.publish(row.binding, event, `${row.id}:${event.revision}`);
          // A synchronous lifecycle transition can append while publish awaits;
          // reload its custody rather than overwriting the newer terminal fact.
          row = read(initial.id);
          if (!row) break;
          row.pending = row.pending.filter((pending) => pending.revision > event.revision);
          if (row.pending.length === 0 && TERMINAL.has(row.state) && row.resultEventId) {
            completeDeliveryQueueEntry(QUEUE, row.id, options.stateDir);
            break;
          }
          write(row);
        }
      }
    })().finally(() => {
      draining = undefined;
    });
    return draining;
  };

  const unsubscribe = registerAgentEventPersistenceHandler(record);
  const unsubscribeAdmission = registerAgentRunAdmissionHandler((runId) => {
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
  });
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
    }) => {
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
      // Terminal can precede visible delivery. Only an accepted final event
      // proves a notification target; a preliminary answer never calls here.
      if (TERMINAL.has(row.state)) appendTransition(row, row.state);
      write(row);
      queueMicrotask(() => {
        void flush().catch(options.onError);
      });
    },
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
      for (const retireTimer of retireTimers) clearTimeout(retireTimer);
      retireTimers.clear();
    },
  };
}
