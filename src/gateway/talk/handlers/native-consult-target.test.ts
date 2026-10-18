import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../../../agents/embedded-agent-runner/run/params.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../../agents/embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "../../../agents/embedded-agent-runner/runs.test-support.js";
import { REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS } from "../../../agents/realtime-bootstrap-context.test-support.js";
import { replyRunRegistry } from "../../../auto-reply/reply/reply-run-registry.js";
import { createGatewayHostLifecycle } from "../../../cli/gateway-cli/host-lifecycle.js";
import {
  listSessionEntriesReadOnly,
  loadSessionEntry,
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { emitTrustedDiagnosticEvent } from "../../../infra/diagnostic-events.js";
import {
  prepareGatewaySuspend,
  getGatewaySuspendStatus,
  resetGatewaySuspendCoordinatorForLifecycleRestart,
} from "../../../infra/gateway-suspend-coordinator.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { controlRealtimeVoiceAgentRun } from "../../../talk/agent-run-control.js";
import {
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
  resolveClientVoiceRunBinding,
} from "../../../talk/client-voice-session.js";
import * as voiceSessionWrites from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import type {
  RealtimeVoiceAgentConsultRunner,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceGatewayControl,
  RealtimeVoiceProviderCapabilities,
} from "../../../talk/provider-types.js";
import { makeBridge } from "../../../talk/session-runtime.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "../../chat-abort.js";
import { getGatewayProcessInstanceId } from "../../process-instance.js";
import { handleGatewayRequest } from "../../server-methods.js";
import { suspendHandlers } from "../../server-methods/suspend.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "../../server-methods/types.js";
import { resolveSessionMutationAuthorization } from "../../session-sharing.js";
import { sharingPolicyClient } from "../../session-sharing.test-utils.js";
import { closeTalkClientGatewayControlSession } from "../client-gateway-control.js";
import { drainingRelaySessions, relaySessions } from "../relay/state.js";
import { resolveOwnedActiveTalkRunTarget } from "../run-ownership.js";
import {
  cleanupTalkConnection,
  getUnifiedTalkSession,
  rememberUnifiedTalkSession,
} from "../session-registry.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import {
  completeTalkVoiceChange,
  requestTalkVoiceChange,
  resolveTalkVoiceSession,
  unregisterTalkVoiceSession,
} from "../voice-selection.js";
import { talkClientHandlers } from "./client.js";
import { talkSessionHandlers } from "./session.js";

const mocks = vi.hoisted(() => ({
  capabilities: {
    transports: ["webrtc", "gateway-relay"],
    inputAudioFormats: [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }],
    outputAudioFormats: [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }],
    supportsToolCalls: false,
  } satisfies RealtimeVoiceProviderCapabilities,
  resolveProvider: vi.fn(),
  closeProvider: vi.fn(async () => undefined),
  runEmbeddedAgent: vi.fn(async (_params: RunEmbeddedAgentParams) => ({
    payloads: [{ text: "Synthetic consult answer" }],
    meta: { durationMs: 0 },
  })),
}));

vi.mock("../../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: mocks.runEmbeddedAgent }));
vi.mock("../../../agents/bootstrap-files.js", () => ({
  resolveBootstrapFilesForRun: async () => [],
}));
vi.mock("../../../talk/provider-resolver.js", () => ({
  resolveConfiguredRealtimeVoiceProvider: mocks.resolveProvider,
}));
vi.mock("../../../talk/provider-registry.js", () => ({ listRealtimeVoiceProviders: () => [] }));

let state: OpenClawTestState;
let config: OpenClawConfig;
let client: ReturnType<typeof sharingPolicyClient> & { connId: string };
let callback: RealtimeVoiceAgentConsultRunner | undefined;
let providerInstructions: string | undefined;
const browserVoiceSessionIds = new Set<string>();
let browserControl: RealtimeVoiceGatewayControl | undefined;
const submitProviderResult = vi.fn();
const context = {
  getRuntimeConfig: () => config,
  getClientConnIds: () => new Set([client.connId]),
  chatAbortControllers: new Map(),
  broadcastToConnIds: vi.fn(),
  logGateway: { warn: vi.fn() },
} as unknown as GatewayRequestContext;

async function dispatch(
  method: string,
  params: Record<string, unknown>,
  handlers: GatewayRequestHandlers = {},
) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: "native-consult", method, params },
    client,
    context,
    isWebchatConnect: () => false,
    respond,
    extraHandlers: { ...talkClientHandlers, ...talkSessionHandlers, ...handlers },
  });
  const payload = respond.mock.calls.at(-1)?.[1];
  if (
    method === "talk.client.create" &&
    isRecord(payload) &&
    typeof payload.voiceSessionId === "string"
  ) {
    browserVoiceSessionIds.add(payload.voiceSessionId);
  }
  return respond;
}

