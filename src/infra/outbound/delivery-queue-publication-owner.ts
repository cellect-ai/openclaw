import { createHash } from "node:crypto";
import type { QueuedDelivery } from "./delivery-queue-types.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

/** Admission-owned route fact. The digest detects inconsistent storage, not authority. */
export type DeliveryPublicationOwner = Readonly<{
  version: 1;
  normalizedTarget: string;
  routeDigest: string;
  /** Additive, so rollback versions can still reconcile their original route digest. */
  agentId?: string | null;
}>;

export function requiresDeliveryPublicationOwner(entry: QueuedDelivery): boolean {
  return acceptedPreparedOutboundEntries(entry.preparedBatch).some(
    (part) =>
      part.publication?.kind === "final" &&
      (part.publication.receiptRequired === true || part.publication.channel !== undefined),
  );
}

function routeDigest(entry: QueuedDelivery, normalizedTarget: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        1,
        entry.id,
        entry.channel,
        entry.to,
        entry.accountId ?? "default",
        String(entry.threadId ?? ""),
        entry.session?.key ?? null,
        entry.preparedBatch.runId ?? null,
        normalizedTarget,
      ]),
    )
    .digest("hex");
}

/** Called only by queue admission, never from ACK evidence or a recovered caller. */
export function captureDeliveryPublicationOwner(
  entry: QueuedDelivery,
  normalizedTarget: string,
): DeliveryPublicationOwner {
  if (!normalizedTarget.trim()) throw new Error("Delivery publication target is empty");
  return {
    version: 1,
    normalizedTarget,
    routeDigest: routeDigest(entry, normalizedTarget),
    agentId: entry.session?.agentId ?? null,
  };
}

/** Pure worker-safe validation: no channel registry or provider code lookup. */
export function assertDeliveryPublicationOwner(entry: QueuedDelivery): void {
  if (!requiresDeliveryPublicationOwner(entry)) return;
  const fact = entry.publicationOwner;
  if (
    !fact ||
    fact.version !== 1 ||
    typeof fact.normalizedTarget !== "string" ||
    !fact.normalizedTarget.trim() ||
    fact.routeDigest !== routeDigest(entry, fact.normalizedTarget) ||
    (fact.agentId !== undefined && fact.agentId !== (entry.session?.agentId ?? null))
  ) {
    throw new Error(
      "Delivery publication owner requires reconciliation: missing or inconsistent frozen route",
    );
  }
}
