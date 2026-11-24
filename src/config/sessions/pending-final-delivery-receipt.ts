import { isDeepStrictEqual } from "node:util";
import type { CompletedFinalDelivery } from "./pending-final-delivery-types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export const FINAL_DELIVERY_RECEIPT_LIMIT = 64;

export type FinalProjectionRelease = Pick<
  CompletedFinalDelivery,
  "sessionId" | "intentId" | "sourceRunId" | "sourceGeneration"
> & { consumerId: string };

/** Exact native reducer transition; generic replacement contents cannot mint one. */
export type FinalProjectionTransition = {
  sessionId: string;
  before: Pick<SessionEntry, "pendingFinalDelivery" | "completedFinalDeliveries">;
  after: Pick<SessionEntry, "pendingFinalDelivery" | "completedFinalDeliveries">;
};

/** Runs with the canonical row under the native write owner, including batched replacement. */
export function assertFinalProjectionReplacementAllowed(
  previous: SessionEntry | undefined,
  next: SessionEntry,
  releases: readonly FinalProjectionRelease[] = [],
  transition?: FinalProjectionTransition,
): void {
  if (previous && previous.sessionId !== next.sessionId)
    assertNoPendingFinalProjectionDebt(previous);
  for (const release of releases) {
    if (
      previous?.sessionId !== release.sessionId ||
      next.sessionId !== release.sessionId ||
      !previous.completedFinalDeliveries?.some(
        (receipt) =>
          receipt.sessionId === release.sessionId &&
          receipt.intentId === release.intentId &&
          receipt.sourceRunId === release.sourceRunId &&
          receipt.sourceGeneration === release.sourceGeneration &&
          receipt.projectionConsumers.includes(release.consumerId),
      )
    ) {
      throw new Error("Native final projection release no longer matches current custody");
    }
  }
  for (const receipt of previous?.completedFinalDeliveries ?? []) {
    if (!receipt.projectionConsumers.length) continue;
    const projectionConsumers = receipt.projectionConsumers.filter(
      (consumerId) =>
        !releases.some(
          (release) =>
            release.sessionId === receipt.sessionId &&
            release.intentId === receipt.intentId &&
            release.sourceRunId === receipt.sourceRunId &&
            release.sourceGeneration === receipt.sourceGeneration &&
            release.consumerId === consumerId,
        ),
    );
    const retained = next.completedFinalDeliveries?.find(
      (candidate) =>
        candidate.sessionId === receipt.sessionId && candidate.intentId === receipt.intentId,
    );
    if (
      projectionConsumers.length
        ? !isDeepStrictEqual(retained, { ...receipt, projectionConsumers })
        : retained !== undefined
    ) {
      throw new Error(
        "Session replacement refused: completed native final projection custody is still outstanding",
      );
    }
  }
  const pending = previous?.pendingFinalDelivery;
  if (!pending?.projectionConsumers?.length) return;
  const before = {
    pendingFinalDelivery: pending,
    completedFinalDeliveries: previous?.completedFinalDeliveries,
  };
  if (
    transition &&
    (transition.sessionId !== previous?.sessionId || !isDeepStrictEqual(transition.before, before))
  ) {
    throw new Error("Native final transition no longer matches current custody");
  }
  const expected = transition?.after ?? before;
  if (
    next.sessionId !== previous?.sessionId ||
    !isDeepStrictEqual(next.pendingFinalDelivery, expected.pendingFinalDelivery) ||
    !isDeepStrictEqual(next.completedFinalDeliveries, expected.completedFinalDeliveries)
  ) {
    throw new Error(
      "Session replacement refused: native final projection custody is still outstanding",
    );
  }
}

export function assertNoPendingFinalProjectionDebt(entry: SessionEntry | undefined): void {
  if (
    entry?.pendingFinalDelivery?.projectionConsumers?.length ||
    entry?.completedFinalDeliveries?.some((receipt) => receipt.projectionConsumers.length > 0)
  ) {
    throw new Error(
      "Session removal/reset refused: an accepted final still owes its Matrix projection receipt. Restore projection delivery and retry after the durable join is acknowledged.",
    );
  }
}

/** Called only by native pending-final cleanup, within its existing write transaction. */
export function projectFinalDeliveryCleanup(
  entry: SessionEntry,
  input: { sessionId: string; intentId: string; now: number },
): Partial<SessionEntry> | null {
  const pending = entry.pendingFinalDelivery;
  if (
    entry.sessionId !== input.sessionId ||
    pending?.intentId !== input.intentId ||
    !pending.deliveries ||
    pending.dispatchState === "open" ||
    !pending.deliveries.every(({ state }) => state === "delivered" || state === "suppressed")
  )
    return null;
  // Preserve legacy cleanup, without manufacturing a completed plan for older rows.
  if (pending.dispatchState !== "closed") {
    return pending.deliveries.length ? { pendingFinalDelivery: undefined } : null;
  }
  if (!pending.sourceRunId || !pending.sourceGeneration) {
    throw new Error("Closed native final intent has no source identity");
  }
  if (!pending.projectionConsumers?.length) return { pendingFinalDelivery: undefined };
  const receipt: CompletedFinalDelivery = {
    sessionId: entry.sessionId,
    intentId: input.intentId,
    sourceRunId: pending.sourceRunId,
    sourceGeneration: pending.sourceGeneration,
    completedAt: input.now,
    context: pending.context,
    closure: pending.dispatchClosure ?? "completed",
    deliveries: pending.deliveries.map((delivery) => ({ ...delivery })),
    projectionConsumers: pending.projectionConsumers.slice(),
  };
  // Required projection debt is removed only by its consumer acknowledgement.
  // Age is never evidence that publication succeeded.
  const retained = entry.completedFinalDeliveries ?? [];
  const prior = retained.find((candidate) => candidate.intentId === receipt.intentId);
  if (prior && !isDeepStrictEqual({ ...prior, completedAt: 0 }, { ...receipt, completedAt: 0 })) {
    throw new Error("Native final completion receipt conflicts with retained custody");
  }
  if (!prior && retained.length >= FINAL_DELIVERY_RECEIPT_LIMIT) {
    throw new Error("Native final completion receipt capacity exceeded");
  }
  return {
    pendingFinalDelivery: undefined,
    completedFinalDeliveries: prior ? retained : [...retained, receipt],
  };
}
