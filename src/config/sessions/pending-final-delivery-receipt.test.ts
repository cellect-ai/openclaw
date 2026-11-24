import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  assertFinalProjectionReplacementAllowed,
  assertNoPendingFinalProjectionDebt,
  projectFinalDeliveryCleanup,
} from "./pending-final-delivery-receipt.js";
import { projectSessionEntryPatch } from "./session-entry-patch-operation.js";
import { projectPendingFinalDeliverySettlement } from "./session-pending-final-settlement.js";
import { projectCanonicalSessionEntryShape } from "./store-entry-shape.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

function fixture(): SessionEntry {
  return {
    sessionId: "session",
    updatedAt: 1,
    pendingFinalDelivery: {
      kind: "transport-only",
      createdAt: 1,
      intentId: "intent",
      sourceRunId: "run",
      sourceGeneration: "generation",
      dispatchState: "open",
      projectionConsumers: ["matrix-binding"],
      context: { channel: "slack", to: "C1", accountId: "source" },
      deliveries: [
        { id: "first", state: "prepared" },
        { id: "last", state: "prepared" },
      ],
    },
  };
}
function settle(
  entry: SessionEntry,
  deliveryId: string,
  state: "delivered" | "suppressed" | "queued" | "unknown",
  messageId?: string,
) {
  const result = projectPendingFinalDeliverySettlement(
    entry,
    {
      sessionId: "session",
      intentId: "intent",
      deliveryId,
      state,
      cleanup: { sessionKey: "agent:main:slack:channel:c1", now: 10 },
    },
    messageId
      ? {
          result: {
            channel: "slack",
            platformMessageId: messageId,
            resultCount: 1,
            verifiedContext: entry.pendingFinalDelivery?.context,
          },
        }
      : undefined,
  );
  return { ...entry, ...result.patch };
}
function close(entry: SessionEntry) {
  return (
    projectSessionEntryPatch({
      existing: entry,
      writeBase: entry,
      sessionKey: "agent:main:slack:channel:c1",
      operation: {
        kind: "pending-final-dispatch",
        sessionId: "session",
        intentId: "intent",
        sourceRunId: "run",
        sourceGeneration: "generation",
        close: true,
        now: 11,
      },
    }) ?? entry
  );
}
describe("native final dispatch closure", () => {
  it("keeps two accepted source receipts open until producer close and preserves order across hydration", () => {
    const delivered = settle(
      settle(fixture(), "last", "delivered", "2.000001"),
      "first",
      "delivered",
      "1.000001",
    );
    expect(delivered.completedFinalDeliveries).toBeUndefined();
    expect(delivered.pendingFinalDelivery?.dispatchState).toBe("open");
    const closed = projectCanonicalSessionEntryShape(JSON.parse(JSON.stringify(close(delivered))));
    expect(closed.pendingFinalDelivery).toBeUndefined();
    expect(closed.completedFinalDeliveries?.[0]).toMatchObject({
      sessionId: "session",
      sourceRunId: "run",
      sourceGeneration: "generation",
      intentId: "intent",
      deliveries: [
        { id: "first", state: "delivered", receipt: { platformMessageId: "1.000001" } },
        { id: "last", state: "delivered", receipt: { platformMessageId: "2.000001" } },
      ],
    });
  });
  it.each(["prepared", "queued", "unknown"] as const)(
    "does not complete a closed plan with a %s member",
    (state) => {
      let entry = settle(fixture(), "first", "delivered", "1");
      if (state !== "prepared") entry = settle(entry, "last", state);
      const closed = close(entry);
      expect(closed.pendingFinalDelivery?.dispatchState).toBe("closed");
      expect(closed.completedFinalDeliveries).toBeUndefined();
    },
  );
  it("settles after closure through the same native member owner", () => {
    const closed = close(settle(fixture(), "first", "delivered", "1"));
    const settled = settle(closed, "last", "delivered", "2");
    expect(settled.pendingFinalDelivery).toBeUndefined();
    expect(
      settled.completedFinalDeliveries?.[0]?.deliveries.at(-1)?.receipt?.platformMessageId,
    ).toBe("2");
  });
  it("retains explicit suppressed suffix and all-suppressed plans without inventing receipts", () => {
    const suffix = close(
      settle(settle(fixture(), "first", "delivered", "1"), "last", "suppressed"),
    );
    expect(suffix.completedFinalDeliveries?.[0]?.deliveries[1]).toEqual({
      id: "last",
      state: "suppressed",
    });
    const silent = close(settle(settle(fixture(), "first", "suppressed"), "last", "suppressed"));
    expect(
      silent.completedFinalDeliveries?.[0]?.deliveries.every(
        (member) => member.receipt === undefined,
      ),
    ).toBe(true);
  });
  it("does not manufacture a physical receipt from state-only or mismatched route evidence", () => {
    let entry = settle(fixture(), "first", "delivered");
    const mismatch = projectPendingFinalDeliverySettlement(
      entry,
      { sessionId: "session", intentId: "intent", deliveryId: "last", state: "delivered" },
      {
        result: {
          channel: "slack",
          platformMessageId: "foreign",
          resultCount: 1,
          verifiedContext: { channel: "slack", to: "C2" },
        },
      },
    );
    entry = close({ ...entry, ...mismatch.patch });
    expect(
      entry.completedFinalDeliveries?.[0]?.deliveries.every(
        (member) => member.receipt === undefined,
      ),
    ).toBe(true);
  });
  it("refuses a newer intent/run/generation and cannot append after closure", () => {
    for (const changed of [
      { intentId: "new" },
      { sourceRunId: "new" },
      { sourceGeneration: "new" },
    ]) {
      const entry = fixture();
      entry.pendingFinalDelivery = { ...entry.pendingFinalDelivery!, ...changed };
      expect(close(entry)).toEqual(entry);
    }
    const entry = close(fixture());
    expect(
      projectSessionEntryPatch({
        existing: entry,
        writeBase: entry,
        sessionKey: "agent:main:slack:channel:c1",
        operation: {
          kind: "pending-final-dispatch",
          sessionId: "session",
          intentId: "intent",
          sourceRunId: "run",
          sourceGeneration: "generation",
          appendDeliveryId: "late",
          now: 12,
        },
      }),
    ).toBeUndefined();
  });
  it("serializes both append/retirement orders without changing member dispositions", () => {
    const entry = fixture();
    const append = {
      kind: "pending-final-dispatch" as const,
      sessionId: "session",
      intentId: "intent",
      sourceRunId: "run",
      sourceGeneration: "generation",
      appendDeliveryId: "tts",
      now: 2,
    };
    const retire = {
      kind: "pending-final-dispatch" as const,
      sessionId: "session",
      intentId: "intent",
      sourceRunId: "run",
      sourceGeneration: "generation",
      close: true as const,
      retiredConsumer: "matrix-binding",
      now: 3,
    };
    const patch = (current: SessionEntry, operation: typeof append | typeof retire) =>
      projectSessionEntryPatch({
        existing: current,
        writeBase: current,
        sessionKey: "agent:main:slack:channel:c1",
        operation,
      });
    const appended = patch(entry, append)!;
    const retiredAfterAppend = patch(appended, retire)!;
    expect(retiredAfterAppend.pendingFinalDelivery).toMatchObject({
      dispatchState: "closed",
      dispatchClosure: "retired",
      deliveries: [
        { id: "first", state: "prepared" },
        { id: "last", state: "prepared" },
        { id: "tts", state: "prepared" },
      ],
    });
    expect(patch(retiredAfterAppend, retire)).toBeUndefined();
    const retiredFirst = patch(entry, retire)!;
    expect(patch(retiredFirst, append)).toBeUndefined();
    expect(retiredFirst.completedFinalDeliveries).toBeUndefined();
  });
  it("retains required debt beyond a TTL and refuses reset until exact consumer release", () => {
    const entry = close(settle(settle(fixture(), "first", "delivered", "1"), "last", "suppressed"));
    expect(() => assertNoPendingFinalProjectionDebt(entry)).toThrow("Restore projection delivery");
    const next = { ...fixture(), completedFinalDeliveries: entry.completedFinalDeliveries };
    next.pendingFinalDelivery = {
      ...next.pendingFinalDelivery!,
      intentId: "new",
      dispatchState: "closed",
      deliveries: [{ id: "new", state: "suppressed" }],
    };
    const late = projectFinalDeliveryCleanup(next, {
      sessionId: "session",
      intentId: "new",
      now: 366 * 24 * 60 * 60 * 1000,
    });
    expect(late?.completedFinalDeliveries?.[0]).toEqual(entry.completedFinalDeliveries?.[0]);
    const released = projectSessionEntryPatch({
      existing: entry,
      writeBase: entry,
      sessionKey: "agent:main:slack:channel:c1",
      operation: {
        kind: "pending-final-projection",
        sessionId: "session",
        intentId: "intent",
        sourceRunId: "run",
        sourceGeneration: "generation",
        consumerId: "matrix-binding",
        release: true,
      },
    });
    expect(() => assertNoPendingFinalProjectionDebt(released)).not.toThrow();
  });
});

