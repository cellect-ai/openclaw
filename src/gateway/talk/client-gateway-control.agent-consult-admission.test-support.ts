import { expect, it } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import {
  getActiveGatewayRootWorkCount,
  isGatewaySubordinateWorkAdmissionClosed,
  markGatewayRestartDraining,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import {
  createRunner,
  registerConsultVoiceSession,
} from "./client-gateway-control.agent-consult-fixture.test-support.js";
import {
  config,
  coreParams,
  deferred,
  mocks,
} from "./client-gateway-control.agent-consult.test-support.js";

/** Shares the parent suite's native owner cleanup and execution mocks. */
export function registerTalkConsultAdmissionTests() {
  it("re-admits a delayed provider consult after its creating RPC root was released", async () => {
    const creatingRpc = tryBeginGatewayRootWorkAdmission();
    expect(creatingRpc).not.toBeNull();
    if (!creatingRpc) {
      throw new Error("expected creating RPC admission");
    }
    let delayedConsult: (() => Promise<{ text: string }>) | undefined;
    await creatingRpc.run(async () => {
      delayedConsult = () => createRunner().runPrompt({ prompt: "check" });
    });
    creatingRpc.release();

    mocks.runEmbeddedAgentCore.mockImplementationOnce(async () => {
      expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(false);
      return { payloads: [] };
    });
    expect(delayedConsult).toBeDefined();
    await expect(delayedConsult?.()).resolves.toEqual({ text: "done" });
  });

  it("runs through a Talk-owned gateway admission and closes it after success", async () => {
    await expect(createRunner().runPrompt({ prompt: "check" })).resolves.toEqual({ text: "done" });

    expect(mocks.prepareAgentRunAdmission).toHaveBeenCalledWith({
      cfg: config,
      operationalRunInstance: { instanceId: "instance:run-talk", runId: "run-talk" },
      facts: {
        runId: "run-talk",
        agentId: "researcher",
        ingress: {
          kind: "gateway-client",
          boundary: "talk-agent-consult",
          state: "present",
        },
      },
    });
    expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledWith(
      expect.objectContaining({
        ...coreParams,
        preparedRunAdmission: expect.objectContaining({ close: mocks.close }),
      }),
    );
    expect(mocks.consultRealtimeVoiceAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "researcher",
        sessionKey: "agent:researcher:talk",
        storePath: "/tmp/sessions",
        senderIsOwner: false,
        toolsAllow: ["read"],
      }),
    );
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("admits a fresh consult on a retained call during suspension and lets it finish after audio detaches", async () => {
    const creating = tryBeginGatewayRootWorkAdmission("talk-call-fixture")!;
    let runner!: ReturnType<typeof createRunner>;
    let close!: () => void;
    await creating.run(async () => {
      runner = createRunner();
      close = registerConsultVoiceSession();
    });
    creating.release();
    const suspended = tryBeginGatewaySuspendAdmission(() => {})!;
    expect(suspended.drain()).toBe(true);
    const started = deferred<void>();
    const finish = deferred<void>();
    mocks.runEmbeddedAgentCore.mockImplementationOnce(async () => {
      expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(false);
      started.resolve();
      await finish.promise;
      return { payloads: [] };
    });
    const consult = runner.runPrompt({ prompt: "A new question after drain started" });
    try {
      await awaitGateBeforeSettlement(
        started.promise,
        consult,
        "Consult settled before core admission",
      );
      close();
      expect(getActiveGatewayRootWorkCount()).toBeGreaterThan(0);
      finish.resolve();
      await expect(consult).resolves.toEqual({ text: "done" });
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      await expect(runner.runPrompt({ prompt: "Stale callback" })).rejects.toThrow(
        /continuation is no longer active/,
      );
    } finally {
      close();
      finish.resolve();
      await consult.catch(() => undefined);
      suspended.release();
    }
  });

  it("rejects an unretained new consult during suspension", async () => {
    const runner = createRunner();
    const suspended = tryBeginGatewaySuspendAdmission(() => {});
    if (!suspended) throw new Error("Expected suspension admission");
    try {
      expect(suspended.commit()).toBe(true);
      await expect(runner.runPrompt({ prompt: "New unrelated work" })).rejects.toThrow(
        /temporarily paused/,
      );
      expect(mocks.consultRealtimeVoiceAgent).not.toHaveBeenCalled();
      expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      suspended.release();
    }
  });

  it("rejects a fresh consult on a retained call after restart drain begins", async () => {
    const creating = tryBeginGatewayRootWorkAdmission("talk-call-restart-fixture");
    if (!creating) throw new Error("Expected creating call admission");
    const { runner, close } = await creating.run(async () => ({
      runner: createRunner(),
      close: registerConsultVoiceSession(),
    }));
    creating.release();
    try {
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      markGatewayRestartDraining();
      await expect(runner.runPrompt({ prompt: "A question after restart" })).rejects.toThrow(
        /restarting/,
      );
      expect(mocks.consultRealtimeVoiceAgent).not.toHaveBeenCalled();
      expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(1);
    } finally {
      close();
    }
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("does not let a stale runner adopt a replacement call's root", async () => {
    const original = tryBeginGatewayRootWorkAdmission("talk-original-fixture");
    if (!original) throw new Error("Expected original call admission");
    const prior = await original.run(async () => ({
      runner: createRunner(),
      close: registerConsultVoiceSession(),
    }));
    original.release();
    prior.close();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    const replacement = tryBeginGatewayRootWorkAdmission("talk-replacement-fixture");
    if (!replacement) throw new Error("Expected replacement call admission");
    const current = await replacement.run(async () => ({
      runner: createRunner(),
      close: registerConsultVoiceSession(),
    }));
    replacement.release();
    try {
      await expect(prior.runner.runPrompt({ prompt: "Stale callback" })).rejects.toThrow(
        /continuation is no longer active/,
      );
      expect(mocks.consultRealtimeVoiceAgent).not.toHaveBeenCalled();
      expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      await expect(current.runner.runPrompt({ prompt: "Current call" })).resolves.toEqual({
        text: "done",
      });
      expect(getActiveGatewayRootWorkCount()).toBe(1);
    } finally {
      current.close();
    }
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });
}
