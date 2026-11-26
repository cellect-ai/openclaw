// Registered RPC boundary: suspension preserves a live call, not a generic bypass.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  armGatewaySuspendHandoff,
  prepareGatewaySuspend,
  resetGatewaySuspendCoordinatorForLifecycleRestart,
} from "../infra/gateway-suspend-coordinator.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { dispatchSuspensionRequest as dispatch } from "./server-methods.suspension-admission.test-support.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { talkSessionHandlers } from "./talk/handlers/session.js";
import {
  createTalkRealtimeRelaySession,
  stopTalkRealtimeRelaySession,
} from "./talk/relay/index.js";
import { createIdleRelayProvider, makeRelayTransport } from "./talk/relay/index.test-support.js";
import { rememberUnifiedTalkSession } from "./talk/session-registry.js";
import { prepareTalkSessionTarget } from "./talk/session-target.js";
import {
  createTalkTranscriptionRelaySession,
  stopTalkTranscriptionRelaySession,
} from "./talk/transcription-relay.js";

let testState: OpenClawTestState;
beforeEach(async () => {
  testState = await createOpenClawTestState({
    label: "suspension-voice",
    scenario: "minimal",
    applyEnv: true,
  });
});
afterEach(async () => {
  try {
    await testState.cleanup();
  } finally {
    resetGatewaySuspendCoordinatorForLifecycleRestart();
    resetGatewayWorkAdmission();
  }
});

function prepareVoiceSuspension(requestId: string) {
  const lease = prepareGatewaySuspend({
    requestId,
    drain: true,
    pauseScheduling: () => {},
    resumeScheduling: () => {},
    inspect: { getTerminalPersistence: () => 0 },
  });
  // Native READY certifies write custody, while requireIdle separately guards
  // noninterrupting stop. Keep real root inspectors; never fabricate idle work.
  expect(lease).toMatchObject({
    status: "ready",
    blockers: expect.arrayContaining([expect.objectContaining({ kind: "root-request", count: 1 })]),
  });
  if (lease.status !== "ready") throw new Error("Expected native write-drain readiness");
  const owner = { isCurrent: () => true, commitStop: vi.fn() };
  return {
    expectStopBlocked() {
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      expect(
        armGatewaySuspendHandoff({
          suspensionId: lease.suspensionId,
          owner,
          requireIdle: true,
          commit: true,
        }),
      ).toMatchObject({
        ok: true,
        value: { status: "busy", reason: "active-work", suspensionId: lease.suspensionId },
      });
      expect(owner.commitStop).not.toHaveBeenCalled();
    },
    expectCanArmAfterRelease() {
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(
        armGatewaySuspendHandoff({ suspensionId: lease.suspensionId, owner, requireIdle: true }),
      ).toMatchObject({ ok: true, value: { status: "armed", suspensionId: lease.suspensionId } });
      expect(owner.commitStop).not.toHaveBeenCalled();
    },
  };
}

