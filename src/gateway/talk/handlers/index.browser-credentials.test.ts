import { expectDefined } from "@openclaw/normalization-core/expect";
/** Tests for talk gateway methods that coordinate speech and audio providers. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS } from "../../../agents/realtime-bootstrap-context.test-support.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import { setActiveDegradedSecretOwners } from "../../../secrets/runtime-degraded-state.js";
import { rpcSourceTesting } from "../../../sessions/session-lifecycle-admission.test-support.js";
import { createBrowserProvider } from "./client-fixtures.test-support.js";
import { createBrowserConsultOwnerFixture } from "./client-owner.test-support.js";
import { createTalkHandlerCaller } from "./handler-invocation.test-support.js";
import { talkHandlers } from "./index.js";
import { expectRespondError } from "./responses.test-support.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn<() => OpenClawConfig>(),
  getCanonicalUserPreferences: vi.fn<
    () => Promise<{ profileId: string; entries: Record<string, unknown> } | undefined>
  >(async () => undefined),
  projectConfigOntoRuntimeSourceSnapshot: vi.fn<(config: OpenClawConfig) => OpenClawConfig>(),
  canonicalizeSpeechProviderId: vi.fn((providerId: string | undefined) => providerId),
  getSpeechProvider: vi.fn(),
  listSpeechProviders: vi.fn(() => []),
  synthesizeSpeech: vi.fn(),
  canonicalizeRealtimeVoiceProviderId: vi.fn((providerId: string | undefined) =>
    providerId === "gemini-live" ? "google" : providerId?.trim().toLowerCase(),
  ),
  listRealtimeVoiceProviders: vi.fn<() => RealtimeVoiceProviderPlugin[]>(() => []),
  canonicalizeRealtimeTranscriptionProviderId: vi.fn((providerId: string | undefined) =>
    providerId === "openai-realtime" ? "openai" : providerId?.trim().toLowerCase(),
  ),
  getRealtimeTranscriptionProvider: vi.fn(),
  listRealtimeTranscriptionProviders: vi.fn(() => []),
  resolveConfiguredRealtimeVoiceProviderAsync: vi.fn(),
  isRealtimeVoiceProviderConfiguredAsync: vi.fn(
    async ({
      provider,
      cfg,
      providerConfig,
    }: {
      provider: {
        isConfigured: (ctx: { cfg?: unknown; providerConfig: unknown }) => boolean;
      };
      cfg?: unknown;
      providerConfig: unknown;
    }) => provider.isConfigured({ cfg, providerConfig }),
  ),
  resolveRealtimeVoiceProviderCapabilitiesAsync: vi.fn(
    ({ provider }: { provider: { capabilities?: unknown } }) => provider.capabilities,
  ),
  resolveInternalRealtimeVoiceGatewayRelayLaunchError: vi.fn(),
  cancelInternalRealtimeVoiceBrowserSession: vi.fn(async () => undefined),
  createTalkRealtimeRelaySession: vi.fn(),
  sendTalkRealtimeRelayAudio: vi.fn(),
  acknowledgeTalkRealtimeRelayMark: vi.fn(),
  cancelTalkRealtimeRelayTurn: vi.fn(),
  stopTalkRealtimeRelaySession: vi.fn(),
  registerTalkRealtimeRelayAgentRun: vi.fn(
    async ({
      registerVoice,
      assertCurrent,
    }: {
      registerVoice?: (
        assertCurrent: () => void,
        physicalSource: undefined,
        onRegistered: (release: () => void) => void,
      ) => Promise<void>;
      assertCurrent?: () => void;
    }) => {
      let release = () => {};
      await registerVoice?.(assertCurrent ?? (() => {}), undefined, (registeredRelease) => {
        release = registeredRelease;
      });
      return {
        run: { runId: "run-voice-1", sessionKey: "agent:main:main" },
        release,
        isCurrent: () => true,
        abortIfCurrent: () => {},
      };
    },
  ),
  flushTalkRealtimeRelayVoiceWrites: vi.fn(async () => undefined),
  ensureTalkRealtimeRelayVoiceSession: vi.fn(),
  submitTalkRealtimeRelayToolResult: vi.fn(),
  createTalkTranscriptionRelaySession: vi.fn(),
  sendTalkTranscriptionRelayAudio: vi.fn(),
  stopTalkTranscriptionRelaySession: vi.fn(),
  chatSend: vi.fn(),
  controlTalkAgentRun: vi.fn(),
  steerTalkRealtimeRelayAgentRun: vi.fn(),
  resolveSessionKeyFromResolveParams: vi.fn(),
  resolveRealtimeVoiceAgentContextInstructions: vi.fn(async (): Promise<string> => ""),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-agent-workspace"),
  readSessionPreviewItemsFromTranscriptAsync: vi.fn(() => [
    { role: "user", text: "Earlier question" },
    { role: "assistant", text: "Earlier answer" },
    { role: "tool", text: "internal tool output" },
  ]),
  closeStaleClientVoiceSessions: vi.fn(async () => 0),
  createOrResumeClientVoiceSession: vi.fn<
    typeof import("../../../talk/client-voice-session.js").createOrResumeClientVoiceSession
  >(async () => "voice-test"),
  ensureClientVoiceAgentSessionEntry: vi.fn(async () => "session-main"),
  resolveClientVoiceAgentSessionId: vi
    .fn<() => Promise<string | undefined>>()
    .mockResolvedValue("session-main"),
  assertClientVoiceSessionOpen: vi.fn(),
  registerClientVoiceConsultRun: vi.fn(
    ({ onRegistered }: { onRegistered?: (release: () => void) => void }) => {
      const release = () => {};
      onRegistered?.(release);
      return release;
    },
  ),
  resolveOpenClientVoiceSessionId: vi.fn(),
  consultRealtimeVoiceAgent: vi.fn(async (_params?: unknown) => ({ text: "agent answer" })),
  closeTalkClientGatewayControlSession: vi.fn(async () => false),
  gatewayControlActivate: vi.fn(),
  gatewayControlAdoptProvider: vi.fn(async () => undefined),
  gatewayControlClose: vi.fn(async () => undefined),
  gatewayControl: { bindBridge: vi.fn(), bindControl: vi.fn() },
  createTalkClientGatewayControlOwner: vi.fn(),
  agentRuntime: { session: { prepareSessionEntryPatch: vi.fn() } },
}));

vi.mock("../../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config/config.js")>()),
  projectConfigOntoRuntimeSourceSnapshot: mocks.projectConfigOntoRuntimeSourceSnapshot,
}));

vi.mock("../../../state/user-preferences.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../state/user-preferences.js")>()),
  getCanonicalUserPreferences: mocks.getCanonicalUserPreferences,
}));

vi.mock("../../../tts/provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../tts/provider-registry.js")>()),
  canonicalizeSpeechProviderId: mocks.canonicalizeSpeechProviderId,
  getSpeechProvider: mocks.getSpeechProvider,
  listSpeechProviders: mocks.listSpeechProviders,
}));

// mock-isolation: Keep synthesis stubbed while using real settings/readiness without barrel initialization.
vi.mock("../../../tts/tts.js", async () => ({
  isTtsProviderConfiguredAsync: (await import("../../../tts/tts-provider-resolution.js"))
    .isTtsProviderConfiguredAsync,
  resolveTtsConfig: (await import("../../../tts/tts-settings.js")).resolveTtsConfig,
  synthesizeSpeech: mocks.synthesizeSpeech,
}));

vi.mock("../../../tts/tts-synthesis.js", () => ({ synthesizeTalkSpeech: mocks.synthesizeSpeech }));

vi.mock("../../../talk/provider-registry.js", () => ({
  canonicalizeRealtimeVoiceProviderId: mocks.canonicalizeRealtimeVoiceProviderId,
  getRealtimeVoiceProvider: (providerId: string | undefined) =>
    mocks
      .listRealtimeVoiceProviders()
      .find((provider: { id: string }) => provider.id === providerId),
  listRealtimeVoiceProviders: mocks.listRealtimeVoiceProviders,
}));

vi.mock("../../../realtime-transcription/provider-registry.js", () => ({
  canonicalizeRealtimeTranscriptionProviderId: mocks.canonicalizeRealtimeTranscriptionProviderId,
  getRealtimeTranscriptionProvider: mocks.getRealtimeTranscriptionProvider,
  listRealtimeTranscriptionProviders: mocks.listRealtimeTranscriptionProviders,
}));

// mock-isolation: Keep provider registration and credential state outside handler tests.
vi.mock("../../../talk/provider-resolver.js", () => ({
  isRealtimeVoiceProviderConfiguredAsync: mocks.isRealtimeVoiceProviderConfiguredAsync,
  resolveConfiguredRealtimeVoiceProviderAsync: mocks.resolveConfiguredRealtimeVoiceProviderAsync,
  resolveRealtimeVoiceProviderCapabilitiesAsync:
    mocks.resolveRealtimeVoiceProviderCapabilitiesAsync,
}));

vi.mock("../../../talk/provider-internal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../talk/provider-internal.js")>();
  return {
    ...actual,
    cancelInternalRealtimeVoiceBrowserSession: mocks.cancelInternalRealtimeVoiceBrowserSession,
    resolveInternalRealtimeVoiceGatewayRelayLaunchError:
      mocks.resolveInternalRealtimeVoiceGatewayRelayLaunchError,
  };
});

// mock-isolation: Handler routing tests stub active-run control instead of driving live session runs.
vi.mock("../../../talk/agent-run-control.js", () => ({
  controlTalkAgentRun: mocks.controlTalkAgentRun,
}));

vi.mock("../../../talk/agent-consult-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../talk/agent-consult-runtime.js")>();
  return {
    ...actual,
    consultRealtimeVoiceAgent: mocks.consultRealtimeVoiceAgent,
  };
});

vi.mock("../../../plugins/runtime/index.js", () => ({
  createPluginRuntime: () => ({ agent: mocks.agentRuntime }),
}));

vi.mock("../../../agents/realtime-bootstrap-context.js", () => ({
  resolveRealtimeVoiceAgentContextInstructions: mocks.resolveRealtimeVoiceAgentContextInstructions,
}));

vi.mock("../../../agents/agent-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../agents/agent-scope.js")>();
  return {
    ...actual,
    resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  };
});

vi.mock("../../session-transcript-preview.js", () => ({
  readSessionPreviewItemsFromTranscriptAsync: mocks.readSessionPreviewItemsFromTranscriptAsync,
}));

vi.mock("../../../talk/client-voice-session-read.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../talk/client-voice-session-read.js")>();
  return {
    ...actual,
    assertClientVoiceSessionOpen: mocks.assertClientVoiceSessionOpen,
    resolveClientVoiceAgentSessionId: mocks.resolveClientVoiceAgentSessionId,
    resolveOpenClientVoiceSessionId: mocks.resolveOpenClientVoiceSessionId,
  };
});

vi.mock("../../../talk/client-voice-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../talk/client-voice-session.js")>();
  return {
    ...actual,
    closeStaleClientVoiceSessions: mocks.closeStaleClientVoiceSessions,
    createOrResumeClientVoiceSession: mocks.createOrResumeClientVoiceSession,
    registerClientVoiceConsultRun: mocks.registerClientVoiceConsultRun,
  };
});

vi.mock("../../../talk/client-voice-session-write.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../talk/client-voice-session-write.js")>();
  return {
    ...actual,
    ensureClientVoiceAgentSessionEntry: mocks.ensureClientVoiceAgentSessionEntry,
    // Creation is mocked here; expose its supplied source without acquiring a database writer.
    captureClientVoiceSessionWriter: ({
      physicalSource,
    }: Parameters<typeof actual.captureClientVoiceSessionWriter>[0]) => ({
      source: expectDefined(physicalSource, "Mocked voice creation requires its admitted source"),
      release: () => {},
    }),
  };
});

// mock-isolation: Route trusted dispatch through the fixture without starting an agent run.
vi.mock("../../server-methods/chat-send-handler.js", async () => {
  const { createTrustedInternalChatSendFixture } =
    await import("./client-fixtures.test-support.js");
  return {
    handleChatSend: mocks.chatSend,
    handleTrustedInternalChatSend: createTrustedInternalChatSendFixture(mocks.chatSend),
  };
});

vi.mock("../../sessions-resolve.js", () => ({
  withPreparedSessionResolve: async (
    { isCurrent: _isCurrent, ...params }: Record<string, unknown>,
    consume: (result: unknown) => unknown,
  ) => consume(mocks.resolveSessionKeyFromResolveParams(params)),
}));

vi.mock("../relay/session-create.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../relay/session-create.js")>()),
  createTalkRealtimeRelaySession: mocks.createTalkRealtimeRelaySession,
}));

vi.mock("../relay/operations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../relay/operations.js")>()),
  acknowledgeTalkRealtimeRelayMark: mocks.acknowledgeTalkRealtimeRelayMark,
  cancelTalkRealtimeRelayTurn: mocks.cancelTalkRealtimeRelayTurn,
  ensureTalkRealtimeRelayVoiceSession: mocks.ensureTalkRealtimeRelayVoiceSession,
  flushTalkRealtimeRelayVoiceWrites: mocks.flushTalkRealtimeRelayVoiceWrites,
  registerTalkRealtimeRelayAgentRun: mocks.registerTalkRealtimeRelayAgentRun,
  sendTalkRealtimeRelayAudio: mocks.sendTalkRealtimeRelayAudio,
  steerTalkRealtimeRelayAgentRun: mocks.steerTalkRealtimeRelayAgentRun,
  stopTalkRealtimeRelaySession: mocks.stopTalkRealtimeRelaySession,
  submitTalkRealtimeRelayToolResult: mocks.submitTalkRealtimeRelayToolResult,
}));

vi.mock("../client-gateway-control.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client-gateway-control.js")>();
  return {
    ...actual,
    closeTalkClientGatewayControlSession: mocks.closeTalkClientGatewayControlSession,
    createTalkClientGatewayControlOwner: mocks.createTalkClientGatewayControlOwner,
  };
});

vi.mock("../transcription-relay.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../transcription-relay.js")>();
  return {
    ...actual,
    createTalkTranscriptionRelaySession: mocks.createTalkTranscriptionRelaySession,
    sendTalkTranscriptionRelayAudio: mocks.sendTalkTranscriptionRelayAudio,
    stopTalkTranscriptionRelaySession: mocks.stopTalkTranscriptionRelaySession,
  };
});

const callTalkHandler = createTalkHandlerCaller(talkHandlers);

async function invokeTalkHandler(
  method: string,
  options: Omit<Parameters<typeof callTalkHandler>[1], "respond" | "params"> & {
    params?: Record<string, unknown>;
  } = {},
) {
  const respond = vi.fn();
  await callTalkHandler(method, { params: {}, ...options, respond });
  return respond;
}

beforeEach(() => {
  mocks.createTalkClientGatewayControlOwner.mockImplementation((params) =>
    createBrowserConsultOwnerFixture(params, {
      activate: mocks.gatewayControlActivate,
      adoptProvider: mocks.gatewayControlAdoptProvider,
      close: mocks.gatewayControlClose,
      control: mocks.gatewayControl,
    }),
  );
  rpcSourceTesting.clear();
  setActiveDegradedSecretOwners([]);
  mocks.getRealtimeTranscriptionProvider.mockImplementation((providerId: string | undefined) => {
    const normalized = providerId?.trim().toLowerCase();
    const providers = mocks.listRealtimeTranscriptionProviders() as Array<{
      id: string;
      aliases?: string[];
    }>;
    return providers.find(
      (provider) =>
        provider.id.toLowerCase() === normalized ||
        provider.aliases?.some((alias) => alias.toLowerCase() === normalized),
    );
  });
});

describe("talk.client.create handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRealtimeVoiceProviderCapabilitiesAsync.mockImplementation(
      ({ provider }: { provider: { capabilities?: unknown } }) => provider.capabilities,
    );
    mocks.resolveRealtimeVoiceAgentContextInstructions.mockResolvedValue(
      REALTIME_VOICE_AGENT_CONTEXT_INSTRUCTIONS,
    );
    mocks.createOrResumeClientVoiceSession.mockImplementation(
      async (params: { voiceSessionId?: string }) => params.voiceSessionId ?? "voice-test",
    );
    mocks.resolveClientVoiceAgentSessionId.mockResolvedValue("session-main");
    mocks.closeTalkClientGatewayControlSession.mockResolvedValue(false);
  });

  it.each([
    {
      failure: "startup",
      expiresIn: undefined,
      transport: "webrtc",
      message: "Error: provider startup failed",
    },
    {
      failure: "persistence",
      expiresIn: 60_000,
      transport: "webrtc",
      message: "Error: store failed",
    },
    {
      failure: "expired",
      expiresIn: 1_000,
      transport: "webrtc",
      message: "Error: Realtime browser session expired during startup; try again",
    },
    {
      failure: "transport",
      expiresIn: undefined,
      transport: "provider-websocket",
      message:
        'Realtime provider "openai" does not support requested browser transport "provider-websocket"',
    },
  ])(
    "cancels minted browser credentials after $failure failure",
    async ({ failure, expiresIn, transport, message }) => {
      const browserSession = {
        provider: "openai",
        transport: "webrtc" as const,
        clientSecret: "session-secret",
        ...(expiresIn === undefined ? {} : { expiresAt: Date.now() + expiresIn }),
      };
      if (failure === "persistence") {
        mocks.ensureClientVoiceAgentSessionEntry.mockRejectedValueOnce(new Error("store failed"));
      }
      if (failure === "startup") {
        mocks.resolveClientVoiceAgentSessionId.mockResolvedValue(undefined);
      }
      const createBrowserSession = vi.fn(async (_input: unknown) => {
        if (failure === "startup") {
          throw new Error("provider startup failed");
        }
        return browserSession;
      });
      const provider = createBrowserProvider(createBrowserSession);
      mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
        provider,
        providerConfig: failure === "startup" ? { apiKey: "test-api-key" } : {},
      });

      const respond = await invokeTalkHandler("talk.client.create", {
        params: {
          sessionKey: "main",
          transport,
        },
      });
      if (failure === "startup") {
        expect(createBrowserSession).toHaveBeenCalledWith(
          expect.objectContaining({ initialItems: [] }),
        );
      } else {
        expect(mocks.cancelInternalRealtimeVoiceBrowserSession).toHaveBeenCalledWith({
          provider,
          request: expect.objectContaining({ providerConfig: {} }),
          session: browserSession,
        });
      }
      if (failure !== "persistence") {
        expect(mocks.ensureClientVoiceAgentSessionEntry).not.toHaveBeenCalled();
      }
      expect(mocks.createOrResumeClientVoiceSession).not.toHaveBeenCalled();
      expectRespondError(respond, { message });
    },
  );

  it("rejects Gateway-owned sessions returned by a browser-session provider", async () => {
    const createBrowserSession = vi.fn(async () => ({
      provider: "custom",
      transport: "gateway-relay" as const,
      relaySessionId: "relay-1",
      audio: {
        inputEncoding: "pcm16" as const,
        inputSampleRateHz: 24_000,
        outputEncoding: "pcm16" as const,
        outputSampleRateHz: 24_000,
      },
    }));
    mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
      provider: {
        id: "custom",
        label: "Custom",
        capabilities: {
          transports: ["gateway-relay"],
          inputAudioFormats: [],
          outputAudioFormats: [],
          supportsBrowserSession: true,
          supportsVideoFrames: true,
        },
        isConfigured: () => true,
        createBrowserSession,
        createBridge: vi.fn(),
      },
      providerConfig: {},
      capabilities: {
        transports: ["gateway-relay"],
        inputAudioFormats: [],
        outputAudioFormats: [],
        supportsBrowserSession: true,
        supportsVideoFrames: true,
      },
    });

    const respond = await invokeTalkHandler("talk.client.create", {
      params: {
        sessionKey: "main",
        mode: "realtime",
        capabilities: ["camera-frame"],
      },
    });

    expect(createBrowserSession).toHaveBeenCalledOnce();
    expect(mocks.ensureClientVoiceAgentSessionEntry).not.toHaveBeenCalled();
    expectRespondError(respond, {
      message: 'Realtime provider "custom" does not support client-owned realtime sessions',
    });
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