beforeEach(async () => {
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
  state = await createOpenClawTestState({ label: "talk-native-consult" });
  config = {
    agents: {
      ownership: "explicit",
      entries: { primary: {}, voice: { workspace: state.workspaceDir } },
    },
    talk: { agentId: "voice" },
  };
  client = {
    ...sharingPolicyClient({ user: ensureProfileForEmail("native-listener@example.test").id }),
    connId: "native-consult-client",
  };
  callback = undefined;
  providerInstructions = undefined;
  browserVoiceSessionIds.clear();
  browserControl = undefined;
  vi.clearAllMocks();
  mocks.closeProvider.mockReset().mockResolvedValue(undefined);
  mocks.runEmbeddedAgent.mockReset().mockResolvedValue({
    payloads: [{ text: "Synthetic consult answer" }],
    meta: { durationMs: 0 },
  });
  context.chatAbortControllers.clear();
  setActivePluginRegistry(createEmptyPluginRegistry());
  const provider: RealtimeVoiceProviderPlugin = {
    id: "synthetic-voice",
    label: "Synthetic voice",
    capabilities: mocks.capabilities,
    isConfigured: () => true,
    createBrowserSession: async (request) => {
      providerInstructions = request.instructions;
      callback = request.runAgentConsult;
      browserControl = request.gatewayControl;
      browserControl?.bindBridge({
        connect: async () => undefined,
        sendAudio: () => undefined,
        setMediaTimestamp: () => undefined,
        handleBargeIn: () => undefined,
        submitToolResult: submitProviderResult,
        acknowledgeMark: () => undefined,
        close: mocks.closeProvider,
        isConnected: () => true,
      });
      return {
        provider: "synthetic-voice",
        transport: "webrtc",
        clientSecret: "synthetic-offer",
        offerUrl: "/test/offer",
      };
    },
    createBridge: (request) => {
      providerInstructions = request.instructions;
      callback = request.runAgentConsult;
      return {
        connect: async () => undefined,
        sendAudio: () => undefined,
        setMediaTimestamp: () => undefined,
        handleBargeIn: () => undefined,
        submitToolResult: () => undefined,
        acknowledgeMark: () => undefined,
        close: mocks.closeProvider,
        isConnected: () => true,
      };
    },
  };
  Object.defineProperty(provider, Symbol.for("openclaw.internal.realtime-voice-provider.v1"), {
    value: { isBrowserSessionConfigured: () => true, cancelBrowserSession: mocks.closeProvider },
  });
  mocks.resolveProvider.mockReturnValue({
    provider,
    providerConfig: {},
    capabilities: {
      ...mocks.capabilities,
      supportsGatewayControl: true,
      handlesAgentConsult: true,
    },
  });
});

afterEach(async () => {
  try {
    for (const browserVoiceSessionId of browserVoiceSessionIds) {
      await closeTalkClientGatewayControlSession({
        voiceSessionId: browserVoiceSessionId,
        sessionKey: "main",
        connId: client.connId,
      });
    }
    cleanupTalkConnection(client.connId, context.logGateway);
    await Promise.all(
      [...drainingRelaySessions].map(
        (session) => session.closing?.completion ?? session.voiceSessionClose ?? Promise.resolve(),
      ),
    );
  } finally {
    resetGatewaySuspendCoordinatorForLifecycleRestart();
    resetGatewayWorkAdmission();
    clientVoiceSessionTesting.reset();
    embeddedRunTesting.resetActiveEmbeddedRuns();
    setActivePluginRegistry(createEmptyPluginRegistry());
    await state.cleanup();
  }
});

async function createRelayCall(params: Record<string, unknown> = {}) {
  const respond = await dispatch("talk.session.create", {
    sessionKey: "main",
    mode: "realtime",
    transport: "gateway-relay",
    brain: "agent-consult",
    ...params,
  });
  expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
  const sessionId = (respond.mock.calls[0]![1] as { sessionId: string }).sessionId;
  const record = getUnifiedTalkSession(sessionId);
  if (record.kind !== "realtime-relay") {
    throw new Error("Expected realtime relay");
  }
  return { sessionId, target: record.sessionTarget };
}

it.each([undefined, "main"])(
  "retains the opaque relay owner when Talk defaults change (key=%s)",
  async (sessionKey) => {
    config.session = { scope: "global" };
    const { sessionId } = await createRelayCall();
    expect(providerInstructions).toBe(REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS);
    await replaceSessionEntry(
      { agentId: "primary", sessionKey: "global" },
      {
        sessionId: "private-primary",
        updatedAt: 1,
        visibility: "draft",
        createdActor: { type: "human", source: "profile", id: "another-person" },
      },
    );
    config = { ...config, talk: { agentId: "primary" } };
    expect(
      await dispatch("talk.session.steer", {
        sessionId,
        ...(sessionKey ? { sessionKey } : {}),
        text: "status",
        mode: "status",
      }),
    ).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ mode: "status", sessionKey: "global" }),
      undefined,
    );
  },
);

