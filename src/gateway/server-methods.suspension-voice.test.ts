// Registered RPC boundary: suspension preserves a live call, not a generic bypass.
import { afterEach, expect, it, vi } from "vitest";
import {
  prepareGatewaySuspend,
  resetGatewaySuspendCoordinatorForLifecycleRestart,
} from "../infra/gateway-suspend-coordinator.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { dispatchSuspensionRequest as dispatch } from "./server-methods.suspension-admission.test-support.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { talkSessionHandlers } from "./talk/handlers/session.js";
import {
  createTalkRealtimeRelaySession,
  stopTalkRealtimeRelaySession,
} from "./talk/relay/index.js";
import { createIdleRelayProvider, makeRelayTransport } from "./talk/relay/index.test-support.js";
import { rememberUnifiedTalkSession } from "./talk/session-registry.js";
import {
  createTalkTranscriptionRelaySession,
  stopTalkTranscriptionRelaySession,
} from "./talk/transcription-relay.js";

afterEach(() => {
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
});

it("keeps registered audio and close usable while rejecting new calls and foreign call ids", async () => {
  const creating = tryBeginGatewayRootWorkAdmission("ws:talk.session.create")!;
  const transport = makeRelayTransport();
  const target = {
    agentId: "main",
    sessionKey: "agent:main:main",
    canonicalKey: "agent:main:main",
    storePath: "/fixture/sessions",
  };
  const context = {
    broadcastToConnIds: vi.fn(),
    logGateway: { warn: vi.fn() },
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
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
  const lease = prepareGatewaySuspend({
    requestId: "voice-deploy",
    drain: true,
    pauseScheduling: () => {},
    resumeScheduling: () => {},
    inspect: { getTerminalPersistence: () => 0 },
  });
  expect(lease.status).toBe("draining");
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
  try {
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
    expect(getActiveGatewayRootWorkCount()).toBe(0);
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
  expect(
    prepareGatewaySuspend({
      requestId: "transcription-release",
      drain: true,
      pauseScheduling: () => {},
      resumeScheduling: () => {},
      inspect: { getTerminalPersistence: () => 0 },
    }).status,
  ).toBe("draining");
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
  try {
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
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
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
