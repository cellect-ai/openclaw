import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../agents/operational-run-instance.js";
import {
  emitAgentEvent,
  onAgentEvent,
  registerAgentEventPersistenceHandler,
  resetAgentEventsForTest,
} from "./agent-events.js";
import { registerAgentRunAdmissionHandler, registerAgentRunContext } from "./agent-run-registry.js";
import {
  bindAgentRunTerminalWriteSettlement,
  captureAgentRunTerminalPersistence,
  drainAgentRunTerminalWrites,
} from "./agent-run-terminal-writes.js";

describe("required lifecycle settlement beside native terminal writes", () => {
  beforeEach(() => resetAgentEventsForTest());
  afterEach(() => resetAgentEventsForTest());

  it("retains native best-effort write failures", async () => {
    const instance = createOperationalRunInstanceRef("native-terminal");
    registerAgentRunContext(instance.runId, { agentId: "test" });
    bindAgentRunTerminalWriteSettlement(instance);
    captureAgentRunTerminalPersistence(instance.runId).track?.(
      Promise.reject(new Error("optional write")),
    );
    await expect(drainAgentRunTerminalWrites(instance)).resolves.toBeUndefined();
  });

  it("propagates a required lifecycle failure even after that write settled", async () => {
    const instance = createOperationalRunInstanceRef("required-terminal");
    registerAgentRunAdmissionHandler(() => Promise.reject(new Error("required lifecycle commit")));
    registerAgentRunContext(instance.runId, { agentId: "test" });
    bindAgentRunTerminalWriteSettlement(instance);
    await Promise.resolve();
    await expect(drainAgentRunTerminalWrites(instance)).rejects.toThrow(
      "required lifecycle commit",
    );
  });

  it("joins terminal writes enqueued by observers after the required commit", async () => {
    const instance = createOperationalRunInstanceRef("deferred-terminal");
    registerAgentRunContext(instance.runId, { agentId: "test" });
    bindAgentRunTerminalWriteSettlement(instance);
    let commit!: () => void;
    const committed = new Promise<void>((resolve) => {
      commit = resolve;
    });
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    registerAgentEventPersistenceHandler(() => committed);
    const observe = vi.fn(() => {
      captureAgentRunTerminalPersistence(instance.runId).track?.(finished);
    });
    onAgentEvent(observe);
    emitAgentEvent({ runId: instance.runId, stream: "lifecycle", data: { phase: "end" } });
    let settled = false;
    const settlement = drainAgentRunTerminalWrites(instance).then(() => {
      settled = true;
    });
    commit();
    await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    finish();
    await settlement;
    expect(settled).toBe(true);
  });
});