it.each([undefined, "main"])(
  "enforces the retained relay's sharing policy (key=%s)",
  async (sessionKey) => {
    await replaceSessionEntry(
      { agentId: "voice", sessionKey: "agent:voice:main" },
      {
        sessionId: "shared-before-call",
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: "another-person" },
      },
    );
    const { sessionId, target } = await createRelayCall();
    const scope = {
      agentId: target.agentId,
      sessionKey: target.canonicalKey,
      storePath: target.storePath,
    };
    await replaceSessionEntry(scope, {
      ...loadSessionEntry(scope)!,
      visibility: "read-only",
    });
    expect(
      await dispatch("talk.session.steer", {
        sessionId,
        ...(sessionKey ? { sessionKey } : {}),
        text: "status",
        mode: "status",
      }),
    ).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        details: expect.objectContaining({ code: "SESSION_PARTICIPATION_REQUIRED" }),
      }),
    );
  },
);

it("rejects retained relay mapping changes even when the physical store is unchanged", async () => {
  const { sessionId } = await createRelayCall();
  config = { ...config, session: { mainKey: "home" } };
  expect(
    await dispatch("talk.session.steer", { sessionId, text: "status", mode: "status" }),
  ).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("non-canonical persisted row"),
    }),
  );
});

it.each([false, true])(
  "fences an opaque relay record replaced after awaited authorization (draining=%s)",
  async (draining) => {
    const { sessionId } = await createRelayCall();
    if (draining) {
      expect(
        prepareGatewaySuspend({
          requestId: "stale-call-deploy",
          drain: true,
          pauseScheduling: () => {},
          resumeScheduling: () => {},
          inspect: { getTerminalPersistence: () => 0 },
        }).status,
      ).toBe("draining");
    }
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const pending = dispatch(
      "talk.session.steer",
      { sessionId, text: "status", mode: "status" },
      {
        "talk.session.steer": async (request) => {
          entered.resolve();
          await release.promise;
          await talkSessionHandlers["talk.session.steer"]!(request);
        },
      },
    );
    await entered.promise;
    rememberUnifiedTalkSession(sessionId, { ...getUnifiedTalkSession(sessionId) });
    release.resolve();
    expect(await pending).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        details: expect.objectContaining({ code: "SESSION_MUTATION_AUTHORIZATION_CHANGED" }),
      }),
    );
  },
);

function registerOwnedEmbeddedRun(runId: string, sessionId: string) {
  const registration = registerChatAbortController({
    chatAbortControllers: context.chatAbortControllers,
    runId,
    sessionId,
    sessionKey: "global",
    agentId: "voice",
    ownerConnId: client.connId,
    timeoutMs: 60_000,
    kind: "chat-send",
  });
  const abort = vi.fn();
  setActiveEmbeddedRun(
    sessionId,
    {
      runId,
      queueMessage: async () => undefined,
      isStreaming: () => true,
      isCompacting: () => false,
      abort,
    },
    "global",
  );
  return { registration, abort };
}

it("rechecks RPC sharing authorization after the control runtime import", async () => {
  config.session = { scope: "global" };
  const target = prepareTalkSessionTarget(config, "main");
  const scope = { agentId: "voice", sessionKey: "global", storePath: target.storePath };
  await replaceSessionEntry(scope, {
    sessionId: "acl-session",
    updatedAt: 1,
    visibility: "shared",
  });
  const { registration, abort } = registerOwnedEmbeddedRun("acl-run", "acl-session");
  const authorization = resolveSessionMutationAuthorization({
    client,
    method: "talk.client.steer",
    requestParams: { sessionKey: "main" },
    context,
  });
  expect(authorization.error).toBeNull();
  const runTarget = resolveOwnedActiveTalkRunTarget({
    context,
    clientConnId: client.connId,
    sessionTarget: target,
    scope: { kind: "session" },
    assertCurrent: authorization.authorization!.assertCurrent,
  });
  const pending = controlRealtimeVoiceAgentRun({
    sessionKey: "global",
    runTarget,
    text: "cancel",
    mode: "cancel",
  });
  replaceSessionEntrySync(scope, {
    sessionId: "acl-session",
    updatedAt: 2,
    visibility: "read-only",
    createdActor: { type: "human", source: "profile", id: "another-person" },
  });
  try {
    await expect(pending).rejects.toMatchObject({
      error: expect.objectContaining({
        details: expect.objectContaining({ code: "SESSION_PARTICIPATION_REQUIRED" }),
      }),
    });
    expect(abort).not.toHaveBeenCalled();
  } finally {
    registration.cleanup();
  }
});

