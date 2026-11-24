import { expect } from "vitest";
import { sessionTests } from "../../config/sessions/session-entry-fixture.test-support.js";
import { settlePendingFinalDelivery } from "./delivery-completion.js";
import type { DeliveryPublicationEvidence } from "./delivery-queue-publication.types.js";

const test = sessionTests({ prefix: "openclaw-final-physical-", layout: "state-only" });
function physical(): DeliveryPublicationEvidence {
  return {
    destination: { channel: "slack", to: "C1", accountId: "source", threadId: "root" },
    normalizedTarget: "C1",
    platformMessageId: "last",
    platformMessageIds: ["first", "last"],
    primaryPlatformMessageId: "first",
    resultCount: 2,
    placement: { channels: ["slack"], targets: ["C1"], threads: ["root"], invalid: false },
  };
}
function pending() {
  return {
    kind: "transport-only" as const,
    createdAt: 1,
    intentId: "intent",
    sourceRunId: "run",
    sourceGeneration: "generation",
    dispatchState: "open" as const,
    projectionConsumers: ["matrix"],
    context: { channel: "slack", to: "C1", accountId: "source", threadId: "root" },
    deliveries: [{ id: "member", state: "prepared" as const }],
  };
}
test("native settlement stores original canonical primary/count/final after observer corruption", async ({
  store,
}) => {
  store.replace({ pendingFinalDelivery: pending() });
  await settlePendingFinalDelivery(
    {
      kind: "pending-final",
      ...store.scope,
      sessionId: "original",
      intentId: "intent",
      deliveryId: "member",
    },
    "delivered",
    undefined,
    {
      identifiedResult: { channel: "slack", messageId: "observer-invented" },
      finalPhysicalReceipt: physical(),
    },
  );
  expect((await store.entry())?.pendingFinalDelivery?.deliveries?.[0]?.receipt).toEqual({
    platformMessageId: "first",
    finalPlatformMessageId: "last",
    resultCount: 2,
  });
});
test.for([
  "account",
  "thread",
  "channel",
  "target",
  "placement",
  "count",
  "primary",
  "final",
] as const)(
  "does not substitute mutable evidence for invalid canonical %s",
  async (fault, { store }) => {
    store.replace({ pendingFinalDelivery: pending() });
    const original = physical();
    const captured = {
      ...original,
      destination: { ...original.destination },
      placement: { ...original.placement },
    };
    if (fault === "account") captured.destination.accountId = "foreign";
    if (fault === "thread") captured.destination.threadId = "foreign";
    if (fault === "channel") captured.destination.channel = "telegram";
    if (fault === "target") captured.destination.to = "C2";
    if (fault === "placement") captured.placement.invalid = true;
    if (fault === "count") captured.resultCount = 0;
    if (fault === "primary") captured.primaryPlatformMessageId = "";
    if (fault === "final") captured.platformMessageId = "unobserved";
    await settlePendingFinalDelivery(
      {
        kind: "pending-final",
        ...store.scope,
        sessionId: "original",
        intentId: "intent",
        deliveryId: "member",
      },
      "delivered",
      undefined,
      {
        identifiedResult: { channel: "slack", messageId: "looks-valid-but-mutable" },
        finalPhysicalReceipt: captured,
      },
    );
    expect((await store.entry())?.pendingFinalDelivery?.deliveries?.[0]?.receipt).toBeUndefined();
  },
);
