import { expect, vi } from "vitest";
import {
  applySessionEntryLifecycleMutation,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
  deleteSessionEntryLifecycle,
} from "./session-accessor.js";
import { applySessionEntryOperation } from "./session-accessor.sqlite-entry.js";
import { sessionTests } from "./session-entry-fixture.test-support.js";
import * as sessionReads from "./session-entry-read-runtime.js";
import { readSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";

const test = sessionTests({ prefix: "openclaw-final-projection-debt-", layout: "state-only" });
const pending = {
  kind: "transport-only" as const,
  createdAt: 1,
  intentId: "intent",
  sourceRunId: "run",
  sourceGeneration: "generation",
  dispatchState: "open" as const,
  deliveries: [{ id: "delivery", state: "prepared" as const }],
  projectionConsumers: ["matrix"],
};
test.for(["reset", "replace", "batched"] as const)(
  "refuses %s at native ownership while projection custody remains",
  async (mode, { store }) => {
    const { sessionKey, storePath } = store.scope;
    const scope = { sessionKey, storePath };
    await replaceSessionEntry(scope, {
      sessionId: "original",
      updatedAt: 1,
      pendingFinalDelivery: pending,
    });
    const replacement = { sessionId: "replacement", updatedAt: 2 };
    const reset =
      mode === "reset"
        ? () =>
            resetSessionEntryLifecycle({
              storePath,
              target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
              buildNextEntry: () => replacement,
            })
        : mode === "replace"
          ? () => replaceSessionEntry(scope, replacement)
          : () =>
              applySessionEntryLifecycleMutation({
                storePath,
                upserts: [
                  {
                    sessionKey,
                    entry: replacement,
                    resetBoundary: { context: "clear", reason: "new", cwd: "/synthetic" },
                  },
                ],
                skipMaintenance: true,
              });
    await expect(reset()).rejects.toThrow(/projection/i);
    expect(await readSessionEntryReadOnlyInWorker(scope)).toMatchObject({
      sessionId: "original",
      pendingFinalDelivery: pending,
    });
  },
);
test("enrollment after the reset precheck cannot be erased by its stale read", async ({
  store,
}) => {
  const { sessionKey, storePath } = store.scope;
  const scope = { sessionKey, storePath };
  await replaceSessionEntry(scope, {
    sessionId: "original",
    updatedAt: 1,
    pendingFinalDelivery: { ...pending, projectionConsumers: [] },
  });
  // The public reset precheck has released its read lease. Enroll through the
  // real native writer before returning the stale precheck snapshot; never nest
  // an awaited write inside buildNextEntry, which already owns the writer lane.
  const read = sessionReads.readSessionEntryReadOnlyInWorker;
  using precheck = vi
    .spyOn(sessionReads, "readSessionEntryReadOnlyInWorker")
    .mockImplementationOnce(async (...args) => {
      const snapshot = await read(...args);
      await applySessionEntryOperation(scope, {
        kind: "pending-final-projection",
        sessionId: "original",
        intentId: "intent",
        sourceRunId: "run",
        sourceGeneration: "generation",
        consumerId: "matrix",
        retainDeliveryId: "delivery",
      });
      return snapshot;
    });
  await expect(
    resetSessionEntryLifecycle({
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      buildNextEntry: () => ({ sessionId: "replacement", updatedAt: 2 }),
    }),
  ).rejects.toThrow(/projection/i);
  expect(precheck).toHaveBeenCalled();
  expect(await readSessionEntryReadOnlyInWorker(scope)).toMatchObject({
    sessionId: "original",
    pendingFinalDelivery: { projectionConsumers: ["matrix"] },
  });
});
test("explicit deletion refuses unpaid native projection debt instead of abandoning it", async ({
  store,
}) => {
  const { sessionKey, storePath } = store.scope;
  await replaceSessionEntry(store.scope, {
    sessionId: "original",
    updatedAt: 1,
    pendingFinalDelivery: pending,
  });
  await expect(
    deleteSessionEntryLifecycle({
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      archiveTranscript: false,
    }),
  ).rejects.toThrow(/projection/i);
  expect(await readSessionEntryReadOnlyInWorker(store.scope)).toMatchObject({
    sessionId: "original",
    pendingFinalDelivery: pending,
  });
});

test("same-session full replacement cannot erase completed debt; exact native release preserves other consumers", async ({
  store,
}) => {
  const receipt = {
    sessionId: "original",
    intentId: "intent",
    sourceRunId: "run",
    sourceGeneration: "generation",
    completedAt: 1,
    closure: "completed" as const,
    deliveries: [{ id: "delivery", state: "suppressed" as const }],
    projectionConsumers: ["matrix", "other"],
  };
  await replaceSessionEntry(store.scope, {
    sessionId: "original",
    updatedAt: 1,
    completedFinalDeliveries: [receipt],
  });
  await expect(
    replaceSessionEntry(store.scope, { sessionId: "original", updatedAt: 2 }),
  ).rejects.toThrow(/projection/i);
  await applySessionEntryOperation(store.scope, {
    kind: "pending-final-projection",
    sessionId: "original",
    intentId: "intent",
    sourceRunId: "run",
    sourceGeneration: "generation",
    consumerId: "matrix",
    release: true,
  });
  expect(await readSessionEntryReadOnlyInWorker(store.scope)).toMatchObject({
    completedFinalDeliveries: [{ ...receipt, projectionConsumers: ["other"] }],
  });
  await expect(
    replaceSessionEntry(store.scope, {
      sessionId: "original",
      updatedAt: 3,
      completedFinalDeliveries: [],
    }),
  ).rejects.toThrow(/projection/i);
});
