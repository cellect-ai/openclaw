import { emitStoredReplyPublicationAccepted } from "../../auto-reply/reply-publication.js";
import {
  captureDeliveryQueueStateContext,
  type DeliveryQueueStateContext,
} from "../delivery-queue-sqlite.js";
import { executeDeliveryQueueOperation } from "../delivery-queue-worker-store.js";
import { OUTBOUND_EXECUTABLE_QUEUE_NAMES } from "./delivery-queue-namespaces.js";
import type { DeliveryPublicationProjection } from "./delivery-queue-publication.types.js";

/** The send is canonically acknowledged; only durable projection work remains. */
export class DeliveryPublicationPendingError extends Error {
  constructor(
    readonly deliveryId: string,
    options?: ErrorOptions,
  ) {
    super(
      `Delivery ${deliveryId} was acknowledged but its required publication remains owed`,
      options,
    );
    this.name = "DeliveryPublicationPendingError";
  }
}

/** Preserve projection custody through the native delivery error wrapper. */
export function findDeliveryPublicationPendingError(
  error: unknown,
): DeliveryPublicationPendingError | undefined {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof DeliveryPublicationPendingError) return error;
    seen.add(error);
    error = error.cause;
  }
  return undefined;
}

/** Replays only immutable acknowledgement facts. This owner never invokes a provider send. */
export async function flushDeliveryPublications(
  params: { deliveryId?: string; stateDir?: string; onPending?: () => void },
  context?: DeliveryQueueStateContext,
): Promise<void> {
  const captured = context ?? captureDeliveryQueueStateContext(params.stateDir);
  const entries = await executeDeliveryQueueOperation(captured, captured.stateDir, {
    type: "deliveryQueue.loadPublications",
    input: { deliveryId: params.deliveryId },
  });
  if (entries.length) params.onPending?.();
  const failures: unknown[] = [];
  const blockedDeliveries = new Set<string>();
  const sourceIndexes = new Map<string, Set<number>>();
  // Check the complete delivery's ordering metadata before any publication. A
  // corrupt prefix must not sort behind and release an otherwise valid suffix.
  for (const entry of entries) {
    if (blockedDeliveries.has(entry.deliveryId)) continue;
    try {
      const projection = JSON.parse(entry.projectionJson) as DeliveryPublicationProjection;
      const seen = sourceIndexes.get(entry.deliveryId) ?? new Set<number>();
      if (
        !Number.isSafeInteger(entry.sourceIndex) ||
        entry.sourceIndex < 0 ||
        projection.sourceIndex !== entry.sourceIndex ||
        seen.has(entry.sourceIndex)
      )
        throw new Error("Stored publication source ordering changed");
      seen.add(entry.sourceIndex);
      sourceIndexes.set(entry.deliveryId, seen);
    } catch (cause) {
      blockedDeliveries.add(entry.deliveryId);
      failures.push(new DeliveryPublicationPendingError(entry.deliveryId, { cause }));
    }
  }
  for (const entry of entries) {
    if (blockedDeliveries.has(entry.deliveryId)) continue;
    try {
      captured.workerContext.admission.assertCurrent();
      const projection = JSON.parse(entry.projectionJson) as DeliveryPublicationProjection;
      if (
        projection.version !== 1 ||
        projection.deliveryId !== entry.deliveryId ||
        !Number.isSafeInteger(projection.sourceIndex) ||
        projection.sourceIndex < 0 ||
        projection.sourceIndex !== entry.sourceIndex ||
        !OUTBOUND_EXECUTABLE_QUEUE_NAMES.some((name) => name === projection.queueName) ||
        projection.publication.version !== 2 ||
        projection.publication.kind !== "final" ||
        !/^[a-f0-9-]{36}$/i.test(projection.publication.publicationId) ||
        !Number.isSafeInteger(projection.publication.publishedAtMs) ||
        (projection.publication.receiptRequired &&
          (!projection.publication.sessionKey?.trim() || !projection.publication.runId?.trim())) ||
        projection.publication.channel !== projection.receipt.channel ||
        (projection.publication.accountId !== undefined &&
          projection.publication.accountId !== projection.receipt.accountId) ||
        !projection.receipt.messageId?.trim() ||
        !projection.receipt.conversationId?.trim() ||
        projection.evidence.platformMessageIds.at(-1) !== projection.receipt.messageId ||
        projection.evidence.placement.invalid ||
        !projection.evidence.placement.channels.every(
          (channel) => channel === projection.receipt.channel,
        ) ||
        !projection.evidence.placement.targets.every(
          (target) => target === projection.evidence.normalizedTarget,
        ) ||
        !projection.evidence.placement.threads.every(
          (thread) => thread === String(projection.evidence.destination.threadId ?? "").trim(),
        ) ||
        entry.id !==
          JSON.stringify([
            projection.queueName,
            projection.deliveryId,
            projection.publication.publicationId,
          ]) ||
        projection.receipt.messageId !== projection.evidence.platformMessageId ||
        projection.receipt.channel !== projection.evidence.destination.channel ||
        projection.receipt.accountId !== (projection.evidence.destination.accountId ?? "default") ||
        projection.receipt.conversationId !==
          projection.evidence.destination.to.replace(/^(?:channel|user|room):/, "")
      ) {
        throw new Error("Stored publication projection identity changed");
      }
      await emitStoredReplyPublicationAccepted(
        Object.freeze({ ...projection.publication }),
        projection.receipt,
      );
      captured.workerContext.admission.assertCurrent();
      const finished = await executeDeliveryQueueOperation(captured, captured.stateDir, {
        type: "deliveryQueue.finishPublication",
        input: { id: entry.id, projectionJson: entry.projectionJson },
      });
      if (!finished) throw new Error("Publication projection custody changed before completion");
    } catch (cause) {
      blockedDeliveries.add(entry.deliveryId);
      failures.push(new DeliveryPublicationPendingError(entry.deliveryId, { cause }));
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, "Delivery publication projections remain owed");
}
