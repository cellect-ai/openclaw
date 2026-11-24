import { expect } from "vitest";
import { applySessionEntryOperation } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { sessionTests } from "../../config/sessions/session-entry-fixture.test-support.js";
import type { NativeFinalMemberEvidence } from "./delivery-completion-members.js";
import { settleDurableDelivery } from "./delivery-completion.js";
import type { DeliveryPublicationEvidence } from "./delivery-queue-publication.types.js";
const test = sessionTests({ prefix: "native-final-members-", layout: "state-only" });
const source = { sourceRunId: "run", sourceGeneration: "generation" };
function physical(id: string): DeliveryPublicationEvidence {
  return {
    destination: { channel: "slack", to: "C1", accountId: "source" },
    normalizedTarget: "C1",
    primaryPlatformMessageId: id,
    platformMessageId: id,
    platformMessageIds: [id],
    resultCount: 1,
    placement: { channels: ["slack"], targets: ["C1"], threads: [], invalid: false },
  };
}
function pending() {
  return {
    kind: "transport-only" as const,
    createdAt: 1,
    intentId: "intent",
    ...source,
    dispatchState: "closed" as const,
    dispatchClosure: "completed" as const,
    projectionConsumers: ["matrix"],
    context: { channel: "slack", to: "C1", accountId: "source" },
    deliveries: ["first", "second", "last"].map((id) => ({ id, state: "queued" as const })),
  };
}
test("settles exact ordered members, retaining missing custody until complete and preserving a suppressed suffix", async ({
  store,
}) => {
  store.replace({ pendingFinalDelivery: pending() });
  const completion = {
    kind: "pending-final" as const,
    ...store.scope,
    sessionId: "original",
    intentId: "intent",
    deliveryId: "first",
    memberDeliveryIds: ["first", "second", "last"],
    ...source,
  };
  const settle = (memberEvidence: NativeFinalMemberEvidence[]) =>
    settleDurableDelivery(completion, {
      result: { channel: "slack", messageId: "mutable-aggregate" },
      memberEvidence,
    });
  await settle([
    { sourceIndex: 0, state: "delivered", receipt: physical("1") },
    { sourceIndex: 2, state: "suppressed" },
  ]);
  expect((await store.entry())?.pendingFinalDelivery?.deliveries).toMatchObject([
    { id: "first", state: "delivered", receipt: { finalPlatformMessageId: "1" } },
    { id: "second", state: "unknown" },
    { id: "last", state: "suppressed" },
  ]);
  await settle([{ sourceIndex: 1, state: "delivered", receipt: physical("2") }]);
  const entry = await store.entry();
  expect(entry?.pendingFinalDelivery).toBeUndefined();
  expect(entry?.completedFinalDeliveries?.[0]).toMatchObject({
    projectionConsumers: ["matrix"],
    deliveries: [
      { id: "first", state: "delivered", receipt: { finalPlatformMessageId: "1" } },
      { id: "second", state: "delivered", receipt: { finalPlatformMessageId: "2" } },
      { id: "last", state: "suppressed" },
    ],
  });
  await applySessionEntryOperation(store.scope, {
    kind: "pending-final-projection",
    sessionId: "original",
    intentId: "intent",
    ...source,
    consumerId: "matrix",
    release: true,
  });
  expect((await store.entry())?.completedFinalDeliveries).toEqual([]);
});
test.for([
  "aggregate-only",
  "duplicate-index",
  "foreign-index",
  "wrong-route",
  "missing-receipt",
] as const)("does not borrow batch success for %s", async (mode, { store }) => {
  store.replace({ pendingFinalDelivery: pending() });
  const receipt = { ...physical("1") };
  if (mode === "wrong-route")
    receipt.destination = { ...receipt.destination, accountId: "foreign" };
  if (mode === "missing-receipt") receipt.primaryPlatformMessageId = "";
  const memberEvidence: NativeFinalMemberEvidence[] =
    mode === "aggregate-only"
      ? []
      : [{ sourceIndex: mode === "foreign-index" ? 9 : 0, state: "delivered", receipt }];
  if (mode === "duplicate-index") memberEvidence.push(memberEvidence[0]!);
  await settleDurableDelivery(
    {
      kind: "pending-final",
      ...store.scope,
      sessionId: "original",
      intentId: "intent",
      deliveryId: "first",
      memberDeliveryIds: ["first", "second", "last"],
      ...source,
    },
    { result: { channel: "slack", messageId: "aggregate" }, memberEvidence },
  );
  expect((await store.entry())?.pendingFinalDelivery?.deliveries).toEqual(
    ["first", "second", "last"].map((id) => ({ id, state: "unknown" })),
  );
  expect((await store.entry())?.completedFinalDeliveries).toBeUndefined();
});
