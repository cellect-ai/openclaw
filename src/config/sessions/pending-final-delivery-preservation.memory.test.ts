import { expect, it } from "vitest";
import {
  appendProjectionMember,
  closeProjectionPlan,
  pendingProjectionFixture,
} from "./pending-final-delivery-preservation.test-support.js";
import { memoryOwnerFixture } from "./session-actor-memory-family.test-support.js";
import {
  commitMemory,
  mutateMemory,
  readMemory,
} from "./session-actor-memory-publication.test-support.js";
const sessionKey = "agent:main:dashboard:incognito-final-preservation";
const open = memoryOwnerFixture({ agentId: "main", path: "/synthetic/final-preservation" });
it("memory replacement with a current CAS cannot restore stale members or forge pending closure", async () => {
  const { store } = await open(sessionKey);
  await commitMemory(store, "session.entry.create", {
    entry: pendingProjectionFixture(),
    cwd: "/synthetic",
  });
  const stale = await readMemory(store, "session.entry.read", {});
  await commitMemory(store, "session.entry.patch", { operation: appendProjectionMember });
  const expected = await readMemory(store, "session.entry.read", {});
  const outcome = await mutateMemory(store, "session.entry.replace", { expected, entry: stale });
  expect(outcome.kind).toBe("rolled-back");
  expect(await readMemory(store, "session.entry.read", {})).toEqual(expected);
  const forged = await mutateMemory(store, "session.entry.patch", {
    operation: {
      kind: "compound",
      operations: [
        {
          kind: "fields",
          patch: { pendingFinalDelivery: { ...expected!.pendingFinalDelivery!, deliveries: [] } },
        },
        closeProjectionPlan,
      ],
    },
  });
  expect(forged.kind).toBe("rolled-back");
  expect(await readMemory(store, "session.entry.read", {})).toEqual(expected);
  await commitMemory(store, "session.entry.patch", { operation: closeProjectionPlan });
  expect((await readMemory(store, "session.entry.read", {}))?.pendingFinalDelivery).toMatchObject({
    dispatchState: "closed",
    deliveries: [
      { id: "first", state: "prepared" },
      { id: "late-tts", state: "prepared" },
    ],
  });
});
