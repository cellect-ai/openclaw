import type {
  DeliveryPublicationEvidence,
  PayloadPublicationEvidence,
  PayloadPublicationSuppression,
} from "./delivery-queue-publication.types.js";
export type AckDeliveryOptions = {
  /** Caller holds a GC-visible recovery lease until its active adapter settles. */
  retainSpoolArtifacts?: boolean;
  /** An intentionally suppressed pre-send batch must not become a success receipt. */
  suppressCompletionReceipt?: boolean;
  /**
   * Skip publication staging for a batch whose every payload was natively suppressed.
   * Defaults to suppressCompletionReceipt; receipt retention stays a separate policy.
   */
  suppressPublication?: boolean;
  publicationEvidence?: DeliveryPublicationEvidence;
  publicationEvidenceByPayload?: readonly PayloadPublicationEvidence[];
  publicationSuppressionsByPayload?: readonly PayloadPublicationSuppression[];
  completionReceipt?: Readonly<{ platformMessageId: string }>;
  /** Prevent an older provider attempt from settling a replacement owner. */
  expectedPlatformSendAttemptId?: string | null;
};

export type FailPendingDeliveryResult = { status: "failed" } | { status: "not_pending" };
