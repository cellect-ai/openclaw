import type { FinalProjectionTransition } from "./pending-final-delivery-receipt.js";
import {
  reduceSessionEntryPatch,
  type SessionEntryPatchOperation,
} from "./session-entry-patch-operation.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Called only after the native settlement reducer has produced its postimage. */
export function captureFinalProjectionTransition(
  previous: SessionEntry | undefined,
  next: SessionEntry,
): FinalProjectionTransition | undefined {
  if (!previous?.pendingFinalDelivery?.projectionConsumers?.length) return undefined;
  const projection = (entry: SessionEntry) => ({
    pendingFinalDelivery: entry.pendingFinalDelivery,
    completedFinalDeliveries: entry.completedFinalDeliveries,
  });
  return structuredClone({
    sessionId: previous.sessionId,
    before: projection(previous),
    after: projection(next),
  });
}

/** Replay only closed native final operations; fields/callbacks never authorize custody changes. */
export function finalProjectionTransitionForOperation(
  previous: SessionEntry | undefined,
  operation: SessionEntryPatchOperation,
): FinalProjectionTransition | undefined {
  if (!previous?.pendingFinalDelivery?.projectionConsumers?.length) return undefined;
  const steps = operation.kind === "compound" ? operation.operations : [operation];
  let next = previous;
  for (const step of steps) {
    if (
      step.kind !== "pending-final-clear" &&
      step.kind !== "pending-final-dispatch" &&
      step.kind !== "pending-final-projection"
    )
      continue;
    const patch = reduceSessionEntryPatch(step, next, next);
    if (patch) next = { ...next, ...patch };
  }
  return captureFinalProjectionTransition(previous, next);
}
