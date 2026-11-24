import { expect } from "vitest";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import {
  appendProjectionMember,
  closeProjectionPlan,
  pendingProjectionFixture,
  releaseProjectionConsumer,
} from "./pending-final-delivery-preservation.test-support.js";
import {
  replaceSessionEntry,
  applySessionEntryOperation,
} from "./session-accessor.sqlite-entry.js";
import { sessionTests } from "./session-entry-fixture.test-support.js";
import { readSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";

const test = sessionTests({ prefix: "openclaw-final-preservation-", layout: "state-only" });
test("canonical worker refuses stale pending membership while native append, settlement, close and release retry preserve exact debt", async ({
  store,
}) => {
  const stale = pendingProjectionFixture();
  await replaceSessionEntry(store.scope, stale);
  await applySessionEntryOperation(store.scope, appendProjectionMember);
  const appended = await readSessionEntryReadOnlyInWorker(store.scope);
  expect(appended?.pendingFinalDelivery?.deliveries?.map(({ id }) => id)).toEqual([
    "first",
    "late-tts",
  ]);
  await expect(replaceSessionEntry(store.scope, stale)).rejects.toThrow(/projection custody/);
  expect(await readSessionEntryReadOnlyInWorker(store.scope)).toEqual(appended);
  // A generic compound cannot borrow a genuine close operation to suppress a member.
  await expect(
    applySessionEntryOperation(store.scope, {
      kind: "compound",
      operations: [
        {
          kind: "fields",
          patch: {
            pendingFinalDelivery: {
              ...appended!.pendingFinalDelivery!,
              deliveries: [{ id: "first", state: "suppressed" }],
            },
          },
        },
        closeProjectionPlan,
      ],
    }),
  ).rejects.toThrow(/projection custody/);
  expect(await readSessionEntryReadOnlyInWorker(store.scope)).toEqual(appended);
  for (const deliveryId of ["first", "late-tts"]) {
    const result = await settlePendingFinalDelivery(
      {
        ...store.scope,
        kind: "pending-final",
        sessionId: "original",
        intentId: "intent",
        deliveryId,
      },
      "suppressed",
      ["prepared"],
      { clearAfterSettled: true },
    );
    expect(result.state).toBe("suppressed");
  }
  const settled = await readSessionEntryReadOnlyInWorker(store.scope);
  expect(settled?.pendingFinalDelivery?.dispatchState).toBe("open");
  await expect(replaceSessionEntry(store.scope, appended!)).rejects.toThrow(/projection custody/);
  await applySessionEntryOperation(store.scope, closeProjectionPlan);
  const completed = await readSessionEntryReadOnlyInWorker(store.scope);
  expect(completed?.pendingFinalDelivery).toBeUndefined();
  expect(completed?.completedFinalDeliveries?.[0]?.deliveries).toEqual([
    { id: "first", state: "suppressed" },
    { id: "late-tts", state: "suppressed" },
  ]);
  await applySessionEntryOperation(store.scope, releaseProjectionConsumer);
  const released = await readSessionEntryReadOnlyInWorker(store.scope);
  await applySessionEntryOperation(store.scope, releaseProjectionConsumer);
  expect(await readSessionEntryReadOnlyInWorker(store.scope)).toEqual(released);
  expect(released?.completedFinalDeliveries).toEqual([]);
});
