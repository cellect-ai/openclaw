import type { OutboundDeliveryResult, OutboundPayloadDeliveryOutcome } from "./deliver-types.js";
import {
  captureNativeFinalMemberEvidence,
  type NativeFinalMemberEvidence,
} from "./delivery-completion-members.js";
import {
  captureDeliveryPublicationEvidence,
  capturePayloadPublicationEvidence,
  capturePayloadPublicationSuppression,
  mergeDeliveryPublicationEvidence,
} from "./delivery-queue-publication-evidence.js";
import type {
  DeliveryPublicationEvidence,
  PayloadPublicationEvidence,
  PayloadPublicationSuppression,
} from "./delivery-queue-publication.types.js";

/** Immutable physical evidence captured before external observer callbacks. */
export function createDeliveryPublicationCapture(params: {
  destination: DeliveryPublicationEvidence["destination"];
  payloadCount: number;
  enabled: () => boolean;
}) {
  let incompletePayloadSend = false;
  const publicationEvidenceByPayload: PayloadPublicationEvidence[] = [];
  const publicationSuppressionsByPayload: PayloadPublicationSuppression[] = [];
  const nativeMemberEvidence: NativeFinalMemberEvidence[] = [];
  const capturedPublicationResults = new WeakMap<
    OutboundDeliveryResult,
    DeliveryPublicationEvidence
  >();
  const capturedPublicationParts: DeliveryPublicationEvidence[] = [];
  const captureCanonicalResult = (result: OutboundDeliveryResult) => {
    if (capturedPublicationResults.has(result)) return;
    const evidence = params.enabled()
      ? captureDeliveryPublicationEvidence([result], params.destination)
      : undefined;
    if (evidence) {
      capturedPublicationResults.set(result, evidence);
      capturedPublicationParts.push(evidence);
    }
  };
  const captureOutcome = (outcome: OutboundPayloadDeliveryOutcome) => {
    incompletePayloadSend ||= outcome.status === "sent" && outcome.incompleteReason !== undefined;
    const evidence = capturePayloadPublicationEvidence(
      outcome,
      params.destination,
      capturedPublicationResults,
    );
    if (evidence) publicationEvidenceByPayload.push(evidence);
    const suppressed = capturePayloadPublicationSuppression(outcome);
    if (suppressed) publicationSuppressionsByPayload.push(suppressed);
    nativeMemberEvidence.push(captureNativeFinalMemberEvidence(outcome, evidence));
  };
  const completeFinalPhysicalReceipt = () => {
    const ordered = publicationEvidenceByPayload.toSorted((a, b) => a.sourceIndex - b.sourceIndex);
    return !incompletePayloadSend &&
      ordered.length === params.payloadCount &&
      ordered.every((part, index) => part.sourceIndex === index)
      ? mergeDeliveryPublicationEvidence(ordered.map((part) => part.evidence))
      : undefined;
  };
  return {
    publicationEvidenceByPayload,
    publicationSuppressionsByPayload,
    nativeMemberEvidence,
    capturedPublicationParts,
    captureCanonicalResult,
    captureOutcome,
    completeFinalPhysicalReceipt,
    get incompletePayloadSend() {
      return incompletePayloadSend;
    },
  };
}
