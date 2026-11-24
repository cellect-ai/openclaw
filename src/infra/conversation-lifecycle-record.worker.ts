import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { AgentEventPayload } from "./agent-events.types.js";
import { hasLegacySettledLifecycleObligationInDatabase } from "./conversation-lifecycle-legacy.worker.js";
import { lifecycleWriteFingerprint } from "./conversation-lifecycle-receipt.js";
import { isLifecycleTime, waitingOnOf } from "./conversation-lifecycle-signals.js";
import {
  type ConversationProjectionBinding,
  type ConversationLifecycleState,
  type LifecycleObligation,
  QUEUE,
  TERMINAL,
  SETTLED,
  RETENTION,
  RUN_PENDING_CAP,
  identity,
  transition,
  terminalSignalsOf,
  appendTransition,
  noteDecisionCards,
} from "./conversation-lifecycle.reducer.js";
import { loadDeliveryQueueEntryInDatabase } from "./delivery-queue-sqlite-bound.js";
import {
  getDeliveryQueueEntryOwnersInDatabase,
  upsertDeliveryQueueEntryInDatabase,
} from "./delivery-queue-sqlite.kernel.js";
import { requestSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import { deferSqliteWorkerCommitReceipt } from "./sqlite-worker-operation-settlement.js";

export type LifecycleRecordInput = {
  event: AgentEventPayload;
  incomingState: ConversationLifecycleState;
  generation: string;
  sessionId: string;
  transportId: string;
  bindings: readonly ConversationProjectionBinding[];
  registeredAt?: number;
  executionOwner: boolean;
  signals: boolean;
  cards: boolean;
  cappedRooms: string[];
  interruptedSent: string[];
  late?: Pick<LifecycleObligation, "state" | "pendingApprovals" | "confirmations" | "cards">;
};
export type LifecycleRecordReceipt = {
  rows: { id: string; live: boolean; activeAt: number }[];
  adopted: boolean;
  overtaken: { id: string; roomId: string }[];
};

export function recordConversationLifecycleInWorker(
  input: LifecycleRecordInput,
  options: { database: OpenClawStateDatabase; env: NodeJS.ProcessEnv },
): LifecycleRecordReceipt {
  return runOpenClawStateWriteTransaction(
    (database) => {
      const { event, incomingState, generation, sessionId, bindings, late } = input;
      const fingerprint = lifecycleWriteFingerprint(input);
      const rows: LifecycleRecordReceipt["rows"] = [];
      const overtaken: LifecycleRecordReceipt["overtaken"] = [];
      let adopted = !late;
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      for (const binding of bindings) {
        const id = identity(binding.bindingId, event.runId, generation);
        if (
          getDeliveryQueueEntryOwnersInDatabase(database, [QUEUE], id).get(QUEUE)?.status ===
          "completed"
        )
          continue;
        const existing = loadDeliveryQueueEntryInDatabase(
          database,
          QUEUE,
          id,
          "pending",
        ) as LifecycleObligation | null;
        if (existing && existing.transportId !== input.transportId) {
          throw new Error("Conversation lifecycle transport owner disagrees");
        }
        if (event.seq > 0 && existing?.occurrence && event.seq <= existing.occurrence.seq) {
          if (
            event.seq === existing.occurrence.seq &&
            fingerprint !== existing.occurrence.fingerprint
          ) {
            throw new Error("Conversation lifecycle occurrence changed during replay");
          }
          continue;
        }
        if (existing && TERMINAL.has(existing.state)) {
          // A false sweep can close a run that then finishes. Its real outcome
          // replaces an interrupted that has not been sent; once the room may
          // have seen interrupted, the contract forbids changing it.
          if (existing.state !== "interrupted" || !SETTLED.has(incomingState)) continue;
          if (
            input.interruptedSent.includes(id) ||
            existing.pending.at(-1)?.state !== "interrupted"
          ) {
            overtaken.push({ id, roomId: binding.roomId });
            continue;
          }
          existing.pending = existing.pending.filter((event) => event.state !== "interrupted");
        }
        // Compaction moves a live run to a successor session. The same run id
        // in the same generation is the same run, so the row follows it.
        if (existing) existing.sessionId = sessionId;
        // Registry metadata can be enriched repeatedly after admission. It must
        // never rewind an already started run back into the queue.
        if (existing && incomingState === "queued") continue;
        const row: LifecycleObligation = existing ?? {
          id,
          enqueuedAt: event.ts,
          retryCount: 0,
          completionRetention: RETENTION,
          transportId: input.transportId,
          binding,
          runId: event.runId,
          generation,
          sessionId,
          revision: 0,
          state: incomingState,
          pending: [],
          pendingApprovals: late ? [...late.pendingApprovals] : [],
          ...(late?.cards && input.cards ? { cards: structuredClone(late.cards) } : {}),
          ...(late?.confirmations?.length && (input.signals || input.cards)
            ? { confirmations: [...late.confirmations] }
            : {}),
          acked: 0,
          // Taken from admission, never from the row's creation: a binding
          // that appears later must not move the run in the conversation's order.
          ...(input.signals && isLifecycleTime(input.registeredAt)
            ? { admittedAtMs: input.registeredAt }
            : {}),
        };
        let state = transition(row, event, incomingState, input.signals || input.cards);
        if (!state) continue;
        // A binding found by re-resolution announces where the run already
        // is; the re-resolving admission must not present it as queued.
        if (!existing && late && incomingState === "queued") state = late.state;
        // A run that stays `waiting` while it moves on to another approval names
        // the new one in a fact of its own; the flag is off, nothing changes.
        const waitMoved =
          existing !== null &&
          existing !== undefined &&
          state === "waiting" &&
          existing.state === "waiting" &&
          input.signals &&
          waitingOnOf(row.pendingApprovals, row.confirmations)?.ref !== row.waitingRef;
        if (!existing || existing.state !== state || waitMoved) {
          appendTransition(
            row,
            state,
            input.cappedRooms.includes(binding.roomId) ? 1 : RUN_PENDING_CAP,
            input.signals ? terminalSignalsOf(event, incomingState, binding) : undefined,
            input.signals,
            event.ts,
          );
        }
        if (input.cards) {
          noteDecisionCards(row, event, state);
        }
        row.live = input.executionOwner || row.pendingApprovals.length > 0;
        if (event.seq > 0) row.occurrence = { seq: event.seq, fingerprint };
        row.activeAt = event.ts;
        delete row.missingSince;
        upsertDeliveryQueueEntryInDatabase({ queueName: QUEUE, entry: row }, database);
        rows.push({ id: row.id, live: row.live, activeAt: row.activeAt });
        adopted = true;
      }
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      const result = { rows, adopted, overtaken };
      deferSqliteWorkerCommitReceipt(database.db, {
        kind: "deliveryQueue.lifecycleRecord",
        fingerprint,
        result,
      });
      return result;
    },
    options,
    { operationLabel: "record conversation lifecycle transition" },
  );
}

export type LifecycleResultInput = {
  transportId: string;
  runId: string;
  generation: string;
  bindingId: string;
  resultEventId: string;
  signals: boolean;
  now: number;
};

export type LifecycleResultReceipt = {
  roomId?: string;
  /** Old obligation was settled; this is deliberately not a physical send receipt. */
  legacySettled?: true;
};

export function recordConversationLifecycleResultInWorker(
  input: LifecycleResultInput,
  options: { database: OpenClawStateDatabase; env: NodeJS.ProcessEnv },
): LifecycleResultReceipt {
  return runOpenClawStateWriteTransaction(
    (database) => {
      const complete = (result: LifecycleResultReceipt) => {
        deferSqliteWorkerCommitReceipt(database.db, {
          kind: "deliveryQueue.lifecycleNoteResult",
          fingerprint: lifecycleWriteFingerprint(input),
          result,
        });
        return result;
      };
      const id = identity(input.bindingId, input.runId, input.generation);
      const status = getDeliveryQueueEntryOwnersInDatabase(database, [QUEUE], id).get(
        QUEUE,
      )?.status;
      const row = loadDeliveryQueueEntryInDatabase(
        database,
        QUEUE,
        id,
        "all",
      ) as LifecycleObligation | null;
      if (status === "completed") {
        if (row?.completionReceipt?.platformMessageId === input.resultEventId) return complete({});
        // The shipped writer discarded the provider ID after final facts and cards
        // were acknowledged. Never reopen that exact closed obligation or invent an ID.
        if (hasLegacySettledLifecycleObligationInDatabase(database, id))
          return complete({ legacySettled: true });
        throw new Error("Conversation final result receipt is missing or disagrees");
      }
      if (!row || row.transportId !== input.transportId) {
        throw new Error("Conversation final result has no durable lifecycle owner");
      }
      if (row.resultEventId === input.resultEventId)
        return complete({ roomId: row.binding.roomId });
      if (row.resultEventId) throw new Error("Conversation final result cannot change");
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      row.resultEventId = input.resultEventId;
      if (TERMINAL.has(row.state))
        appendTransition(row, row.state, undefined, undefined, input.signals, input.now);
      upsertDeliveryQueueEntryInDatabase({ queueName: QUEUE, entry: row }, database);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return complete({ roomId: row.binding.roomId });
    },
    options,
    { operationLabel: "record conversation lifecycle result" },
  );
}
