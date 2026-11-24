import { expect, it } from "vitest";
import type { OutboundPayloadDeliveryOutcome } from "./deliver-types.js";
import { createDeliveryPublicationCapture } from "./delivery-publication-capture.js";

const capture = () =>
  createDeliveryPublicationCapture({
    destination: { channel: "matrix", to: "!room:example", accountId: "default" },
    payloadCount: 2,
    enabled: () => true,
  });

it("freezes the native source suppression before an observer mutates its outcome", () => {
  const custody = capture();
  const outcome: OutboundPayloadDeliveryOutcome = {
    index: 1,
    status: "suppressed",
    reason: "adapter_returned_no_send",
  };
  custody.captureOutcome(outcome);
  outcome.index = 0;
  outcome.reason = "adapter_returned_no_identity";
  expect(custody.publicationSuppressionsByPayload).toEqual([
    { sourceIndex: 1, reason: "adapter_returned_no_send" },
  ]);
  expect(custody.publicationEvidenceByPayload).toEqual([]);
  expect(custody.completeFinalPhysicalReceipt()).toBeUndefined();
});

it("never converts absent identity, partial physical output, or failure into suppression custody", () => {
  const custody = capture();
  custody.captureOutcome({
    index: 0,
    status: "suppressed",
    reason: "adapter_returned_no_identity",
  });
  custody.captureOutcome({
    index: 1,
    status: "sent",
    results: [],
    incompleteReason: "adapter_returned_no_send",
  });
  custody.captureOutcome({
    index: 1,
    status: "failed",
    error: new Error("transport failed"),
    sentBeforeError: false,
    stage: "platform_send",
  });
  expect(custody.publicationSuppressionsByPayload).toEqual([]);
  expect(custody.incompletePayloadSend).toBe(true);
  expect(custody.completeFinalPhysicalReceipt()).toBeUndefined();
});
