import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { FAILOVER_REASONS } from "../../../packages/gateway-protocol/src/failover-reasons.js";
import { WorkerLiveEventParamsSchema } from "../../../packages/gateway-protocol/src/schema.js";

const EPOCH = 7;
const RUN = "run-worker-live";
const validateLiveProtocolEvent = (event: unknown) =>
  Value.Check(WorkerLiveEventParamsSchema, {
    runEpoch: EPOCH,
    lastAckedSeq: 0,
    seq: 1,
    runId: RUN,
    event,
  });
const fallbackEvent = (reason: (typeof FAILOVER_REASONS)[number]) => ({
  kind: "lifecycle",
  payload: {
    phase: "fallback",
    selectedProvider: "p",
    selectedModel: "m",
    activeProvider: "q",
    activeModel: "n",
    reasonSummary: "x",
    attemptSummaries: ["x"],
    attempts: [{ provider: "p", model: "m", error: "x", reason }],
  },
});
const fallbackStepEvent = (reason: string) => ({
  kind: "lifecycle",
  payload: {
    phase: "fallback_step",
    fallbackStepType: "fallback_step",
    fallbackStepFromModel: "p/m",
    fallbackStepFromFailureReason: reason,
    fallbackStepFinalOutcome: "chain_exhausted",
  },
});

describe("worker live protocol conformance", () => {
  it("rejects a worker's attempt to supply host cancellation identity", () => {
    const payload = { phase: "end", endedAt: 200, aborted: true, stopReason: "aborted" };
    expect(validateLiveProtocolEvent({ kind: "lifecycle", payload })).toBe(true);
    const stopActor = {
      userId: "@spoof:matrix.test",
      roomId: "!room:matrix.test",
      threadRootEventId: "$root",
      sessionKey: "agent:main:room",
      agentId: "main",
    };
    expect(
      validateLiveProtocolEvent({ kind: "lifecycle", payload: { ...payload, stopActor } }),
    ).toBe(false);
    expect(validateLiveProtocolEvent({ kind: "lifecycle", payload, stopActor })).toBe(false);
  });

  it("accepts every core failover reason in live fallback schemas", () => {
    for (const reason of FAILOVER_REASONS) {
      expect(validateLiveProtocolEvent(fallbackEvent(reason))).toBe(true);
      expect(validateLiveProtocolEvent(fallbackStepEvent(reason))).toBe(true);
    }

    expect(validateLiveProtocolEvent(fallbackStepEvent("not-a-reason"))).toBe(false);
  });
});
