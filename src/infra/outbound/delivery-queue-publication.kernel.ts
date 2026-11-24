import type { ReplyPublication } from "../../auto-reply/reply-publication.js";
// Projection custody is created only by the canonical delivery ACK transaction.
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { loadDeliveryQueueEntryInDatabase } from "../delivery-queue-sqlite-bound.js";
import {
  deleteDeliveryQueueEntryInDatabase,
  loadDeliveryQueueEntriesInDatabase,
  upsertDeliveryQueueEntryInDatabase,
} from "../delivery-queue-sqlite.kernel.js";
import { mergeDeliveryPublicationEvidence } from "./delivery-queue-publication-evidence.js";
import { assertDeliveryPublicationOwner } from "./delivery-queue-publication-owner.js";
import { OUTBOUND_PUBLICATION_QUEUE_NAME } from "./delivery-queue-publication.types.js";
import type {
  DeliveryPublicationEvidence,
  DeliveryPublicationProjection,
  PayloadPublicationEvidence,
  PayloadPublicationSuppression,
  QueuedDeliveryPublication,
} from "./delivery-queue-publication.types.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

export function stageDeliveryPublicationInDatabase(
  database: OpenClawStateDatabase,
  params: {
    queueName: string;
    entry: QueuedDelivery;
    evidence?: DeliveryPublicationEvidence;
    evidenceByPayload?: readonly PayloadPublicationEvidence[];
    suppressionsByPayload?: readonly PayloadPublicationSuppression[];
    suppressed?: boolean;
  },
): void {
  const accepted = acceptedPreparedOutboundEntries(params.entry.preparedBatch);
  const publications = accepted.filter(
    (part) =>
      part.publication?.kind === "final" &&
      (part.publication.receiptRequired === true || part.publication.channel !== undefined),
  );
  if (!publications.length || params.suppressed) return;
  assertDeliveryPublicationOwner(params.entry);
  const byPayload = new Map<number, DeliveryPublicationEvidence>();
  for (const part of params.evidenceByPayload ?? []) {
    if (
      !Number.isSafeInteger(part.sourceIndex) ||
      byPayload.has(part.sourceIndex) ||
      !accepted.some((entry) => entry.sourceIndex === part.sourceIndex)
    ) {
      throw new Error("Delivery publication has ambiguous payload evidence");
    }
    byPayload.set(part.sourceIndex, part.evidence);
  }
  const suppressed = new Set<number>();
  for (const part of params.suppressionsByPayload ?? []) {
    const source = params.entry.preparedBatch.entries.filter(
      (entry) => entry.sourceIndex === part.sourceIndex,
    );
    if (
      !Number.isSafeInteger(part.sourceIndex) ||
      suppressed.has(part.sourceIndex) ||
      byPayload.has(part.sourceIndex) ||
      source.length !== 1 ||
      (source[0]?.status === "suppressed" && source[0].reason !== part.reason) ||
      ![
        "cancelled_by_message_sending_hook",
        "cancelled_by_reply_payload_sending_hook",
        "empty_after_message_sending_hook",
        "empty_after_reply_payload_sending_hook",
        "no_visible_payload",
        "adapter_returned_no_send",
      ].includes(part.reason)
    )
      throw new Error("Delivery publication has ambiguous payload suppression");
    suppressed.add(part.sourceIndex);
  }
  const grouped = new Map<
    string,
    { publication: ReplyPublication; evidence: DeliveryPublicationEvidence; sourceIndex: number }
  >();
  for (const part of publications.toSorted((a, b) => a.sourceIndex - b.sourceIndex)) {
    const publication = part.publication!;
    assertPublicationOwner(params.entry, publication);
    if (suppressed.has(part.sourceIndex)) continue;
    // Aggregate reconciliation can identify a single accepted payload only.
    // Batch sends retain the native outcome's source index; never guess a split.
    const evidence =
      byPayload.get(part.sourceIndex) ??
      (accepted.length === 1 && params.evidenceByPayload === undefined
        ? params.evidence
        : undefined);
    if (!evidence) throw new Error("Delivery publication lacks exact final provider evidence");
    assertPublicationEvidence(params.entry, publication, evidence);
    const previous = grouped.get(publication.publicationId);
    if (previous) {
      if (JSON.stringify(previous.publication) !== JSON.stringify(publication)) {
        throw new Error("Delivery publication identity changed within its prepared batch");
      }
      const combined = mergeDeliveryPublicationEvidence([previous.evidence, evidence]);
      if (!combined) throw new Error("Delivery publication lost its grouped provider evidence");
      previous.evidence = combined;
    } else
      grouped.set(publication.publicationId, {
        publication,
        evidence,
        sourceIndex: part.sourceIndex,
      });
  }
  for (const { publication, evidence, sourceIndex } of grouped.values()) {
    stagePublication(database, params, publication, evidence, sourceIndex);
  }
}

