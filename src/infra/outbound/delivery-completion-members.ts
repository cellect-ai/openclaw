import {
  areOutboundPayloadsIntentionallySuppressed,
  type OutboundPayloadDeliveryOutcome,
} from "./deliver-types.js";
import type {
  DeliveryPublicationEvidence,
  PayloadPublicationEvidence,
} from "./delivery-queue-publication.types.js";
import type { DurableDeliveryCompletion } from "./delivery-queue-types.js";

/** Private capture from the canonical source-index outcome, before observer callbacks. */
export type NativeFinalMemberEvidence = Readonly<
  | { sourceIndex: number; state: "delivered"; receipt: DeliveryPublicationEvidence }
  | { sourceIndex: number; state: "suppressed" | "unknown" }
>;

export function captureNativeFinalMemberEvidence(
  outcome: OutboundPayloadDeliveryOutcome,
  publication: PayloadPublicationEvidence | undefined,
): NativeFinalMemberEvidence {
  if (
    publication &&
    publication.sourceIndex === outcome.index &&
    outcome.status === "sent" &&
    !outcome.incompleteReason
  ) {
    return Object.freeze({
      sourceIndex: outcome.index,
      state: "delivered",
      receipt: structuredClone(publication.evidence),
    });
  }
  return Object.freeze({
    sourceIndex: outcome.index,
    state: areOutboundPayloadsIntentionallySuppressed([outcome]) ? "suppressed" : "unknown",
  });
}

export function nativeFinalBatchMemberIds(
  completion: Extract<DurableDeliveryCompletion, { kind: "pending-final" }>,
): readonly string[] | undefined {
  const ids = completion.memberDeliveryIds;
  if (ids === undefined) return undefined;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 1024 ||
    !completion.sourceRunId ||
    !completion.sourceGeneration ||
    ids.some((id) => typeof id !== "string" || !id.trim()) ||
    new Set(ids).size !== ids.length ||
    ids[0] !== completion.deliveryId
  )
    throw new Error("Invalid native final batch membership");
  return ids;
}

/** Missing, duplicate, or out-of-range source custody never inherits aggregate success. */
export function selectNativeFinalMemberEvidence(
  evidence: readonly NativeFinalMemberEvidence[] | undefined,
  memberCount: number,
  index: number,
): NativeFinalMemberEvidence | undefined {
  if (
    !evidence ||
    evidence.some(
      (part) =>
        !Number.isSafeInteger(part.sourceIndex) ||
        part.sourceIndex < 0 ||
        part.sourceIndex >= memberCount,
    )
  )
    return undefined;
  const matches = evidence.filter((part) => part.sourceIndex === index);
  return matches.length === 1 ? matches[0] : undefined;
}