it("keeps registered audio and close usable while rejecting new calls and foreign call ids", async () => {
  const creating = tryBeginGatewayRootWorkAdmission("ws:talk.session.create")!;
  const transport = makeRelayTransport();
  const target = await creating.run(() =>
    prepareTalkSessionTarget({ agents: { entries: { main: {} } } }, "agent:main:main"),
  );
  const context = {
    broadcastToConnIds: vi.fn(),
    logGateway: { warn: vi.fn() },
    getRuntimeConfig: () => ({ agents: { entries: { main: {} } } }),
  } as unknown as GatewayRequestContext;
  const session = await creating.run(async () =>
    createTalkRealtimeRelaySession({
      context,
      connId: "conn-suspend-proof",
      provider: createIdleRelayProvider(() => transport),
      providerConfig: {},
      instructions: "fixture",
      tools: [],
      controlSource: "transcript",
      sessionTarget: target,
    }),
  );
  rememberUnifiedTalkSession(session.relaySessionId, {
    kind: "realtime-relay",
    connId: "conn-suspend-proof",
    relaySessionId: session.relaySessionId,
    sessionTarget: target,
  });
  creating.release();
  try {
    const suspension = prepareVoiceSuspension("voice-deploy");
    suspension.expectStopBlocked();
    const rpc = async (method: keyof typeof talkSessionHandlers, requestParams: unknown) => {
      const result = dispatch({
        method,
        requestParams,
        handler: talkSessionHandlers[method]!,
        scope: "operator.write",
        core: true,
        context,
      });
      await result.request;
      return result.respond;
    };
    expect(
      await rpc("talk.session.appendAudio", {
        sessionId: session.relaySessionId,
        audioBase64: "AAA=",
      }),
    ).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(transport.sendAudio).toHaveBeenCalledOnce();
    expect(
      await rpc("talk.session.appendAudio", { sessionId: "another-call", audioBase64: "AAA=" }),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "UNAVAILABLE" }));
    expect(
      await rpc("talk.session.create", {
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
      }),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "UNAVAILABLE" }));
    expect(
      await rpc("talk.session.close", { sessionId: session.relaySessionId }),
    ).toHaveBeenCalledWith(true, { ok: true }, undefined);
    suspension.expectCanArmAfterRelease();
  } finally {
    try {
      await stopTalkRealtimeRelaySession({
        relaySessionId: session.relaySessionId,
        connId: "conn-suspend-proof",
      });
    } catch {
      // The registered close above already retired this exact call.
    }
  }
});

it("keeps registered transcription audio live and blocks stop until provider finals drain", async () => {
  vi.useFakeTimers();
  const creating = tryBeginGatewayRootWorkAdmission("ws:talk.session.create")!;
  const stt = {
    connect: vi.fn(async () => {}),
    sendAudio: vi.fn(),
    close: vi.fn(),
    isConnected: () => true,
  };
  const context = {
    broadcastToConnIds: vi.fn(),
    getRuntimeConfig: () => ({}),
    logGateway: { warn: vi.fn() },
  } as unknown as GatewayRequestContext;
  const session = await creating.run(async () =>
    createTalkTranscriptionRelaySession({
      context,
      connId: "conn-suspend-proof",
      assertCurrent: () => {},
      providerConfig: {},
      provider: {
        id: "transcription-fixture",
        label: "Fixture",
        isConfigured: () => true,
        createSession: () => stt,
      },
    }),
  );
  // Registration occurs under the creating RPC in production.
  await creating.run(async () =>
    rememberUnifiedTalkSession(session.transcriptionSessionId, {
      kind: "transcription-relay",
      connId: "conn-suspend-proof",
      transcriptionSessionId: session.transcriptionSessionId,
    }),
  );
  creating.release();
  try {
    const suspension = prepareVoiceSuspension("transcription-release");
    suspension.expectStopBlocked();
    const rpc = async (method: keyof typeof talkSessionHandlers, requestParams: unknown) => {
      const result = dispatch({
        method,
        requestParams,
        handler: talkSessionHandlers[method]!,
        scope: "operator.write",
        core: true,
        context,
      });
      await result.request;
      return result.respond;
    };
    expect(
      await rpc("talk.session.appendAudio", {
        sessionId: session.transcriptionSessionId,
        audioBase64: "AA==",
      }),
    ).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(stt.sendAudio).toHaveBeenCalledOnce();
    expect(
      await rpc("talk.session.close", { sessionId: session.transcriptionSessionId }),
    ).toHaveBeenCalledWith(true, { ok: true }, undefined);
    suspension.expectStopBlocked();
    await vi.advanceTimersByTimeAsync(5_000);
    suspension.expectCanArmAfterRelease();
  } finally {
    try {
      stopTalkTranscriptionRelaySession({
        transcriptionSessionId: session.transcriptionSessionId,
        connId: "conn-suspend-proof",
      });
    } catch {}
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();
  }
});