function assertPublicationOwner(entry: QueuedDelivery, publication: ReplyPublication): void {
  if (
    publication.version !== 2 ||
    !/^[a-f0-9-]{36}$/i.test(publication.publicationId) ||
    !Number.isSafeInteger(publication.publishedAtMs) ||
    (publication.receiptRequired &&
      (!publication.runId?.trim() || !publication.sessionKey?.trim())) ||
    (publication.runId !== undefined && publication.runId !== entry.preparedBatch.runId) ||
    (publication.sessionKey !== undefined && publication.sessionKey !== entry.session?.key) ||
    publication.channel !== entry.channel ||
    (publication.accountId !== undefined &&
      publication.accountId !== (entry.accountId ?? "default")) ||
    !entry.to.replace(/^(?:channel|user|room):/, "").trim()
  )
    throw new Error("Delivery publication evidence does not match its durable owner");
}

function assertPublicationEvidence(
  entry: QueuedDelivery,
  publication: ReplyPublication,
  evidence: DeliveryPublicationEvidence,
): void {
  assertPublicationOwner(entry, publication);
  if (
    !evidence.platformMessageId.trim() ||
    evidence.platformMessageIds.at(-1) !== evidence.platformMessageId ||
    evidence.destination.channel !== entry.channel ||
    evidence.normalizedTarget !== entry.publicationOwner?.normalizedTarget ||
    evidence.destination.to !== entry.to ||
    (evidence.destination.accountId ?? "default") !== (entry.accountId ?? "default") ||
    String(evidence.destination.threadId ?? "") !== String(entry.threadId ?? "") ||
    evidence.placement.invalid ||
    !evidence.placement.channels.every((channel) => channel === entry.channel) ||
    !evidence.placement.targets.every((target) => target === evidence.normalizedTarget) ||
    !evidence.placement.threads.every((thread) => thread === String(entry.threadId ?? "").trim())
  ) {
    throw new Error("Delivery publication evidence does not match its durable owner");
  }
}

function stagePublication(
  database: OpenClawStateDatabase,
  params: { queueName: string; entry: QueuedDelivery },
  publication: ReplyPublication,
  evidence: DeliveryPublicationEvidence,
  sourceIndex: number,
): void {
  const entry = params.entry;
  const projection: DeliveryPublicationProjection = {
    version: 1,
    queueName: params.queueName,
    deliveryId: entry.id,
    sourceIndex,
    platformSendAttemptId: entry.platformSendAttemptId,
    publication,
    receipt: {
      channel: entry.channel,
      accountId: entry.accountId ?? "default",
      conversationId: entry.to.replace(/^(?:channel|user|room):/, ""),
      messageId: evidence.platformMessageId,
    },
    evidence,
  };
  const id = JSON.stringify([params.queueName, entry.id, publication.publicationId]);
  const projectionJson = JSON.stringify(projection);
  const existing = loadDeliveryQueueEntryInDatabase(
    database,
    OUTBOUND_PUBLICATION_QUEUE_NAME,
    id,
  ) as QueuedDeliveryPublication | null;
  if (existing) {
    if (existing.projectionJson !== projectionJson)
      throw new Error("Delivery publication custody conflicts with an existing receipt");
    return;
  }
  if (
    !upsertDeliveryQueueEntryInDatabase(
      {
        queueName: OUTBOUND_PUBLICATION_QUEUE_NAME,
        entry: {
          id,
          deliveryId: entry.id,
          sourceIndex,
          projectionJson,
          enqueuedAt: Date.now(),
          retryCount: 0,
        } as QueuedDeliveryPublication,
        insertOnly: true,
      },
      database,
    )
  )
    throw new Error("Delivery publication custody could not be committed");
}

export function loadDeliveryPublicationsInDatabase(
  database: OpenClawStateDatabase,
  input: { deliveryId?: string },
): QueuedDeliveryPublication[] {
  const entries = (
    loadDeliveryQueueEntriesInDatabase(
      database,
      OUTBOUND_PUBLICATION_QUEUE_NAME,
    ) as QueuedDeliveryPublication[]
  ).filter((entry) => input.deliveryId === undefined || entry.deliveryId === input.deliveryId);
  // Native queue ordering uses timestamp/ID. UUID order cannot represent the
  // source order of publications acknowledged in one delivery transaction.
  const deliveries = new Map<string, QueuedDeliveryPublication[]>();
  for (const entry of entries) {
    const group = deliveries.get(entry.deliveryId) ?? [];
    group.push(entry);
    deliveries.set(entry.deliveryId, group);
  }
  return [...deliveries.values()].flatMap((group) =>
    group.toSorted((a, b) => a.sourceIndex - b.sourceIndex),
  );
}

/** Caller must run within the native worker write transaction. */
export function finishDeliveryPublicationInDatabase(
  database: OpenClawStateDatabase,
  input: { id: string; projectionJson: string },
): boolean {
  const current = loadDeliveryQueueEntryInDatabase(
    database,
    OUTBOUND_PUBLICATION_QUEUE_NAME,
    input.id,
  ) as QueuedDeliveryPublication | null;
  if (!current) return true;
  if (current.projectionJson !== input.projectionJson) return false;
  deleteDeliveryQueueEntryInDatabase(database, OUTBOUND_PUBLICATION_QUEUE_NAME, input.id);
  return true;
}