it.each([
  "replaced",
  "agent",
  "key",
  "connection",
  "signal",
  "generation",
  "cleanup",
  "voice binding removed",
  "voice binding replaced",
] as const)("fences %s Gateway registration while exact control loads", async (change) => {
  config.session = { scope: "global" };
  const target = prepareTalkSessionTarget(config, "main");
  const runId = "captured-run";
  const voiceScope = { agentId: target.agentId, sessionKey: target.sessionKey };
  const voiceSessionId = createOrResumeClientVoiceSession({ ...voiceScope, origin: "client" });
  registerClientVoiceConsultRun({ ...voiceScope, voiceSessionId, runId });
  const { registration, abort } = registerOwnedEmbeddedRun(runId, "captured-session");
  const runTarget = resolveOwnedActiveTalkRunTarget({
    context,
    clientConnId: client.connId,
    sessionTarget: target,
    scope: { kind: "voice-session", voiceSessionId },
  });
  expect(runTarget?.isCurrent()).toBe(true);
  const control = controlRealtimeVoiceAgentRun({
    sessionKey: "global",
    runTarget,
    text: "cancel",
    mode: "cancel",
  });
  const entry = context.chatAbortControllers.get(runId)!;
  if (change === "replaced") {
    context.chatAbortControllers.set(runId, { ...entry });
  } else if (change === "agent") {
    entry.agentId = "primary";
  } else if (change === "key") {
    entry.sessionKey = "agent:voice:another";
  } else if (change === "connection") {
    entry.ownerConnId = "another-client";
  } else if (change === "generation") {
    entry.lifecycleGeneration = "retired";
  } else if (change === "cleanup") {
    entry.registrationCleanupRequested = true;
  } else if (change === "voice binding removed") {
    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId,
      durationMs: 0,
      outcome: "completed",
    });
    expect(resolveClientVoiceRunBinding(runId)).toBeUndefined();
  } else if (change === "voice binding replaced") {
    const replacementVoiceSessionId = createOrResumeClientVoiceSession({
      ...voiceScope,
      origin: "client",
    });
    registerClientVoiceConsultRun({
      ...voiceScope,
      voiceSessionId: replacementVoiceSessionId,
      runId,
    });
  } else {
    entry.controller = new AbortController();
  }
  try {
    expect(await control).toMatchObject({ ok: false, active: false, reason: "no_active_run" });
    expect(abort).not.toHaveBeenCalled();
  } finally {
    registration.cleanup();
  }
});

it("preserves status and cancellation for an owned queued chat.send reply", async () => {
  config.session = { scope: "global" };
  const respond = await dispatch("talk.client.create", {
    sessionKey: "main",
    mode: "realtime",
    transport: "webrtc",
    brain: "agent-consult",
    capabilities: ["gateway-control-v1"],
  });
  expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
  const sessionId = loadSessionEntry({ agentId: "voice", sessionKey: "global" })!.sessionId;
  const registration = registerChatAbortController({
    chatAbortControllers: context.chatAbortControllers,
    runId: "queued-talk",
    sessionId,
    sessionKey: "global",
    agentId: "voice",
    ownerConnId: client.connId,
    timeoutMs: 60_000,
    kind: "chat-send",
  });
  const operation = replyRunRegistry.begin({
    sessionKey: "global",
    sessionId,
    resetTriggered: false,
    upstreamAbortSignal: registration.controller.signal,
  });
  const runTarget = resolveOwnedActiveTalkRunTarget({
    context,
    clientConnId: client.connId,
    sessionTarget: prepareTalkSessionTarget(config, "main"),
    scope: { kind: "session" },
  });
  const resolvedSessionId = "materialized-reply-session";
  context.chatAbortControllers.get("queued-talk")!.sessionId = resolvedSessionId;
  operation.updateSessionId(resolvedSessionId);
  const voiceSessionId = (respond.mock.calls[0]![1] as { voiceSessionId: string }).voiceSessionId;
  registerClientVoiceConsultRun({
    agentId: "voice",
    sessionKey: "main",
    voiceSessionId,
    runId: "queued-talk",
  });
  const voiceTarget = resolveOwnedActiveTalkRunTarget({
    context,
    clientConnId: client.connId,
    sessionTarget: prepareTalkSessionTarget(config, "main"),
    scope: { kind: "voice-session", voiceSessionId },
  });
  try {
    expect(voiceTarget?.isCurrent()).toBe(true);
    expect(
      await controlRealtimeVoiceAgentRun({
        sessionKey: "global",
        runTarget: voiceTarget,
        text: "status",
      }),
    ).toMatchObject({ active: false });
    expect(
      await controlRealtimeVoiceAgentRun({
        sessionKey: "global",
        runTarget,
        text: "status",
        mode: "status",
      }),
    ).toMatchObject({ active: true, sessionId: resolvedSessionId });
    expect(
      await dispatch("talk.client.steer", { sessionKey: "main", text: "status", mode: "status" }),
    ).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ active: true, sessionId: resolvedSessionId }),
      undefined,
    );
    const abortUnrelated = vi.fn();
    const unrelated = {
      runId: "queued-talk",
      queueMessage: async () => undefined,
      isStreaming: () => true,
      isCompacting: () => false,
      abort: abortUnrelated,
    };
    setActiveEmbeddedRun(resolvedSessionId, unrelated, "global");
    try {
      expect(
        await controlRealtimeVoiceAgentRun({ sessionKey: "global", runTarget, text: "cancel" }),
      ).toMatchObject({ active: false, aborted: false });
      expect(abortUnrelated).not.toHaveBeenCalled();
    } finally {
      clearActiveEmbeddedRun(resolvedSessionId, unrelated, "global");
    }
    expect(
      await dispatch("talk.client.steer", { sessionKey: "main", text: "cancel", mode: "cancel" }),
    ).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, aborted: true, sessionId: resolvedSessionId }),
      undefined,
    );
    expect(operation.abortSignal.aborted).toBe(true);
    expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
    expect(runTarget?.isCurrent()).toBe(false);
    operation.complete();
    const successor = replyRunRegistry.begin({
      sessionKey: "global",
      sessionId: resolvedSessionId,
      resetTriggered: false,
      upstreamAbortSignal: registration.controller.signal,
    });
    try {
      expect(
        await controlRealtimeVoiceAgentRun({ sessionKey: "global", runTarget, text: "cancel" }),
      ).toMatchObject({ active: false, aborted: false });
      expect(successor.abortSignal.aborted).toBe(false);
    } finally {
      successor.complete();
    }
  } finally {
    operation.complete();
    registration.cleanup();
  }
});

