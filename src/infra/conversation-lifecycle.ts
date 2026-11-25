import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentEventRuntimePayload } from "./agent-events.js";
// Durable projection custody; this module never schedules or resumes agent work.
import { registerAgentEventPersistenceHandler } from "./agent-events.js";
import type { AgentRunPersistenceWork } from "./agent-run-persistence.js";
import {
  getAgentRunContext,
  getAgentRunLifecycleGeneration,
  hasAgentRunContextExecutionOwner,
  listCurrentAgentRunIds,
  registerAgentRunAdmissionHandler,
} from "./agent-run-registry.js";
import { createConversationLifecycleDelivery } from "./conversation-lifecycle-delivery.js";
import { prepareConversationLifecycleWrite } from "./conversation-lifecycle-persistence.js";
import {
  readLifecycleRecordReceipt,
  readLifecycleResultReceipt,
} from "./conversation-lifecycle-receipt.js";
import type { LifecycleRecordReceipt } from "./conversation-lifecycle-record.worker.js";
import { createLifecycleRoomScheduler } from "./conversation-lifecycle-room-scheduler.js";
import type { RunStoppedBy } from "./conversation-lifecycle-signals.js";
import type { RunFailureKind } from "./conversation-lifecycle-signals.js";
import { decisionCardsEnabled, lifecycleSignalsEnabled } from "./conversation-lifecycle-signals.js";
import type { ConversationProjectionBinding } from "./conversation-lifecycle.reducer.js";
import type { LifecycleDecisionCard } from "./conversation-lifecycle.reducer.js";
import type { ConversationLifecycleState } from "./conversation-lifecycle.reducer.js";
import type { LifecycleObligation } from "./conversation-lifecycle.reducer.js";
import type { Retry } from "./conversation-lifecycle.reducer.js";
import {
  TERMINAL,
  ROOM_PENDING_CAP,
  RETRY_BASE_MS,
  OWNERLESS_HOLD_MS,
  lifecycleState,
  transition,
  appendTransition,
  noteDecisionCards,
} from "./conversation-lifecycle.reducer.js";
import type {
  ConversationLifecycleTransportOptions,
  LifecycleWriteTiming,
} from "./conversation-lifecycle.types.js";
import { captureDeliveryQueueStateContext } from "./delivery-queue-state-context.js";
import { executeDeliveryQueueOperation } from "./delivery-queue-worker-store.js";

export type {
  ConversationLifecycleState,
  ConversationProjectionBinding,
  ConversationLifecyclePublication,
  LifecycleDecisionCard,
  LifecycleObligation,
} from "./conversation-lifecycle.reducer.js";

