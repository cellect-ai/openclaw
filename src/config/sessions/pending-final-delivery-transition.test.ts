import { describe, expect, it } from "vitest";
import {
  appendProjectionMember,
  pendingProjectionFixture,
} from "./pending-final-delivery-preservation.test-support.js";
import { assertFinalProjectionReplacementAllowed } from "./pending-final-delivery-receipt.js";
import { finalProjectionTransitionForOperation } from "./pending-final-delivery-transition.js";
import { projectSessionEntryPatch } from "./session-entry-patch-operation.js";

describe("pending final native transition authorization", () => {
  it.each(["membership", "context", "closure", "receipt", "consumer"] as const)(
    "generic replacement cannot mutate %s while retaining intent identity",
    (change) => {
      const previous = pendingProjectionFixture();
      const next = structuredClone(previous);
      const pending = next.pendingFinalDelivery!;
      switch (change) {
        case "membership":
          pending.deliveries = [];
          break;
        case "context":
          pending.context = { channel: "slack", to: "OTHER" };
          break;
        case "closure":
          pending.dispatchState = "closed";
          break;
        case "receipt":
          pending.deliveries = [
            {
              id: "first",
              state: "delivered",
              receipt: {
                platformMessageId: "invented",
                finalPlatformMessageId: "invented",
                resultCount: 1,
              },
            },
          ];
          break;
        case "consumer":
          pending.projectionConsumers!.push("other");
          break;
      }
      expect(() => assertFinalProjectionReplacementAllowed(previous, next)).toThrow(
        /projection custody/,
      );
      const forged = finalProjectionTransitionForOperation(previous, {
        kind: "fields",
        patch: next,
      });
      expect(() => assertFinalProjectionReplacementAllowed(previous, next, [], forged)).toThrow(
        /projection custody/,
      );
    },
  );
  it("binds the exact preimage and postimage rather than an intent-wide mutation exemption", () => {
    const previous = pendingProjectionFixture();
    const operation = appendProjectionMember;
    const next = projectSessionEntryPatch({
      existing: previous,
      writeBase: previous,
      sessionKey: "agent:main:slack:channel:c1",
      operation,
    })!;
    const transition = finalProjectionTransitionForOperation(previous, operation);
    expect(() =>
      assertFinalProjectionReplacementAllowed(previous, next, [], transition),
    ).not.toThrow();
    expect(() => assertFinalProjectionReplacementAllowed(next, next, [], transition)).toThrow(
      /no longer matches/,
    );
    const altered = structuredClone(next);
    altered.pendingFinalDelivery!.context = { channel: "slack", to: "OTHER" };
    expect(() =>
      assertFinalProjectionReplacementAllowed(previous, altered, [], transition),
    ).toThrow(/projection custody/);
    expect(() =>
      assertFinalProjectionReplacementAllowed(previous, { ...previous, updatedAt: 9 }),
    ).not.toThrow();
  });
});