it("restores bounded relay history after the original voice provider finishes closing", async () => {
  const configuredInstructions = "Keep native answers brief.";
  config.talk = { ...config.talk, realtime: { instructions: configuredInstructions } };
  const closeStarted = createDeferredCore();
  const finishClose = createDeferredCore();
  const requests: RealtimeVoiceBridgeCreateRequest[] = [];
  const tailUser = "The final preference is the blue bicycle.";
  const tailAssistant = "I will remember the blue bicycle.";
  const provider: RealtimeVoiceProviderPlugin = {
    id: "synthetic-voice",
    label: "Synthetic voice",
    voices: ["cove", "ember"],
    capabilities: mocks.capabilities,
    isConfigured: () => true,
    createBridge: (request) => {
      requests.push(request);
      const original = requests.length === 1;
      return makeBridge({
        close: async () => {
          if (original) {
            closeStarted.resolve();
            await finishClose.promise;
            request.onTranscript?.("user", tailUser, true);
            request.onTranscript?.("assistant", tailAssistant, true);
          }
        },
      });
    },
  };
  mocks.resolveProvider.mockReturnValue({
    provider,
    providerConfig: {},
    capabilities: { ...mocks.capabilities, handlesAgentConsult: true },
  });
  const original = await createRelayCall({ voice: "cove", capabilities: ["voice-selection"] });
  const originalRequest = requests[0];
  if (!originalRequest) {
    throw new Error("Expected original relay provider");
  }
  originalRequest.onReady?.();
  const utterances = Array.from(
    { length: 20 },
    (_, index) =>
      `HISTORY_ENTRY_${String(index).padStart(2, "0")}: ${`detail-${index} `.repeat(120)}`,
  );
  for (const text of utterances) {
    originalRequest.onTranscript?.("user", text, true);
  }
  const send = vi.fn();
  const changing = requestTalkVoiceChange({
    session: resolveTalkVoiceSession({
      kind: "client",
      connId: client.connId,
      voiceSessionId: original.sessionId,
    }),
    voice: "ember",
    requesterConnId: client.connId,
    assertCurrent: () => {},
    send,
  });
  void changing.catch(() => {});
  const changeId = send.mock.calls[0]?.[0].changeId as string;
  const closing = dispatch("talk.session.close", { sessionId: original.sessionId });
  try {
    await closeStarted.promise;
    expect(requests).toHaveLength(1);
    finishClose.resolve();
    expect(await closing).toHaveBeenCalledWith(true, { ok: true }, undefined);

    const storedSessionId = loadSessionEntry({
      agentId: original.target.agentId,
      sessionKey: original.target.canonicalKey,
      storePath: original.target.storePath,
    })!.sessionId;
    const transcript = readSessionTranscriptMessageEvents({
      agentId: original.target.agentId,
      sessionId: storedSessionId,
      storePath: original.target.storePath,
    });
    expect(transcript).toHaveLength(22);
    expect(transcript[0]?.event).toMatchObject({
      message: { content: [{ type: "text", text: utterances[0]?.trim() }] },
    });
    expect(transcript.slice(-2).map(({ event }) => event)).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          role: "user",
          content: [{ type: "text", text: tailUser }],
        }),
      }),
      expect.objectContaining({
        message: expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: tailAssistant }],
        }),
      }),
    ]);

    const replacement = await createRelayCall({
      voiceChangeId: changeId,
      capabilities: ["voice-selection"],
    });
    const replacementRequest = requests[1];
    if (!replacementRequest?.runAgentConsult) {
      throw new Error("Expected replacement relay provider and consult callback");
    }
    replacementRequest.onReady?.();
    await completeTalkVoiceChange({
      changeId,
      connId: client.connId,
      voiceSessionId: replacement.sessionId,
      outcome: "ready",
    });
    await expect(changing).resolves.toMatchObject({ status: "applied", voice: "ember" });

    const instructions = replacementRequest.instructions ?? "";
    expect(instructions).toContain(configuredInstructions);
    expect(instructions).toContain(tailUser);
    expect(instructions).toContain(tailAssistant);
    expect(instructions).toContain("HISTORY_ENTRY_19");
    expect(instructions).not.toContain("HISTORY_ENTRY_00");
    expect([...instructions.matchAll(/HISTORY_ENTRY_\d{2}/gu)].length).toBeLessThanOrEqual(16);
    expect(
      Buffer.byteLength(
        instructions.slice(
          configuredInstructions.length + 2 + REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS.length,
        ),
        "utf8",
      ),
    ).toBeLessThanOrEqual(8_000);

    await expect(
      replacementRequest.runAgentConsult({ prompt: "What bicycle did I choose?" }),
    ).resolves.toEqual({ text: "Synthetic consult answer" });
    const agentPrompt = mocks.runEmbeddedAgent.mock.calls.at(-1)?.[0].prompt ?? "";
    expect(agentPrompt).toContain(tailUser);
    expect(agentPrompt).toContain(tailAssistant);
    expect(agentPrompt).toContain("HISTORY_ENTRY_19");
    expect(agentPrompt).not.toContain("HISTORY_ENTRY_00");
  } finally {
    finishClose.resolve();
    await closing;
    cleanupTalkConnection(client.connId, context.logGateway);
    await changing.catch(() => {});
  }
});

