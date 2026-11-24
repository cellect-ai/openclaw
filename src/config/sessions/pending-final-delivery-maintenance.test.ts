import { expect } from "vitest";
import { applySessionEntryOperation } from "./session-accessor.sqlite-entry.js";
import {
  readSessionMaintenanceAgeCandidates,
  readSessionMaintenanceCapCandidates,
} from "./session-accessor.sqlite-maintenance-candidates.js";
import { sessionTests } from "./session-entry-fixture.test-support.js";
import {
  capEntryCount,
  isSessionEntryDiskBudgetEvictable,
  pruneStaleEntries,
} from "./store-maintenance.js";

const test = sessionTests({
  prefix: "openclaw-final-projection-maintenance-",
  layout: "state-only",
});
test("native age/count projections and disk eligibility retain exact final debt until consumer acknowledgement", async ({
  store,
}) => {
  const { sessionKey } = store;
  store.replace({
    completedFinalDeliveries: [
      {
        sessionId: "original",
        intentId: "intent",
        sourceRunId: "run",
        sourceGeneration: "generation",
        completedAt: 1,
        closure: "completed",
        projectionConsumers: ["matrix"],
        deliveries: [
          {
            id: "member",
            state: "delivered",
            receipt: { platformMessageId: "first", finalPlatformMessageId: "last", resultCount: 2 },
          },
        ],
      },
    ],
  });
  const readAge = () =>
    readSessionMaintenanceAgeCandidates({
      database: store.database,
      minimumAgeMs: 1,
      pruneAfterMs: 1,
      archiveDashboardAfterMs: null,
      modelRunPruneAfterMs: null,
      nowMs: 10_000,
    }).store;
  const readCap = () =>
    readSessionMaintenanceCapCandidates({
      database: store.database,
      activeSessionKeys: [],
      excludedKeys: new Set(),
      overflow: 1,
      readPreserveKeys: () => new Set(),
      nowMs: 10_000,
    }).store;
  const owed = readAge();
  expect(owed[sessionKey]?.completedFinalDeliveries?.[0]?.projectionConsumers).toEqual(["matrix"]);
  pruneStaleEntries(owed, 1, { nowMs: 10_000, log: false });
  capEntryCount(owed, 0, { nowMs: 10_000, log: false });
  expect(owed[sessionKey]?.archivedAt).toBeUndefined();
  expect(readCap()[sessionKey]).toBeUndefined();
  expect(
    isSessionEntryDiskBudgetEvictable({
      key: sessionKey,
      entry: { ...owed[sessionKey]!, archivedAt: 2, archiveReason: "active-session-cap" },
      nowMs: 10_000,
    }),
  ).toBe(false);
  await applySessionEntryOperation(
    store.scope,
    {
      kind: "pending-final-projection",
      sessionId: "original",
      intentId: "intent",
      sourceRunId: "run",
      sourceGeneration: "generation",
      consumerId: "matrix",
      release: true,
    },
    { preserveActivity: true, skipMaintenance: true },
  );
  const released = readAge();
  expect(readCap()[sessionKey]).toBeDefined();
  capEntryCount(released, 0, { nowMs: 10_000, log: false });
  expect(released[sessionKey]?.archiveReason).toBe("active-session-cap");
  expect(
    isSessionEntryDiskBudgetEvictable({
      key: sessionKey,
      entry: released[sessionKey],
      nowMs: 10_000,
    }),
  ).toBe(true);
  const ageReleased = readAge();
  pruneStaleEntries(ageReleased, 1, { nowMs: 10_000, log: false });
  expect(ageReleased[sessionKey]?.archiveReason).toBe("age-retention");
});