/** Install only for a trusted transport with already-persisted canonical bindings. */
export function registerConversationLifecycleTransport(
  options: ConversationLifecycleTransportOptions,
) {
  let stopped = false;
  let closing = false;
  const signalsOn = () => (options.signals ?? lifecycleSignalsEnabled)();
  const cardsOn = () =>
    options.publishDecision !== undefined && (options.decisionCards ?? decisionCardsEnabled)();
  // Failed card sends back off per approval, so one cannot delay a room's facts.
  const cardRetries = new Map<string, Retry>();
  const append = (
    row: LifecycleObligation,
    state: ConversationLifecycleState,
    cap?: number,
    terminal?: { failureKind?: RunFailureKind; stoppedBy?: RunStoppedBy },
  ) => appendTransition(row, state, cap, terminal, signalsOn());
  // Delivery failures back off per room, so an unreachable room costs one
  // attempt per period and never delays other rooms. Within a room rows are
  // sent in admission order, so a newer run's state does not overtake an
  // older run's. The one exception is a row set aside as stuck (`heads`).
  // The room's oldest row while its sends keep failing, and how often in a row.
  const heads = new Map<string, { id: string; failures: number }>();
  // Failed hourly retries of each set-aside row.
  const stuckFailures = new Map<string, number>();
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
  // The last error thrown by `publish` itself, to tell a failed send from any
  // other failure of a delivery.
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
      confirmations: string[];
      cards?: Record<string, LifecycleDecisionCard>;
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
  const owners = new Map<string, readonly ConversationProjectionBinding[]>();
  const capturedOwners = new Set<string>();
  const retireTimers = new Set<ReturnType<typeof setTimeout>>();
  const firstWriteTiming = new Map<string, LifecycleWriteTiming>();
  let committedWriteRevision = 0;
  // Hydration must precede new writes: plugin replacement cannot retarget a run.
  const ready = inOwnerContext(async () => {
    const rows = await executeDeliveryQueueOperation(stateContext, options.stateDir, {
      type: "deliveryQueue.lifecycleRead",
      input: {},
    });
    for (const row of rows) {
      if (
        row.transportId !== options.transportId ||
        row.generation !== getAgentRunLifecycleGeneration()
      )
        continue;
      const key = `${row.generation}:${row.runId}`;
      owners.set(key, [...(owners.get(key) ?? []), Object.freeze({ ...row.binding })]);
      if (row.state === "interrupted") interruptedSent.add(row.id);
    }
  });
  let writerTail = ready;
  type CapturedWrite = AgentRunPersistenceWork & { readonly pending: Promise<void> };
  const pendingWrites = new Map<AgentRunPersistenceWork, Promise<void>>();
  const ownerWrites = new WeakMap<object, CapturedWrite>();
  const captureWrite = (write: () => Promise<void>, ownerKey?: object): AgentRunPersistenceWork => {
    const predecessor = ownerKey ? ownerWrites.get(ownerKey) : undefined;
    let active: Promise<void> | undefined;
    let latest: Promise<void>;
    let claimed = false;
    let committed = false;
    const start = (): Promise<void> => {
      if (closing || stopped)
        return Promise.reject(new Error("Conversation lifecycle transport stopped"));
      const attempt = writerTail.then(async () => {
        await ready;
        await predecessor?.pending;
        await inOwnerContext(write);
      });
      latest = active = attempt;
      writerTail = attempt.catch(() => undefined);
      pendingWrites.set(work, attempt);
      void attempt.then(
        () => {
          committed = true;
          active = undefined;
          pendingWrites.delete(work);
          if (ownerKey && ownerWrites.get(ownerKey) === work) ownerWrites.delete(ownerKey);
        },
        () => {
          active = undefined;
        },
      );
      return attempt;
    };
    const work: CapturedWrite = {
      get pending() {
        return latest;
      },
      run: () => {
        if (!claimed) {
          claimed = true;
          return latest;
        }
        return active ?? (committed ? Promise.resolve() : start());
      },
    };
    if (ownerKey) ownerWrites.set(ownerKey, work);
    start();
    return work;
  };
  const enqueue = (write: () => Promise<void>): Promise<void> => captureWrite(write).run();
  const drainWrites = async (includeFailures = true): Promise<void> => {
    let previous: Promise<void>;
    do {
      previous = writerTail;
      const outcomes = await Promise.allSettled([ready, ...pendingWrites.values()]);
      for (const outcome of outcomes)
        if (includeFailures && outcome.status === "rejected") throw outcome.reason;
    } while (previous !== writerTail);
  };

  const record = (event: AgentEventRuntimePayload) => {
    const incomingState = lifecycleState(event);
    if (!incomingState) return;
    const context = getAgentRunContext(event.runId);
    if (context?.projectSessionLifecycle === false || context?.projectSessionMessages === false)
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
    capturedOwners.add(`${generation}:${event.runId}`);
    const sessionId = context.sessionId;
    const candidateBindings = options
      .resolveBindings({
        sessionKey: context.sessionKey,
        sessionId,
        agentId: context.agentId,
      })
      .filter(
        (binding) =>
          binding.sessionKey === context.sessionKey && binding.agentId === context.agentId,
      )
      .map((binding) => Object.freeze({ ...binding }));
    const capturedEvent = {
      ...event,
      data: structuredClone(event.data),
      lifecycleGeneration: generation,
    };
    const executionOwner = hasAgentRunContextExecutionOwner(event.runId);
    const registeredAt = context.registeredAt;
    const queuedAt =
      incomingState === "queued" && options.onSlowPublish ? performance.now() : undefined;
    const signals = signalsOn();
    const cards = cardsOn();
    const assertCurrent = () => {
      const current = getAgentRunContext(event.runId);
      if (getAgentRunLifecycleGeneration() !== generation || (current && current !== context)) {
        throw new Error("Conversation lifecycle run owner changed before commit");
      }
    };
    let persist: (() => Promise<LifecycleRecordReceipt>) | undefined;
    return captureWrite(async () => {
      assertCurrent();
      // With the switch off none of this runs and the row holds what it always held.
      const ownerKey = `${generation}:${event.runId}`;
      let bindings = owners.get(ownerKey);
      if (!bindings) {
        bindings = candidateBindings;
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
              confirmations: [],
              attempts: 0,
              notBefore: Date.now() + RETRY_BASE_MS,
            };
            unbound.set(ownerKey, tracked);
          }
          // As for a bound run, a repeated admission never rewinds the state.
          const state =
            tracked && incomingState !== "queued"
              ? transition(tracked, capturedEvent, incomingState, true)
              : undefined;
          if (tracked && state) {
            tracked.state = state;
            if (cards) {
              noteDecisionCards(tracked, capturedEvent, state);
            }
          }
          return;
        }
        if (owners.size >= 10_000) throw new Error("Conversation lifecycle owners are full");
        owners.set(ownerKey, bindings);
        // A newly admitted run is a good moment to try a parked room once more.
        for (const binding of bindings) parked.delete(binding.roomId);
      }
      const late = unbound.get(ownerKey);
      persist ??= prepareConversationLifecycleWrite({
        context: stateContext,
        stateDir: options.stateDir,
        command: {
          type: "deliveryQueue.lifecycleRecord",
          input: {
            event: capturedEvent,
            incomingState,
            generation,
            sessionId,
            transportId: options.transportId,
            bindings,
            registeredAt,
            executionOwner,
            signals,
            cards,
            cappedRooms: [...cappedRooms],
            interruptedSent: [...interruptedSent],
            ...(late ? { late: structuredClone(late) } : {}),
          },
        },
        assertCurrent,
        readReceipt: readLifecycleRecordReceipt,
      });
      const writeStartedAt = queuedAt === undefined ? undefined : performance.now();
      const receipt = await persist();
      if (receipt.rows.length) {
        committedWriteRevision += 1;
      }
      const committedAt = writeStartedAt === undefined ? undefined : performance.now();
      for (const row of receipt.rows) {
        liveness.set(row.id, { live: row.live ?? false, activeAt: row.activeAt ?? 0 });
        if (queuedAt !== undefined && writeStartedAt !== undefined && committedAt !== undefined) {
          firstWriteTiming.set(row.id, {
            writerWaitMs: writeStartedAt - queuedAt,
            workerWriteMs: committedAt - writeStartedAt,
            committedAt,
          });
        }
      }
      if (receipt.adopted) unbound.delete(ownerKey);
      for (const { id, roomId } of receipt.overtaken) {
        if (lateTerminals.has(id)) continue;
        lateTerminals.add(id);
        options.onError(new Error("Conversation lifecycle run finished after interrupted"), {
          roomId,
          reason: "terminal_after_interrupted",
          failures: 0,
        });
      }
      // Final payload delivery may follow the terminal lifecycle callback. Keep
      // the immutable presentation correlation until bounded lifecycle cleanup.
      if (TERMINAL.has(incomingState)) {
        const timer = setTimeout(() => {
          owners.delete(ownerKey);
          capturedOwners.delete(ownerKey);
          retireTimers.delete(timer);
        }, 30 * 60_000);
        timer.unref();
        retireTimers.add(timer);
      }
      queueMicrotask(() => {
        wakePublisher();
      });
    }, context);
  };

  const admit = (runId: string) => {
    const owner = getAgentRunContext(runId);
    if (!owner) return;
    return record({
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
  const adoptLateBindings = async () => {
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
      await admit(run.runId)?.run();
    }
  };

  const deliveryState = {
    get stopped() {
      return stopped;
    },
    get closing() {
      return closing;
    },
    publishFailures: new Map<string, unknown>(),
  };
  const { publishRoom } = createConversationLifecycleDelivery({
    options,
    stateContext,
    deliveryState,
    liveness,
    heads,
    cardRetries,
    roomRetries,
    parked,
    interruptedSent,
    stuckFailures,
    firstWriteTiming,
    append,
    enqueue,
    signalsOn,
    cardsOn,
  });

  const roomScheduler = createLifecycleRoomScheduler({
    isClosing: () => closing || stopped,
    publish: (roomId, rows) => inOwnerContext(() => publishRoom(roomId, rows)),
    onSettled: (roomId) => {
      deliveryState.publishFailures.delete(roomId);
    },
    onError: options.onError,
  });
  const { activeRooms } = roomScheduler;
  let scanning: Promise<Promise<void>[]> | undefined;
  let scanAgain = false;
  let refreshingBindings: Promise<void> | undefined;

  const scanCommitted = (): Promise<Promise<void>[]> => {
    if (closing || stopped) {
      return Promise.resolve([]);
    }
    if (scanning) {
      return scanning;
    }
    scanning = inOwnerContext(async () => {
      await ready;
      if (closing) {
        return [];
      }
      const scannedWriteRevision = committedWriteRevision;
      const rows = await executeDeliveryQueueOperation(stateContext, options.stateDir, {
        type: "deliveryQueue.lifecycleRead",
        input: {},
      });
      if (closing) {
        return [];
      }
      const byRoom = new Map<string, LifecycleObligation[]>();
      const backlog = new Map<string, number>();
      for (const row of rows) {
        if (row.transportId !== options.transportId) continue;
        const roomId = row.binding.roomId;
        const group = byRoom.get(roomId) ?? [];
        group.push(row);
        byRoom.set(roomId, group);
        backlog.set(roomId, (backlog.get(roomId) ?? 0) + row.pending.length);
      }
      const capped = new Set(
        [...cappedRooms].filter((roomId) => activeRooms.has(roomId) && !byRoom.has(roomId)),
      );
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
      if (scannedWriteRevision === committedWriteRevision) {
        const present = new Set(rows.map((row) => row.id));
        for (const batch of activeRooms.values()) {
          for (const row of batch.rows) {
            present.add(row.id);
          }
        }
        for (const kept of [
          liveness,
          interruptedSent,
          lateTerminals,
          stuckFailures,
          firstWriteTiming,
        ])
          for (const id of kept.keys()) if (!present.has(id)) kept.delete(id);
      }
      for (const kept of [parked, roomRetries, heads]) {
        for (const roomId of kept.keys()) {
          if (!byRoom.has(roomId) && !activeRooms.has(roomId)) {
            kept.delete(roomId);
          }
        }
      }

      return roomScheduler.schedule(byRoom);
    }).finally(() => {
      scanning = undefined;
      if (scanAgain) {
        scanAgain = false;
        wakePublisher();
      }
    });
    return scanning;
  };

  function wakePublisher(): void {
    if (scanning) {
      scanAgain = true;
    } else {
      void scanCommitted().catch(options.onError);
    }
  }

  const refreshBindings = (): Promise<void> => {
    if (closing || stopped) {
      return Promise.resolve();
    }
    refreshingBindings ??= inOwnerContext(async () => {
      await ready;
      if (!closing) {
        await adoptLateBindings();
      }
    }).finally(() => {
      refreshingBindings = undefined;
    });
    return refreshingBindings;
  };

  // Explicit flush joins captured writes and the resulting sends. Background
  // publication only looks at committed rows so one slow write cannot hold it.
  const flush = async (): Promise<void> => {
    for (;;) {
      await drainWrites(false);
      await refreshBindings();
      await drainWrites(false);
      const tail = writerTail;
      await scanning;
      const batches = await scanCommitted();
      const settled = await Promise.allSettled(batches);
      for (const result of settled) {
        if (result.status === "rejected") {
          throw result.reason;
        }
      }
      if (closing || tail === writerTail) {
        break;
      }
    }
    await drainWrites();
  };

  const unsubscribe = registerAgentEventPersistenceHandler(record);
  const unsubscribeAdmission = registerAgentRunAdmissionHandler(admit);
  // A reload forgets which live runs were still waiting for a binding. Each
  // live run without a row is admitted again at the state the registry holds
  // for it, so it gets a row now or is adopted when its binding appears.
  const restoration = ready.then(async () => {
    if (closing) return;
    const generation = getAgentRunLifecycleGeneration();
    // Assumes an ended run's context is cleared: a context left behind after its
    // terminal event would be admitted here as a live run.
    for (const runId of listCurrentAgentRunIds()) {
      const key = `${generation}:${runId}`;
      const context = getAgentRunContext(runId);
      if (
        !context ||
        owners.has(key) ||
        capturedOwners.has(key) ||
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
        // The registry keeps ids, not kinds: a run adopted after a reload names nothing it waits on.
        confirmations: [],
        attempts: 0,
        notBefore: Date.now() + RETRY_BASE_MS,
      });
      await admit(runId)?.run();
    }
  });
  void restoration.catch(() => undefined);
  const timer = setInterval(() => {
    void refreshBindings().catch(options.onError);
    wakePublisher();
  }, 5_000);
  timer.unref();
  queueMicrotask(wakePublisher);
  const resultWrites = new Map<string, AgentRunPersistenceWork>();
  return {
    flush,
    ready: restoration,
    noteResult: (result: {
      runId: string;
      generation: string;
      bindingId: string;
      resultEventId: string;
    }): Promise<void> => {
      if (!result.resultEventId.startsWith("$") || result.resultEventId.length > 255) {
        return Promise.reject(new Error("Invalid conversation final result event"));
      }
      const key = JSON.stringify(result);
      let work = resultWrites.get(key);
      if (!work) {
        const persist = prepareConversationLifecycleWrite({
          context: stateContext,
          stateDir: options.stateDir,
          command: {
            type: "deliveryQueue.lifecycleNoteResult",
            input: {
              ...result,
              transportId: options.transportId,
              signals: signalsOn(),
              now: Date.now(),
            },
          },
          assertCurrent: () => {
            if (stopped) throw new Error("Conversation lifecycle transport stopped");
          },
          readReceipt: readLifecycleResultReceipt,
        });
        work = captureWrite(async () => {
          const receipt = await persist();
          if (receipt.roomId) parked.delete(receipt.roomId);
          queueMicrotask(() => {
            wakePublisher();
          });
        });
        resultWrites.set(key, work);
      }
      const owned = work;
      return work.run().then(() => {
        if (resultWrites.get(key) === owned) resultWrites.delete(key);
      });
    },
    resolveRun: (runId: string, sessionKey: string) => {
      const generation = getAgentRunLifecycleGeneration();
      const bindings = owners
        .get(`${generation}:${runId}`)
        ?.filter((binding) => binding.sessionKey === sessionKey);
      return bindings?.length ? { generation, bindings } : undefined;
    },
    stop: async (): Promise<void> => {
      closing = true;
      clearInterval(timer);
      unsubscribe();
      unsubscribeAdmission();
      roomScheduler.cancelPending();
      const settled = await Promise.allSettled([
        restoration,
        drainWrites(),
        refreshingBindings,
        scanning,
        ...Array.from(activeRooms.values(), (batch) => batch.done.promise),
      ]);
      stopped = true;
      owners.clear();
      capturedOwners.clear();
      unbound.clear();
      for (const retireTimer of retireTimers) clearTimeout(retireTimer);
      retireTimers.clear();
      for (const result of settled) if (result.status === "rejected") throw result.reason;
    },
  };
}
