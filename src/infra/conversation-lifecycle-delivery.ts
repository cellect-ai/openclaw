import {
  getAgentRunContext,
  getAgentRunLifecycleGeneration,
  hasAgentRunContextExecutionOwner,
} from "./agent-run-registry.js";
import type { RunStoppedBy } from "./conversation-lifecycle-signals.js";
import type { RunFailureKind } from "./conversation-lifecycle-signals.js";
import {
  buildConfirmationCard,
  decisionCardContent,
  factForSend,
} from "./conversation-lifecycle-signals.js";
import type { LifecycleDecisionCard } from "./conversation-lifecycle.reducer.js";
import type { ConversationLifecycleState } from "./conversation-lifecycle.reducer.js";
import type { LifecycleObligation } from "./conversation-lifecycle.reducer.js";
import type { Retry } from "./conversation-lifecycle.reducer.js";
import {
  TERMINAL,
  OWNERLESS_HOLD_MS,
  PARKED_ROW_EXPIRY_MS,
  PARKED_ROW_MAX_AGE_MS,
  PARKED_PROBE_MS,
  HEAD_ROW_FAILURES,
  RETRY_BASE_MS,
  HEARTBEAT_WAIT_LIMIT_MS,
  HEARTBEAT_INTERVAL_MS,
  appendHeartbeat,
  cancelOpenCards,
  giveUpCards,
  defer,
} from "./conversation-lifecycle.reducer.js";
import type {
  ConversationLifecycleTransportOptions,
  LifecycleWriteTiming,
} from "./conversation-lifecycle.types.js";
import type { captureDeliveryQueueStateContext } from "./delivery-queue-state-context.js";
import { executeDeliveryQueueOperation } from "./delivery-queue-worker-store.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";

