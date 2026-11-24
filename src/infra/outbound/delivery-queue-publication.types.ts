import type {
  ReplyPublication,
  ReplyPublicationReceipt,
} from "../../auto-reply/reply-publication.js";
import type { DeliveryQueueEntryState } from "../delivery-queue-sqlite.types.js";
import type { OutboundPayloadDeliverySuppressionReason } from "./deliver-types.js";
import type { DeliveryPlacementEvidence } from "./delivery-placement-evidence.types.js";

export const OUTBOUND_PUBLICATION_QUEUE_NAME = "outbound-publication-v1";

/** Provider evidence captured before mutable hooks; never new send authority. */
export type DeliveryPublicationEvidence = Readonly<{
  destination: Readonly<{
    channel: string;
    to: string;
    accountId?: string;
    threadId?: string | number | null;
  }>;
  normalizedTarget: string;
  platformMessageId: string;
  /** Original native primary, distinct from the last physical publication event. */
  primaryPlatformMessageId?: string;
  /** Original native send count, after progress reconciliation. */
  resultCount?: number;
  platformMessageIds: readonly string[];
  placement: DeliveryPlacementEvidence;
}>;

/** Native prepared-batch source index, not the position in an accepted-only array. */
export type PayloadPublicationEvidence = Readonly<{
  sourceIndex: number;
  evidence: DeliveryPublicationEvidence;
}>;

/** An explicit native no-send disposition, never inferred from a missing physical receipt. */
export type PayloadPublicationSuppression = Readonly<{
  sourceIndex: number;
  reason: Exclude<OutboundPayloadDeliverySuppressionReason, "adapter_returned_no_identity">;
}>;

export type DeliveryPublicationProjection = Readonly<{
  version: 1;
  queueName: string;
  deliveryId: string;
  sourceIndex: number;
  platformSendAttemptId?: string;
  publication: ReplyPublication;
  receipt: ReplyPublicationReceipt;
  evidence: DeliveryPublicationEvidence;
}>;

export type QueuedDeliveryPublication = DeliveryQueueEntryState & {
  deliveryId: string;
  sourceIndex: number;
  /** Frozen byte identity used by the projection acknowledgement CAS. */
  projectionJson: string;
};
