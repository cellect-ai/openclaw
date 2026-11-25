import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../../../agents/embedded-agent-runner/run/params.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  testing as embeddedRunTesting,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
} from "../../../agents/embedded-agent-runner/runs.test-support.js";
import { createGatewayHostLifecycle } from "../../../cli/gateway-cli/host-lifecycle.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  getGatewaySuspendStatus,
  prepareGatewaySuspend,
  resetGatewaySuspendCoordinatorForLifecycleRestart,
} from "../../../infra/gateway-suspend-coordinator.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import { rpcSourceTesting } from "../../../sessions/session-lifecycle-admission.test-support.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import * as voiceSessionWrites from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import type {
  RealtimeVoiceGatewayControl,
  RealtimeVoiceProviderCapabilities,
} from "../../../talk/provider-types.js";
import { makeBridge } from "../../../talk/session-runtime.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { getGatewayProcessInstanceId } from "../../process-instance.js";
import { createChatRunState } from "../../server-chat-state.js";
import { handleGatewayRequest } from "../../server-methods.js";
import { suspendHandlers } from "../../server-methods/suspend.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "../../server-methods/types.js";
import { sharingPolicyClient } from "../../session-sharing.test-utils.js";
import type { GatewayControlOwner } from "../client-agent-consult.types.js";
import { closeTalkClientGatewayControlSession } from "../client-gateway-control.js";
import { drainingRelaySessions, relaySessions } from "../relay/state.js";
import { cleanupTalkConnection } from "../session-registry.js";
import { unregisterTalkVoiceSession } from "../voice-selection.js";
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
  closeProvider: vi.fn(async (): Promise<void> => undefined),
  runEmbeddedAgent: vi.fn(async (_params: RunEmbeddedAgentParams) => ({
    payloads: [{ text: "Synthetic consult answer" }],
    meta: { durationMs: 0 },
  })),
}));

vi.mock("../../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: mocks.runEmbeddedAgent }));
vi.mock("../../../agents/bootstrap-files.js", () => ({
  resolveBootstrapFilesForRun: async () => [],
}));
// mock-isolation: Keep provider registration and credential state outside handler tests.
vi.mock("../../../talk/provider-resolver.js", () => ({
  resolveConfiguredRealtimeVoiceProviderAsync: mocks.resolveProvider,
}));
vi.mock("../../../talk/provider-registry.js", () => ({ listRealtimeVoiceProviders: () => [] }));

let state: OpenClawTestState;
let config: OpenClawConfig;
let client: ReturnType<typeof sharingPolicyClient> & { connId: string };
let callback: GatewayControlOwner["runAgentConsult"] | undefined;

const browserVoiceSessionIds = new Set<string>();
let browserControl: RealtimeVoiceGatewayControl | undefined;
const submitProviderResult = vi.fn();
const context = {
  getRuntimeConfig: () => config,
  getClientConnIds: () => new Set([client.connId]),
  chatRunState: createChatRunState(),
  agentRunSeq: new Map(),
  removeChatRun: vi.fn(),
  broadcast: vi.fn(),
  nodeSendToSession: vi.fn(),
  broadcastToConnIds: vi.fn(),
  logGateway: { warn: vi.fn() },
} as unknown as GatewayRequestContext;

function makeConsultBridge(submitToolResult = () => undefined) {
  return makeBridge({
    triggerGreeting: undefined,
    handleBargeIn: () => undefined,
    submitToolResult,
  });
}

function configureProvider(provider: RealtimeVoiceProviderPlugin, supportsGatewayControl = true) {
  mocks.resolveProvider.mockReturnValue({
    provider,
    providerConfig: {},
    capabilities: {
      ...mocks.capabilities,
      handlesAgentConsult: true,
      ...(supportsGatewayControl ? { supportsGatewayControl } : {}),
    },
  });
}

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
  state = await createOpenClawTestState({
    label: "talk-native-consult",
    prepareProfileCatalog: true,
  });
  config = {
    agents: {
      ownership: "explicit",
      entries: { primary: {}, voice: { workspace: state.workspaceDir } },
    },
    talk: { agentId: "voice" },
  };
  setRuntimeConfigSnapshot(config);
  client = {
    ...sharingPolicyClient({ user: ensureProfileForEmail("native-listener@example.test").id }),
    connId: "native-consult-client",
  };
  callback = undefined;

  browserVoiceSessionIds.clear();
  browserControl = undefined;
  vi.clearAllMocks();
  mocks.runEmbeddedAgent.mockReset();
  rpcSourceTesting.clear();
  context.chatRunState.clear();
  context.agentRunSeq.clear();
  setActivePluginRegistry(createEmptyPluginRegistry());
  const provider: RealtimeVoiceProviderPlugin = {
    id: "synthetic-voice",
    label: "Synthetic voice",
    capabilities: mocks.capabilities,
    isConfigured: () => true,
    createBrowserSession: async (request) => {
      callback = request.runAgentConsult;
      browserControl = request.gatewayControl;
      browserControl?.bindBridge(makeConsultBridge(submitProviderResult));
      return {
        provider: "synthetic-voice",
        transport: "webrtc",
        clientSecret: "synthetic-offer",
        offerUrl: "/test/offer",
      };
    },
    createBridge: (request) => {
      callback = request.runAgentConsult;
      return makeConsultBridge();
    },
  };
  Object.defineProperty(provider, Symbol.for("openclaw.internal.realtime-voice-provider.v1"), {
    value: { isBrowserSessionConfigured: () => true, cancelBrowserSession: mocks.closeProvider },
  });
  configureProvider(provider);
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
        if (browser) {
          mocks.closeProvider.mockImplementation(waitForFinalization);
        } else {
          // Relay provider finalization is the bridge close, not the browser cancel hook.
          const bridge = relaySessions.get(call.sessionId)!.bridge;
          vi.spyOn(bridge, "close").mockImplementation(async () => {
            await waitForFinalization();
          });
        }
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
      // Relay RPCs resolve their opaque owner during pre-dispatch authorization,
      // before suspension admission. Browser steering resolves by session key,
      // then the retained-call admission rejects the foreign physical connection.
      expect(await dispatch(method, args)).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining(
          browser
            ? {
                code: "UNAVAILABLE",
                message: "talk.client.steer unavailable during gateway suspension",
              }
            : {
                code: "INVALID_REQUEST",
                message: "Talk session is not owned by this connection",
              },
        ),
      );
      expect(mocks.runEmbeddedAgent).toHaveBeenCalledOnce();
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
});