describe.each(["browser", "relay"] as const)("native %s Talk consultation", (transport) => {
  it.each(["provider", "transcript"] as const)(
    "keeps rootless disconnect %s finalization in native drain custody after presentation ownership is retired",
    async (blocked) => {
      const browser = transport === "browser";
      const created = await dispatch(browser ? "talk.client.create" : "talk.session.create", {
        sessionKey: "main",
        mode: "realtime",
        transport: browser ? "webrtc" : "gateway-relay",
        brain: "agent-consult",
        ...(browser ? { capabilities: ["gateway-control-v1"] } : {}),
      });
      expect(created).toHaveBeenCalledWith(true, expect.any(Object), undefined);
      const call = created.mock.calls[0]?.[1] as { voiceSessionId: string; sessionId: string };
      const closeStarted = createDeferredCore();
      const finishClose = createDeferredCore();
      const waitForFinalization = async () => {
        closeStarted.resolve();
        await finishClose.promise;
      };
      let restoreFlush = () => {};
      if (blocked === "provider") {
        mocks.closeProvider.mockImplementation(waitForFinalization);
      } else if (browser) {
        const flush = voiceSessionWrites.flushClientVoiceSessionWrites;
        const spy = vi
          .spyOn(voiceSessionWrites, "flushClientVoiceSessionWrites")
          .mockImplementation(async (params) => {
            await waitForFinalization();
            await flush(params);
          });
        restoreFlush = () => {
          spy.mockRestore();
        };
      } else {
        const queue = relaySessions.get(call.sessionId)!.voiceTranscriptQueue;
        const flush = queue.flush.bind(queue);
        const spy = vi.spyOn(queue, "flush").mockImplementation(async (options) => {
          await waitForFinalization();
          await flush(options);
        });
        restoreFlush = () => {
          spy.mockRestore();
        };
      }
      // Socket cleanup can retire the presentation callback before the provider
      // owner sees disconnect. The independent teardown reference must survive it.
      unregisterTalkVoiceSession(call.voiceSessionId ?? call.sessionId, client.connId, "voice");
      cleanupTalkConnection(client.connId, context.logGateway);
      await closeStarted.promise;
      const lease = prepareGatewaySuspend({
        requestId: "disconnect-finalization",
        drain: true,
        pauseScheduling: () => {},
        resumeScheduling: () => {},
        inspect: { getTerminalPersistence: () => 0 },
      });
      if (lease.status !== "draining") {
        throw new Error("Expected provider finalization to block deployment");
      }
      const stop = vi.fn();
      const host = createGatewayHostLifecycle({
        processOwner: { ownsProcessLifecycle: true, supervisor: "external" },
        isCurrent: () => true,
        isServing: () => true,
        acceptStop: () => {},
        commitExternalStop: stop,
      });
      context.hostLifecycle = host.capability;
      const original = client;
      client = { ...client, connect: { ...client.connect, scopes: ["operator.admin"] } };
      try {
        const request = {
          suspensionId: lease.suspensionId,
          commit: true,
          requireIdle: true,
          target: { pid: process.pid, processInstanceId: getGatewayProcessInstanceId() },
        };
        expect(
          await dispatch("gateway.suspend.handoff", request, suspendHandlers),
        ).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "busy", reason: "write-custody" }),
        );
        expect(
          await dispatch(
            "gateway.suspend.handoff",
            { suspensionId: request.suspensionId, commit: true, target: request.target },
            suspendHandlers,
          ),
        ).toHaveBeenCalledWith(false, undefined, expect.any(Object));
        expect(stop).not.toHaveBeenCalled();
        finishClose.resolve();
        if (browser) {
          await closeTalkClientGatewayControlSession({
            voiceSessionId: call.voiceSessionId,
            sessionKey: "main",
            connId: client.connId,
          });
        } else {
          await Promise.all(
            [...drainingRelaySessions].map((session) => session.closing?.completion),
          );
        }
        expect(getGatewaySuspendStatus(lease.suspensionId).status).toBe("ready");
      } finally {
        client = original;
        finishClose.resolve();
        restoreFlush();
        await host.retire();
        delete context.hostLifecycle;
      }
    },
  );
  it("keeps a fresh consult and registered same-call control working during drain without widening connection or scope authority", async () => {
    const browser = transport === "browser";
    const createMethod = browser ? "talk.client.create" : "talk.session.create";
    const created = await dispatch(createMethod, {
      sessionKey: "main",
      mode: "realtime",
      transport: browser ? "webrtc" : "gateway-relay",
      brain: "agent-consult",
      ...(browser ? { capabilities: ["gateway-control-v1"] } : {}),
    });
    expect(created).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    const call = created.mock.calls[0]?.[1] as { voiceSessionId: string; sessionId: string };
    expect(
      prepareGatewaySuspend({
        requestId: "live-call-deploy",
        drain: true,
        pauseScheduling: () => {},
        resumeScheduling: () => {},
        inspect: { getTerminalPersistence: () => 0 },
      }).status,
    ).toBe("draining");
    expect(
      await dispatch(createMethod, {
        sessionKey: "main",
        mode: "realtime",
        transport: browser ? "webrtc" : "gateway-relay",
        brain: "agent-consult",
      }),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "UNAVAILABLE" }));
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    mocks.runEmbeddedAgent.mockImplementationOnce(async (params) => {
      const handle = {
        runId: params.runId,
        queueMessage: async () => undefined,
        isStreaming: () => true,
        isCompacting: () => false,
        abort: () => finish.resolve(),
      };
      setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
      entered.resolve();
      try {
        await finish.promise;
        return { payloads: [{ text: "Completed through drain" }], meta: { durationMs: 0 } };
      } finally {
        clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
      }
    });
    const consult = callback!({ prompt: "A fresh request after draining began" });
    const original = client;
    try {
      await entered.promise;
      const method = browser ? "talk.client.steer" : "talk.session.steer";
      const args = {
        sessionKey: "main",
        ...(browser ? {} : { sessionId: call.sessionId }),
        text: "status",
        mode: "status",
      };
      expect(await dispatch(method, args)).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ active: true }),
        undefined,
      );
      client = { ...client, connId: "foreign-physical-connection" };
      expect(await dispatch(method, args)).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE" }),
      );
      client = { ...original, connect: { ...original.connect, scopes: ["operator.read"] } };
      expect(await dispatch(method, args)).toHaveBeenCalledWith(
        false,
        undefined,
        expect.any(Object),
      );
      client = original;
      finish.resolve();
      await expect(consult).resolves.toEqual({ text: "Completed through drain" });
    } finally {
      client = original;
      finish.resolve();
      await consult.catch(() => undefined);
    }
  });
  it.each([
    { name: "custom main", scope: "per-sender" as const, canonicalKey: "agent:voice:home" },
    { name: "global", scope: "global" as const, canonicalKey: "global" },
  ])("uses the created $name session in the provider callback", async ({ scope, canonicalKey }) => {
    config.session = { mainKey: "home", scope };
    config.talk = { ...config.talk, realtime: { instructions: "Keep native answers brief." } };
    const target = prepareTalkSessionTarget(config, "main");
    const method = transport === "browser" ? "talk.client.create" : "talk.session.create";
    const respond = await dispatch(method, {
      sessionKey: "main",
      mode: "realtime",
      transport: transport === "browser" ? "webrtc" : "gateway-relay",
      brain: "agent-consult",
      ...(transport === "browser" ? { capabilities: ["gateway-control-v1"] } : {}),
    });
    expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    expect(providerInstructions).toBe(
      `Keep native answers brief.\n\n${REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS}`,
    );
    const result = respond.mock.calls[0]?.[1] as { voiceSessionId?: string; sessionId?: string };
    const storage = { agentId: "voice", sessionKey: canonicalKey, storePath: target.storePath };
    const created = loadSessionEntry(storage);
    expect(created?.sessionId).toBeTruthy();
    expect(callback).toBeTypeOf("function");
    await expect(callback!({ prompt: "Continue this conversation" })).resolves.toEqual({
      text: "Synthetic consult answer",
    });
    expect(mocks.runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "voice",
        sessionKey: canonicalKey,
        sessionId: created!.sessionId,
        sessionTarget: { ...storage, sessionId: created!.sessionId },
      }),
    );
    expect(
      listSessionEntriesReadOnly({ agentId: "voice", storePath: target.storePath }).map(
        (entry) => entry.sessionKey,
      ),
    ).toEqual([canonicalKey]);
    expect(
      clientVoiceSessionTesting.readRecord("voice", result.voiceSessionId ?? result.sessionId!)
        ?.sessionKey,
    ).toBe("main");
  });
});