describe("completed projection replacement restriction", () => {
  const release = {
    sessionId: "session",
    intentId: "intent",
    sourceRunId: "run",
    sourceGeneration: "generation",
    consumerId: "matrix-binding",
  };
  function completed() {
    const entry = close(settle(settle(fixture(), "first", "suppressed"), "last", "suppressed"));
    expectDefined(entry.completedFinalDeliveries?.[0]).projectionConsumers.push("other-binding");
    return entry;
  }
  it("refuses same-session replacement that erases owed completed custody", () => {
    const entry = completed();
    expect(() =>
      assertFinalProjectionReplacementAllowed(entry, { sessionId: entry.sessionId, updatedAt: 2 }),
    ).toThrow("completed native final projection");
  });
  it.each([
    { sessionId: "other" },
    { intentId: "other" },
    { sourceRunId: "other" },
    { sourceGeneration: "other" },
    { consumerId: "other" },
  ])("refuses mismatched native release %j", (mismatch) => {
    const entry = completed();
    expect(() =>
      assertFinalProjectionReplacementAllowed(entry, { ...entry, completedFinalDeliveries: [] }, [
        { ...release, ...mismatch },
      ]),
    ).toThrow("release no longer matches");
  });
  it("releases exactly one consumer while preserving physical receipt and every other consumer", () => {
    const entry = completed();
    const receipt = expectDefined(entry.completedFinalDeliveries?.[0]);
    const next = {
      ...entry,
      completedFinalDeliveries: [{ ...receipt, projectionConsumers: ["other-binding"] }],
    };
    expect(() => assertFinalProjectionReplacementAllowed(entry, next, [release])).not.toThrow();
    expect(() =>
      assertFinalProjectionReplacementAllowed(entry, { ...next, completedFinalDeliveries: [] }, [
        release,
      ]),
    ).toThrow("completed native final projection");
    expect(() =>
      assertFinalProjectionReplacementAllowed(
        entry,
        {
          ...next,
          completedFinalDeliveries: [
            { ...expectDefined(next.completedFinalDeliveries[0]), completedAt: 99 },
          ],
        },
        [release],
      ),
    ).toThrow("completed native final projection");
    expect(() => assertFinalProjectionReplacementAllowed(next, next, [release])).toThrow(
      "release no longer matches",
    );
  });
});
