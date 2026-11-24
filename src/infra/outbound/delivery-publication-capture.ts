import type { OutboundDeliveryResult, OutboundPayloadDeliveryOutcome } from "./deliver-types.js";
import {
  captureNativeFinalMemberEvidence,
  type NativeFinalMemberEvidence,
} from "./delivery-completion-members.js";
import { deliveryPlacementMatchesContext } from "./delivery-placement-evidence.js";
import {
  captureDeliveryPublicationEvidence,
  capturePayloadPublicationEvidence,
  ContradictoryDeliveryPublicationEvidenceError,
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
  // A physical send placed elsewhere already happened: it withholds publication and
  // final-receipt evidence, never the delivery itself. Its result is never recaptured,
  // so a later observer mutation cannot launder it into matching evidence.
  const contradictedResults = new WeakSet<OutboundDeliveryResult>();
  let contradicted = false;
  const captureCanonicalResult = (result: OutboundDeliveryResult) => {
    if (capturedPublicationResults.has(result) || contradictedResults.has(result)) return;
    let evidence: DeliveryPublicationEvidence | undefined;
    try {
      evidence = params.enabled()
        ? captureDeliveryPublicationEvidence([result], params.destination)
        : undefined;
    } catch (error) {
      if (!(error instanceof ContradictoryDeliveryPublicationEvidenceError)) throw error;
      contradictedResults.add(result);
      contradicted = true;
      return;
    }
    if (evidence) {
      capturedPublicationResults.set(result, evidence);
      capturedPublicationParts.push(evidence);
    }
  };
  const captureOutcome = (outcome: OutboundPayloadDeliveryOutcome) => {
    incompletePayloadSend ||= outcome.status === "sent" && outcome.incompleteReason !== undefined;
    contradicted ||=
      outcome.status === "sent" &&
      !deliveryPlacementMatchesContext(outcome.reportedPlacement, params.destination);
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
    /** Some physical send reported a placement other than the owned destination. */
    get contradicted() {
      return contradicted;
    },
  };
}