describe.each(["browser-rpc", "browser-provider", "relay"] as const)(
  "native %s exact control",
  (surface) => {
    it.each([
      "foreign global",
      "replaced run",
      "reused run ID",
      "other call",
      ...(surface === "relay" ? [] : ["same call"]),
    ])("keeps %s control within its declared scope", async (replacement) => {
      config.session = { scope: "global" };
      const started = createDeferredCore<RunEmbeddedAgentParams>();
      const finish = createDeferredCore();
      let aborted = false;
      const abortOwned = vi.fn(() => {
        aborted = true;
        finish.resolve();
      });
      const abortOther = vi.fn();
      mocks.runEmbeddedAgent.mockImplementationOnce(async (params) => {
        const handle = {
          runId: params.runId,
          queueMessage: async () => undefined,
          isStreaming: () => true,
          isCompacting: () => false,
          abort: abortOwned,
        };
        setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
        started.resolve(params);
        try {
          await finish.promise;
          return {
            payloads: [{ text: "Synthetic consult answer" }],
            meta: { durationMs: 0, aborted },
          };
        } finally {
          clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
        }
      });
      const browser = surface !== "relay";
      const createMethod = browser ? "talk.client.create" : "talk.session.create";
      const createParams = {
        sessionKey: "main",
        mode: "realtime",
        brain: "agent-consult",
        transport: browser ? "webrtc" : "gateway-relay",
        ...(browser ? { capabilities: ["gateway-control-v1"] } : {}),
      };
      const respond = await dispatch(createMethod, createParams);
      expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
      const result = respond.mock.calls[0]![1] as { voiceSessionId?: string; sessionId?: string };
      let controlSessionId = result.sessionId;
      const cancelsOriginal =
        replacement === "foreign global" ||
        replacement === "same call" ||
        (replacement === "other call" && surface === "browser-rpc");
      const consult = callback!({ prompt: "Keep working" });
      try {
        const active = await Promise.race([
          started.promise,
          consult.then(() => {
            throw new Error("consult ended before model dispatch");
          }),
        ]);
        expect(context.chatAbortControllers.get(active.runId)).toMatchObject({
          agentId: "voice",
          sessionKey: "global",
          sessionId: active.sessionId,
        });
        if (replacement === "other call" || replacement === "same call") {
          const next = await dispatch(createMethod, {
            ...createParams,
            ...(replacement === "same call" ? { voiceSessionId: result.voiceSessionId } : {}),
          });
          expect(next).toHaveBeenCalledWith(true, expect.any(Object), undefined);
          const call = next.mock.calls[0]![1] as { voiceSessionId?: string; sessionId?: string };
          expect(
            (call.voiceSessionId ?? call.sessionId) === (result.voiceSessionId ?? result.sessionId),
          ).toBe(replacement === "same call");
          controlSessionId = call.sessionId;
        } else {
          setActiveEmbeddedRun(
            replacement === "replaced run" ? active.sessionId : "other-agent-session",
            {
              runId: replacement === "reused run ID" ? active.runId : "other-run",
              queueMessage: async () => undefined,
              isStreaming: () => true,
              isCompacting: () => false,
              abort: abortOther,
            },
            "global",
          );
        }
        expect(
          await dispatch("talk.client.steer", {
            sessionKey: "agent:primary:main",
            text: "cancel",
            mode: "cancel",
          }),
        ).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
        if (surface === "browser-provider") {
          browserControl!.onToolCall?.({
            callId: "control",
            itemId: "control",
            name: "openclaw_agent_control",
            args: { text: "cancel", mode: "cancel" },
          });
          await vi.waitFor(() =>
            expect(submitProviderResult).toHaveBeenCalledWith(
              "control",
              expect.objectContaining({ ok: cancelsOriginal, mode: "cancel" }),
            ),
          );
        } else {
          const control = await dispatch(browser ? "talk.client.steer" : "talk.session.steer", {
            ...(browser ? {} : { sessionId: controlSessionId }),
            sessionKey: "main",
            text: "cancel",
            mode: "cancel",
          });
          expect(control).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ ok: cancelsOriginal, mode: "cancel" }),
            undefined,
          );
        }
        expect(abortOwned).toHaveBeenCalledTimes(cancelsOriginal ? 1 : 0);
        expect(abortOther).not.toHaveBeenCalled();
        expect(
          clientVoiceSessionTesting.readRecord("voice", result.voiceSessionId ?? result.sessionId!)
            ?.sessionKey,
        ).toBe("main");
        finish.resolve();
        if (cancelsOriginal) {
          await expect(consult).rejects.toMatchObject({ name: "AbortError" });
        } else {
          await expect(consult).resolves.toEqual({ text: "Synthetic consult answer" });
        }
      } finally {
        finish.resolve();
        await Promise.allSettled([consult]);
      }
    });
  },
);
