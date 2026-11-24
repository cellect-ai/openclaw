import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ write: vi.fn(), read: vi.fn() }));
vi.mock("../../config/sessions/session-accessor.sqlite-entry.js", () => ({
  applySessionEntryOperation: m.write,
}));
vi.mock("../../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryReadOnlyInWorker: m.read,
}));
vi.mock("../../infra/agent-run-registry.js", () => ({
  getAgentRunLifecycleGeneration: () => "current-generation",
}));
import {
  appendNativeFinalDelivery,
  readNativeFinalDeliveryReceipt,
  retireNativeFinalDelivery,
} from "./native-final-delivery.js";

const plan = {
  agentId: "main",
  storePath: "/synthetic/main.sqlite",
  sessionKey: "agent:main:slack:channel:c1",
  sessionId: "session",
  intentId: "intent",
  sourceRunId: "run",
  sourceGeneration: "old-generation",
};
beforeEach(() => {
  vi.resetAllMocks();
});
it("refuses retirement of the current generation before worker mutation", async () => {
  await expect(
    retireNativeFinalDelivery(
      { ...plan, sourceGeneration: "current-generation" },
      "binding",
      () => {},
    ),
  ).rejects.toThrow("generation");
  expect(m.write).not.toHaveBeenCalled();
});
it("passes exact retirement assertion into the native worker commit guard", async () => {
  let current = true;
  m.write.mockImplementation(async (_scope, _operation, options) => {
    current = false;
    options.workerGuard.assertCurrent();
  });
  await expect(
    retireNativeFinalDelivery(plan, "binding", () => {
      if (!current) throw new Error("retirement revoked");
    }),
  ).rejects.toThrow("retirement revoked");
  expect(m.write).toHaveBeenCalledWith(
    expect.objectContaining({ storePath: plan.storePath }),
    expect.objectContaining({
      intentId: plan.intentId,
      sourceRunId: plan.sourceRunId,
      sourceGeneration: plan.sourceGeneration,
      retiredConsumer: "binding",
    }),
    expect.anything(),
  );
});
it("never sends a synthetic member if native retirement closed before append", async () => {
  m.write.mockResolvedValue({
    sessionId: "session",
    pendingFinalDelivery: { intentId: "intent", dispatchState: "closed", deliveries: [] },
  });
  const send = vi.fn();
  const deliver = async () => {
    await appendNativeFinalDelivery(plan, { text: "speech fallback" }, () => {});
    send();
  };
  await expect(deliver()).rejects.toThrow("changed before append");
  expect(send).not.toHaveBeenCalled();
});
it.each([
  { sessionId: "replacement" },
  { intentId: "replacement" },
  { sourceRunId: "replacement" },
  { sourceGeneration: "replacement" },
])("does not borrow a completed receipt from a changed native identity %j", async (replacement) => {
  const receipt = {
    ...plan,
    completedAt: 1,
    deliveries: [],
    projectionConsumers: ["binding"],
    ...replacement,
  };
  m.read.mockResolvedValue({ sessionId: "session", completedFinalDeliveries: [receipt] });
  expect(await readNativeFinalDeliveryReceipt(plan)).toBeUndefined();
});
