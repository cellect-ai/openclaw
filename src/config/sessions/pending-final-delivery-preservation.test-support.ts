import type { InternalSessionEntry as SessionEntry } from "./types.js";

export function pendingProjectionFixture(): SessionEntry {
  return {
    sessionId: "original",
    updatedAt: 1,
    pendingFinalDelivery: {
      kind: "transport-only",
      createdAt: 1,
      intentId: "intent",
      sourceRunId: "run",
      sourceGeneration: "generation",
      dispatchState: "open",
      projectionConsumers: ["matrix"],
      context: { channel: "slack", to: "C1", accountId: "source" },
      deliveries: [{ id: "first", state: "prepared" }],
    },
  };
}
export const appendProjectionMember = {
  kind: "pending-final-dispatch" as const,
  sessionId: "original",
  intentId: "intent",
  sourceRunId: "run",
  sourceGeneration: "generation",
  appendDeliveryId: "late-tts",
  now: 2,
};
export const closeProjectionPlan = {
  kind: "pending-final-dispatch" as const,
  sessionId: "original",
  intentId: "intent",
  sourceRunId: "run",
  sourceGeneration: "generation",
  close: true as const,
  now: 3,
};
export const releaseProjectionConsumer = {
  kind: "pending-final-projection" as const,
  sessionId: "original",
  intentId: "intent",
  sourceRunId: "run",
  sourceGeneration: "generation",
  consumerId: "matrix",
  release: true as const,
};