/** Transport delivery and recovery share the same admitted state and write queue. */
export function createConversationLifecycleDelivery(params: {
  options: ConversationLifecycleTransportOptions;
  stateContext: ReturnType<typeof captureDeliveryQueueStateContext>;
  deliveryState: {
    readonly stopped: boolean;
    readonly closing: boolean;
    publishFailures: Map<string, unknown>;
  };
  liveness: Map<string, { live: boolean; activeAt: number; missingSince?: number }>;
  heads: Map<string, { id: string; failures: number }>;
  cardRetries: Map<string, Retry>;
  roomRetries: Map<string, Retry>;
  stuckFailures: Map<string, number>;
  parked: Map<string, number>;
  interruptedSent: Set<string>;
  firstWriteTiming: Map<string, LifecycleWriteTiming>;
  append: (
    row: LifecycleObligation,
    state: ConversationLifecycleState,
    cap?: number,
    terminal?: { failureKind?: RunFailureKind; stoppedBy?: RunStoppedBy },
  ) => void;
  enqueue: (write: () => Promise<void>) => Promise<void>;
  signalsOn: () => boolean;
  cardsOn: () => boolean;
}) {
  const {
    options,
    stateContext,
    deliveryState,
    liveness,
    heads,
    cardRetries,
    roomRetries,
    stuckFailures,
    parked,
    interruptedSent,
    firstWriteTiming,
    append,
    enqueue,
    signalsOn,
    cardsOn,
  } = params;
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

  const publicationAdmission = () => ({
    nativeLocations: [],
    admission: createSqliteWorkerOperationAdmission((_, grant) => {
      if (deliveryState.stopped) throw new Error("Conversation lifecycle transport stopped");
      grant();
    }),
  });

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
            if (deliveryState.stopped) throw new Error("Conversation lifecycle transport stopped");
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

  // The room knows the run when a send was acknowledged, or was started and
  // not refused. Rows from before `acked` existed count.
  const told = (row: LifecycleObligation) => row.acked !== 0 || row.attempted === true;

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
    if (!row || deliveryState.stopped) return;
    await replace(JSON.stringify(row), {
      ...row,
      stuckAt: Date.now(),
      pending: row.pending.slice(-1),
    });
  };

  /**
   * The room's oldest row has just failed again. The next row is sent once: if
   * it fails too the room is down. If it goes through the room works, and the
   * oldest row gets one more send straight away, so an outage that ended in
   * between does not set a healthy row aside. True when the room works.
   */
  const isolatesHead = async (
    head: LifecycleObligation,
    next: LifecycleObligation,
    failures: number,
  ): Promise<boolean> => {
    const roomId = head.binding.roomId;
    try {
      if (!(await deliver(next.id))) return false;
    } catch {
      heads.delete(roomId);
      return false;
    }
    heads.delete(roomId);
    try {
      await deliver(head.id);
    } catch (error) {
      if (
        deliveryState.stopped ||
        !deliveryState.publishFailures.has(roomId) ||
        error !== deliveryState.publishFailures.get(roomId) ||
        options.isDestinationGone?.(error)
      )
        return true;
      await setAside(head.id).catch(options.onError);
      options.onError(new Error("Conversation lifecycle row is stuck"), {
        roomId,
        reason: "row_stuck",
        failures,
      });
    }
    return true;
  };

  /** Gives up the status a row still owes, and reports it only once the row shows it. */
  const abandon = async (id: string): Promise<void> => {
    const read = async () =>
      (
        await executeDeliveryQueueOperation(stateContext, options.stateDir, {
          type: "deliveryQueue.lifecycleRead",
          input: { id },
        })
      )[0];
    const row = await read();
    if (!row || deliveryState.stopped || (!TERMINAL.has(row.state) && ownerPresent(row))) return;
    const expected = JSON.stringify(row);
    if (!TERMINAL.has(row.state)) {
      append(row, "interrupted");
    }
    // The room is given up, so what it was owed in cards is too.
    giveUpCards(row);
    row.pending = [];
    delete row.stuckAt;
    await replace(expected, row);
    const after = await read();
    if (
      after &&
      !after.pending.length &&
      after.stuckAt === undefined &&
      after.revision === row.revision
    )
      options.onError(new Error("Conversation lifecycle status abandoned"), {
        roomId: row.binding.roomId,
        reason: "status_abandoned",
        failures: 0,
      });
  };

  const expireParked = async (id: string): Promise<void> => {
    const row = (
      await executeDeliveryQueueOperation(stateContext, options.stateDir, {
        type: "deliveryQueue.lifecycleRead",
        input: { id },
      })
    )[0];
    if (!row || deliveryState.stopped || Date.now() - row.enqueuedAt < PARKED_ROW_EXPIRY_MS) return;
    const open = !TERMINAL.has(row.state);
    if (open && (ownerPresent(row) || heldForOwner(row))) return;
    const expected = JSON.stringify(row);
    if (open) {
      append(row, "interrupted");
      cancelOpenCards(row);
    }
    // A room that was told of the run must still learn how it ended, or the
    // run stays live there for good: only superseded states are dropped and
    // the newest one stays queued for the probe. A run the room never heard
    // of is dropped whole.
    if (told(row) && Date.now() - row.enqueuedAt >= PARKED_ROW_MAX_AGE_MS) return abandon(id);
    row.pending = told(row) ? row.pending.slice(-1) : [];
    // A run the room never heard of never had a card either.
    if (!told(row)) {
      giveUpCards(row);
    }
    if (JSON.stringify(row) !== expected) await replace(expected, row);
  };

  /**
   * Keeps the start of a hold on the row, for every open row in every pass
   * whether or not its room is being delivered to: the hold is then bounded in
   * wall time across reloads, and an owner seen again ends it even when the
   * run returned without a transition or its room is parked or backing off.
   */
  const trackOwner = async (row: LifecycleObligation): Promise<void> => {
    if (TERMINAL.has(row.state) || row.generation !== getAgentRunLifecycleGeneration()) return;
    if (ownerPresent(row)) {
      delete liveness.get(row.id)?.missingSince;
      if (row.missingSince !== undefined) await unset(row.id, "missingSince");
      return;
    }
    if (!heldForOwner(row) || row.missingSince !== undefined) return;
    const current = (
      await executeDeliveryQueueOperation(stateContext, options.stateDir, {
        type: "deliveryQueue.lifecycleRead",
        input: { id: row.id },
      })
    )[0];
    const missingSince = liveness.get(row.id)?.missingSince;
    if (current && !TERMINAL.has(current.state) && current.missingSince === undefined)
      await replace(JSON.stringify(current), { ...current, missingSince });
  };

  /** Resolves to the number of publications the destination accepted. */
  const deliver = async (id: string): Promise<number> => {
    let row = (
      await executeDeliveryQueueOperation(stateContext, options.stateDir, {
        type: "deliveryQueue.lifecycleRead",
        input: { id },
      })
    )[0];
    if (!row || deliveryState.stopped || deliveryState.closing) {
      return 0;
    }
    deliveryState.publishFailures.delete(row.binding.roomId);
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
    } else if (!TERMINAL.has(row.state) && !heldForOwner(row)) {
      const expected = JSON.stringify(row);
      append(row, "interrupted");
      cancelOpenCards(row);
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
    while (row?.pending.length && !deliveryState.stopped && !deliveryState.closing) {
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
      let event = row.pending[0]!;
      if (event.state === "interrupted") {
        // Serialize the exact publication claim with lifecycle transitions. The
        // last worker read and in-memory claim have no await between them, so a
        // later terminal either supersedes before the claim or observes it.
        let current: LifecycleObligation | undefined;
        await enqueue(async () => {
          current = (
            await executeDeliveryQueueOperation(stateContext, options.stateDir, {
              type: "deliveryQueue.lifecycleRead",
              input: { id },
            })
          )[0];
          if (current?.pending[0]?.state === "interrupted") interruptedSent.add(id);
        });
        row = current;
        if (!row?.pending.length) break;
        event = row.pending[0]!;
      }
      if (deliveryState.closing || deliveryState.stopped) {
        break;
      }
      const startedAt = options.onSlowPublish ? performance.now() : undefined;
      const occurredAt =
        event.revision === 1 ? row.enqueuedAt : row.signals?.[event.revision]?.atMs;
      const ageAtSendMs =
        startedAt !== undefined && occurredAt !== undefined
          ? Math.max(0, Date.now() - occurredAt)
          : undefined;
      try {
        await options.publish(
          row.binding,
          factForSend(
            { ...event, ...row.signals?.[event.revision] },
            { signals: signalsOn(), decisionCards: cardsOn() },
          ),
          `${row.id}:${event.revision}`,
        );
      } catch (error) {
        deliveryState.publishFailures.set(row.binding.roomId, error);
        // A refusal is the response: the row's first send did not land.
        if (firstSend && options.isDestinationGone?.(error))
          await unset(id, "attempted").catch(options.onError);
        throw error;
      }
      if (startedAt !== undefined) {
        const matrixAckMs = performance.now() - startedAt;
        const timing = event.revision === 1 ? firstWriteTiming.get(id) : undefined;
        if (timing) {
          firstWriteTiming.delete(id);
        }
        if ((ageAtSendMs ?? 0) + matrixAckMs >= 1_000) {
          try {
            options.onSlowPublish?.({
              roomId: row.binding.roomId,
              revision: event.revision,
              ageAtSendMs,
              writerWaitMs: timing?.writerWaitMs,
              workerWriteMs: timing?.workerWriteMs,
              committedToSendMs: timing ? Math.max(0, startedAt - timing.committedAt) : undefined,
              matrixAckMs,
            });
          } catch {
            // A diagnostic sink cannot turn an accepted send into a retry.
          }
        }
      }
      firstSend = false;
      sent += 1;
      // A lifecycle transition can append while publish awaits;
      // reload its custody rather than overwriting the newer terminal fact.
      row = await executeDeliveryQueueOperation(
        stateContext,
        options.stateDir,
        {
          type: "deliveryQueue.lifecycleAck",
          input: { id, revision: event.revision },
        },
        { createAdmission: publicationAdmission },
      );
    }
    if (firstSend && deliveryState.closing) {
      await unset(id, "attempted").catch(options.onError);
    }
    // Cards follow the facts and never hold them back: a card that cannot be
    // sent is retried on its own backoff and reported, and the room's status goes on.
    if (row && !deliveryState.closing && cardsOn()) {
      await sendDecisionCards(row).catch(options.onError);
    }
    return sent;
  };

  /** A card the room has refused for this long past its expiry is not worth sending any more. */
  const cardLapsed = (card: LifecycleDecisionCard) =>
    Date.now() > card.expiresAtMs + PARKED_PROBE_MS;

  const owesCards = (row: LifecycleObligation) =>
    cardsOn() &&
    Object.values(row.cards ?? {}).some((card) => card.sent < card.revision && !cardLapsed(card));

  /** Sends each card's newest revision, then records it as sent unless the row changed meanwhile. */
  const sendDecisionCards = async (row: LifecycleObligation): Promise<void> => {
    for (const [approvalId, card] of Object.entries(row.cards ?? {})) {
      if (deliveryState.closing || deliveryState.stopped) {
        return;
      }
      if (card.sent >= card.revision || cardLapsed(card)) {
        continue;
      }
      const retry = cardRetries.get(`${row.id}:${approvalId}`);
      if (retry && retry.notBefore > Date.now()) {
        continue;
      }
      const built = buildConfirmationCard({
        id: approvalId,
        revision: card.revision,
        status: card.status,
        runId: row.runId,
        expiresAtMs: card.expiresAtMs,
        conversation: card.conversation,
        decisions: card.decisions,
      });
      try {
        // A card the contract would reject is never sent; it is marked sent so it is not retried forever.
        if (built) {
          await options.publishDecision!(
            row.binding,
            decisionCardContent(built, row.binding.threadRootEventId),
            `${row.id}:card:${approvalId}:${card.revision}`,
          );
        }
      } catch (error) {
        const failures = defer(cardRetries, `${row.id}:${approvalId}`, RETRY_BASE_MS);
        if ((failures & (failures - 1)) === 0) {
          options.onError(error, {
            roomId: row.binding.roomId,
            reason: "delivery_failed",
            failures,
          });
        }
        continue;
      }
      cardRetries.delete(`${row.id}:${approvalId}`);
      const current = (
        await executeDeliveryQueueOperation(stateContext, options.stateDir, {
          type: "deliveryQueue.lifecycleRead",
          input: { id: row.id },
        })
      )[0];
      const held = current?.cards?.[approvalId];
      if (!current || !held || held.sent >= card.revision) {
        continue;
      }
      await replace(JSON.stringify(current), {
        ...current,
        cards: { ...current.cards, [approvalId]: { ...held, sent: card.revision } },
      });
    }
    await completeSettled(row.id);
  };

  /**
   * A settled row is held while it owes cards (the worker does not complete
   * it), so the last card's answer is never lost with the row. Once every card
   * is sent it is completed here, as its last fact's acknowledgement would have.
   */
  const completeSettled = async (id: string): Promise<void> => {
    const current = (
      await executeDeliveryQueueOperation(stateContext, options.stateDir, {
        type: "deliveryQueue.lifecycleRead",
        input: { id },
      })
    )[0];
    if (
      !current ||
      deliveryState.stopped ||
      !current.cards ||
      !TERMINAL.has(current.state) ||
      current.pending.length ||
      !current.resultEventId ||
      Object.values(current.cards).some((card) => card.sent < card.revision)
    ) {
      return;
    }
    await executeDeliveryQueueOperation(
      stateContext,
      options.stateDir,
      {
        type: "deliveryQueue.lifecycleAck",
        input: { id, revision: current.revision },
      },
      { createAdmission: publicationAdmission },
    );
  };

  /**
   * The cards a settled row still owes are given up so the row can complete:
   * all of them when cards are switched off, else only those long past expiry
   * (a room that refuses a card for good must not keep the row queued).
   */
  const releaseCards = async (id: string): Promise<void> => {
    const current = (
      await executeDeliveryQueueOperation(stateContext, options.stateDir, {
        type: "deliveryQueue.lifecycleRead",
        input: { id },
      })
    )[0];
    if (
      !current ||
      deliveryState.stopped ||
      !TERMINAL.has(current.state) ||
      current.pending.length
    ) {
      return;
    }
    const expected = JSON.stringify(current);
    const all = !cardsOn();
    for (const card of Object.values(current.cards ?? {})) {
      if (card.sent < card.revision && (all || cardLapsed(card))) {
        card.sent = card.revision;
      }
    }
    await replace(expected, current);
    await completeSettled(id);
  };

  /**
   * The run's heartbeat: with the signals on, nothing of the run waiting to be
   * sent and its executor still holding its claim, the current state is
   * published again under a newer `atMs`. It reports a claim that is live and
   * nothing more: it does not refresh the registry, so a run that holds its
   * claim and does nothing is swept at the same time as ever and reported
   * interrupted. A run waiting on a person is vouched for for the first hour of
   * the wait only.
   */
  const heartbeat = async (row: LifecycleObligation): Promise<void> => {
    if (
      !signalsOn() ||
      TERMINAL.has(row.state) ||
      row.generation !== getAgentRunLifecycleGeneration()
    ) {
      return;
    }
    if (!hasAgentRunContextExecutionOwner(row.runId)) {
      return;
    }
    const now = Date.now();
    if (
      row.state === "waiting" &&
      now - (row.activeAt ?? row.enqueuedAt) >= HEARTBEAT_WAIT_LIMIT_MS
    ) {
      return;
    }
    if (
      row.pending.length ||
      now - (row.heartbeatAt ?? row.activeAt ?? row.enqueuedAt) < HEARTBEAT_INTERVAL_MS
    ) {
      return;
    }
    if (parked.has(row.binding.roomId) || row.stuckAt !== undefined) {
      return;
    }
    const current = (
      await executeDeliveryQueueOperation(stateContext, options.stateDir, {
        type: "deliveryQueue.lifecycleRead",
        input: { id: row.id },
      })
    )[0];
    if (
      !current ||
      deliveryState.stopped ||
      TERMINAL.has(current.state) ||
      current.pending.length
    ) {
      return;
    }
    const expected = JSON.stringify(current);
    appendHeartbeat(current);
    await replace(expected, current, () => {
      if (!hasAgentRunContextExecutionOwner(current.runId)) {
        throw new Error("Conversation lifecycle owner is gone");
      }
    });
  };

  const publishRoom = async (roomId: string, rows: LifecycleObligation[]): Promise<void> => {
    const parkedAt = parked.get(roomId);
    const scanTime = Date.now();
    // Rows are ordered by admission. Probe the oldest parked row that still matters.
    const probe =
      parkedAt !== undefined && scanTime - parkedAt >= PARKED_PROBE_MS
        ? rows.find(
            (row) =>
              row.pending.length &&
              (scanTime - row.enqueuedAt < PARKED_ROW_EXPIRY_MS ||
                (told(row) && scanTime - row.enqueuedAt < PARKED_ROW_MAX_AGE_MS)),
          )
        : undefined;
    for (const [index, initial] of rows.entries()) {
      if (deliveryState.stopped || deliveryState.closing) {
        return;
      }
      if (options.onRetiredProducer && initial.generation !== getAgentRunLifecycleGeneration()) {
        const admittedGeneration = getAgentRunLifecycleGeneration();
        const assertRetired = () => {
          if (
            deliveryState.stopped ||
            deliveryState.closing ||
            getAgentRunLifecycleGeneration() !== admittedGeneration ||
            initial.generation === admittedGeneration
          ) {
            throw new Error("Conversation final producer retirement lost its native owner");
          }
        };
        // Include terminal rows with no pending status: dispatch closure can be
        // lost after the model's terminal event was already acknowledged.
        await options
          .onRetiredProducer(
            {
              runId: initial.runId,
              generation: initial.generation,
              sessionId: initial.sessionId,
              binding: initial.binding,
            },
            assertRetired,
          )
          .catch(options.onError);
      }
      // Settled lifecycle rows may intentionally wait for a final-result
      // correlation. They have no publication obligation until noteResult.
      if (!initial.pending.length && TERMINAL.has(initial.state) && !owesCards(initial)) {
        if (
          initial.resultEventId &&
          Object.values(initial.cards ?? {}).some((card) => card.sent < card.revision)
        ) {
          await releaseCards(initial.id).catch(options.onError);
        }
        continue;
      }
      const now = Date.now();
      await trackOwner(initial).catch(options.onError);
      await heartbeat(initial).catch(options.onError);
      const probing = parked.has(roomId) && probe?.id === initial.id;
      if (!parked.has(roomId) && initial.stuckAt !== undefined) {
        // A stuck row never holds back or backs off its room. It ends like a
        // parked one: after PARKED_ROW_MAX_AGE_MS its status is given up.
        if (now - initial.enqueuedAt >= PARKED_ROW_MAX_AGE_MS)
          await abandon(initial.id).catch(options.onError);
        else if (now - initial.stuckAt >= PARKED_PROBE_MS)
          // An accepted send clears the mark in the worker; with nothing to
          // send the row is not stuck either, so the run is normal again.
          await setAside(initial.id)
            .then(() => deliver(initial.id))
            .then((sent) => (sent ? undefined : unset(initial.id, "stuckAt")))
            .then(() => stuckFailures.delete(initial.id))
            .catch((error: unknown) => {
              const failures = (stuckFailures.get(initial.id) ?? 0) + 1;
              stuckFailures.set(initial.id, failures);
              // Reported at 1, 2, 4, 8... failed retries, like a room that is down.
              if (!deliveryState.stopped && (failures & (failures - 1)) === 0)
                options.onError(error, { roomId, reason: "row_stuck", failures });
            });
        continue;
      }
      if (!parked.has(roomId) && (roomRetries.get(roomId)?.notBefore ?? 0) > now) continue;
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
        heads.delete(roomId);
      } catch (error) {
        if (deliveryState.stopped || deliveryState.closing) {
          return;
        }
        if (options.isDestinationGone?.(error)) {
          parked.set(roomId, Date.now());
          heads.delete(roomId);
          const failures = (roomRetries.get(roomId)?.failures ?? 0) + 1;
          options.onError(error, { roomId, reason: "room_parked", failures });
          continue;
        }
        // Any other failure is an ordinary outage: back off instead of parking.
        parked.delete(roomId);
        const failures = defer(roomRetries, roomId, RETRY_BASE_MS);
        // Only a failed send counts against the row; anything else thrown by
        // a delivery says nothing about the row or its room.
        if (
          deliveryState.publishFailures.has(roomId) &&
          error === deliveryState.publishFailures.get(roomId)
        ) {
          const head = heads.get(roomId);
          const count = (head?.id === initial.id ? head.failures : 0) + 1;
          heads.set(roomId, { id: initial.id, failures: count });
          const next = rows
            .slice(index + 1)
            .find((row) => row.stuckAt === undefined && row.pending.length > 0);
          if (count >= HEAD_ROW_FAILURES && next && (await isolatesHead(initial, next, count)))
            roomRetries.delete(roomId);
        }
        // A room that stays down reports at 1, 2, 4, 8... failures, not each one.
        if ((failures & (failures - 1)) === 0)
          options.onError(error, { roomId, reason: "delivery_failed", failures });
      }
    }
  };

  return { publishRoom };
}
