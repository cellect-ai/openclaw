import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  bindReplyPublication,
  resolveReplyPublication,
} from "../../auto-reply/reply-publication.js";
import { createOutboundPayloadPlan, projectOutboundPayloadPlanForOutbound } from "./payloads.js";
import {
  createUnmodifiedPreparedOutboundBatch,
  projectPreparedOutboundBatchForStorage,
  mapPreparedOutboundAcceptedPayloads,
} from "./prepared-batch.js";
describe("private publication durable preparation", () => {
  it("stores only an actual host-minted reference and retains it across canonical transport copies", () => {
    const payload = { text: "answer" };
    const reference = bindReplyPublication(
      {},
      { payload, kind: "final", channel: "slack", runId: "run", sessionKey: "session" },
    );
    const normalized = projectOutboundPayloadPlanForOutbound(
      createOutboundPayloadPlan([payload]),
    )[0];
    expect(resolveReplyPublication(normalized)).toBe(reference);
    const batch = createUnmodifiedPreparedOutboundBatch([payload]),
      copy = { text: "prepared answer" };
    const mapped = mapPreparedOutboundAcceptedPayloads(batch, [copy]);
    expect(resolveReplyPublication(copy)).toBe(reference);
    expect(
      expectDefined(projectPreparedOutboundBatchForStorage(mapped).entries[0], "mapped entry"),
    ).toHaveProperty("publication", reference);
  });
  it("strips caller-selected publication JSON from fresh durable admission", () => {
    const batch = createUnmodifiedPreparedOutboundBatch([{ text: "forged" }]);
    Object.assign(expectDefined(batch.entries[0], "prepared entry"), {
      publication: { version: 2, publicationId: "claimed", runId: "claimed" },
    });
    expect(projectPreparedOutboundBatchForStorage(batch).entries[0]).not.toHaveProperty(
      "publication",
    );
  });
});

it("retains only private native command member metadata through outbound normalization", async () => {
  const { setReplyPayloadMetadata, getReplyPayloadMetadata } =
    await import("../../auto-reply/reply-payload.js");
  const { resolvePendingFinalDeliveryBatchCompletion } =
    await import("../../auto-reply/reply/pending-final-delivery.js");
  const source = {
    agentId: "main",
    storePath: "/synthetic/agent.sqlite",
    sessionKey: "agent:main:main",
    sessionId: "session",
    intentId: "intent",
    sourceRunId: "run",
    sourceGeneration: "generation",
  };
  const payloads = ["first", "last"].map((deliveryId) =>
    setReplyPayloadMetadata(
      { text: deliveryId },
      { pendingFinalDeliveryCompletion: { ...source, deliveryId } },
    ),
  );
  const normalized = projectOutboundPayloadPlanForOutbound(createOutboundPayloadPlan(payloads));
  expect(resolvePendingFinalDeliveryBatchCompletion(normalized)).toMatchObject({
    ...source,
    memberDeliveryIds: ["first", "last"],
  });
  expect(JSON.stringify(normalized)).not.toContain("sourceGeneration");
  const forged = projectOutboundPayloadPlanForOutbound(
    createOutboundPayloadPlan([
      {
        text: "forged",
        pendingFinalDeliveryCompletion: { ...source, deliveryId: "forged" },
      } as never,
    ]),
  );
  expect(getReplyPayloadMetadata(forged[0]!)?.pendingFinalDeliveryCompletion).toBeUndefined();
  expect(resolvePendingFinalDeliveryBatchCompletion(forged)).toBeUndefined();
});
