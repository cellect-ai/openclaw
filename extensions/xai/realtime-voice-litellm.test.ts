import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRealtimeVoiceProviderCapabilitiesAsync } from "../../src/talk/provider-resolver.js";
import {
  normalizeXaiRealtimeProviderConfig,
  XAI_REALTIME_VOICES,
} from "./realtime-voice-config.js";
import { buildLiteLlmRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const { FakeWebSocket, isProviderAuthProfileConfiguredAsyncMock, resolveApiKeyForProviderMock } =
  await vi.hoisted(() => import("./realtime-voice-socket.test-support.js"));

vi.mock("./ws-runtime.js", () => ({
  WebSocket: FakeWebSocket,
}));

// mock-isolation: Realtime tests control credential availability and pending resolution without host auth storage.
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: () => false,
  isProviderAuthProfileConfiguredAsync: isProviderAuthProfileConfiguredAsyncMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

import {
  createTestBridge as buildTestBridge,
  openRealtimeBridge,
  parseSent,
  requireSession,
  requireSocket,
  waitForRealtimeState,
  type TestBridgeOptions,
} from "./realtime-voice-provider.test-support.js";

const bridges: ReturnType<typeof buildTestBridge>[] = [];
function createTestBridge(options: Partial<TestBridgeOptions> = {}) {
  const bridge = buildTestBridge(options);
  bridges.push(bridge);
  return bridge;
}

// pragma: allowlist secret

function toolResultEvent(callId: string, result: unknown) {
  return {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(result),
    },
  };
}

describe("buildXaiRealtimeVoiceProvider", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    isProviderAuthProfileConfiguredAsyncMock.mockReset();
    isProviderAuthProfileConfiguredAsyncMock.mockResolvedValue(false);
    resolveApiKeyForProviderMock.mockReset();
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: undefined });
    delete process.env.XAI_API_KEY;
    vi.unstubAllEnvs();
  });

  afterEach(async () => {
    for (const bridge of bridges.splice(0)) {
      await bridge.close();
    }
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each([
    ["undefined", (): undefined => undefined],
    [
      "circular",
      () => {
        const result: { self?: unknown } = {};
        result.self = result;
        return result;
      },
    ],
    ["omitted custom serialization", () => ({ toJSON: () => undefined })],
  ] as const)(
    "rejects %s realtime tool results before transport ownership changes",
    async (_label, create) => {
      const onError = vi.fn();
      const bridge = createTestBridge({ onError, onToolCall: vi.fn() });
      const socket = await openRealtimeBridge(bridge);
      socket.emitServer({
        type: "response.function_call_arguments.done",
        item_id: "item_call_1",
        name: "openclaw_agent_consult",
        call_id: "call_1",
        arguments: "{}",
      });

      expect(() => bridge.submitToolResult("call_1", create())).toThrow(/serializ/i);
      expect(onError).not.toHaveBeenCalled();
      expect(
        parseSent(socket).filter((event) => event.type === "conversation.item.create"),
      ).toEqual([]);

      await bridge.submitToolResult("call_1", { recovered: true });

      expect(parseSent(socket).slice(-2)).toEqual([
        toolResultEvent("call_1", { recovered: true }),
        { type: "response.create" },
      ]);
      await bridge.close();
    },
  );
});

describe("buildLiteLlmRealtimeVoiceProvider", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    delete process.env.FI_USER_LITELLM_API_KEY;
  });

  afterEach(() => {
    delete process.env.FI_USER_LITELLM_API_KEY;
  });

  it("advertises the two approved realtime aliases without changing the OpenAI default", () => {
    const provider = buildLiteLlmRealtimeVoiceProvider();

    expect(provider.id).toBe("litellm");
    expect(provider.models).toEqual(["grok-voice-think-fast-2.0", "gemini-3.8-live"]);
    expect(provider.defaultModel).toBe("grok-voice-think-fast-2.0");
    expect(provider.capabilities?.supportsSessionResumption).toBe(false);
    expect(provider.capabilities?.transports).toEqual(["gateway-relay"]);
  });

  it.each([undefined, "grok-voice-think-fast-2.0", "gemini-3.8-live"])(
    "offers both model voice catalogs regardless of configured model %s",
    async (model) => {
      const provider = buildLiteLlmRealtimeVoiceProvider();
      for (const surface of ["gateway-relay", "browser-session"] as const) {
        const voices = (
          await resolveRealtimeVoiceProviderCapabilitiesAsync({
            provider,
            providerConfig: { model },
            surface,
          })
        )?.voicesByModel;
        expect(voices?.["grok-voice-think-fast-2.0"]).toEqual(XAI_REALTIME_VOICES);
        const googleVoices = voices?.["gemini-3.8-live"];
        expect(googleVoices).toHaveLength(30);
        expect(googleVoices).toEqual(expect.arrayContaining(["Kore", "Puck", "Aoede", "Sulafat"]));
        for (const grokVoice of XAI_REALTIME_VOICES) {
          expect(googleVoices).not.toContain(grokVoice);
        }
      }
    },
  );

  it("is configured only when the Fi-scoped proxy key and fixed endpoint are present", () => {
    const provider = buildLiteLlmRealtimeVoiceProvider();
    expect(
      provider.isConfigured({
        providerConfig: { baseUrl: "http://192.168.5.139:4000/v1" },
      }),
    ).toBe(false);
    process.env.FI_USER_LITELLM_API_KEY = "litellm-fi-test-key"; // pragma: allowlist secret
    expect(
      provider.isConfigured({
        providerConfig: { baseUrl: "http://192.168.5.139:4000/v1" },
      }),
    ).toBe(true);
    expect(
      provider.isConfigured({
        providerConfig: { baseUrl: "https://attacker.example/v1" },
      }),
    ).toBe(false);
  });

  it("keeps the inactive Fi-scoped key reference selectable without resolving it into config", () => {
    process.env.FI_USER_LITELLM_API_KEY = "litellm-fi-test-key"; // pragma: allowlist secret
    const provider = buildLiteLlmRealtimeVoiceProvider();
    const unresolvedRef = {
      source: "env",
      provider: "default",
      id: "FI_USER_LITELLM_API_KEY",
    } as never;
    const config = normalizeXaiRealtimeProviderConfig(
      {
        apiKey: unresolvedRef,
        baseUrl: "http://192.168.5.139:4000/v1",
      } as never,
      "litellm",
    );

    expect(config.apiKey).toBeUndefined();
    expect(provider.isConfigured({ providerConfig: config } as never)).toBe(true);

    const bridge = provider.createBridge({
      providerConfig: {
        apiKey: unresolvedRef,
        baseUrl: "http://192.168.5.139:4000/v1",
        model: "grok-voice-think-fast-2.0",
      },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });
    const connecting = bridge.connect();
    return waitForRealtimeState(() => expect(FakeWebSocket.instances).toHaveLength(1)).then(() => {
      const socket = requireSocket();
      socket.open();
      socket.emitServer({ type: "session.updated" });
      return connecting.then(() => {
        const [, options] = socket.args as [string, { headers: Record<string, string> }];
        expect(options.headers.Authorization).toBe("Bearer litellm-fi-test-key");
        bridge.close();
      });
    });
  });

  it("keeps direct xAI created and unrelated events pending until session.updated", async () => {
    const onReady = vi.fn();
    const bridge = createTestBridge({ onReady });
    const connecting = bridge.connect();
    let settled = false;
    void connecting.then(() => {
      settled = true;
    });
    await waitForRealtimeState(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = requireSocket();
    socket.open();
    for (const type of ["session.created", "synthetic.unrelated"]) {
      socket.emitServer({ type });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(bridge.isConnected()).toBe(false);
      expect(onReady).not.toHaveBeenCalled();
    }
    socket.emitServer({ type: "session.updated" });
    await connecting;
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("does not accept LiteLLM setup when its observer closes the original connection", async () => {
    const onReady = vi.fn();
    const provider = buildLiteLlmRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: {
        apiKey: "synthetic-key",
        baseUrl: "http://192.168.5.139:4000/v1",
        model: "gemini-3.8-live",
      },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onReady,
      onEvent: (event) => {
        if (event.direction === "server" && event.type === "session.created") bridge.close();
      },
    });
    bridges.push(bridge);
    const connecting = bridge.connect();
    await waitForRealtimeState(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = requireSocket();
    socket.open();
    socket.emitServer({ type: "session.created" });
    await connecting;
    socket.emitServer({ type: "session.created" });
    expect(bridge.isConnected()).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
  });

  it("accepts LiteLLM's session.created event as the Gemini setup acknowledgement", async () => {
    const provider = buildLiteLlmRealtimeVoiceProvider();
    const onReady = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: {
        apiKey: "litellm-fi-test-key", // pragma: allowlist secret
        baseUrl: "http://192.168.5.139:4000/v1",
        model: "gemini-3.8-live",
      },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onReady,
    });
    const connecting = bridge.connect();
    await waitForRealtimeState(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = requireSocket();
    socket.open();
    socket.emitServer({ type: "session.created", session: { model: "gemini-3.8-live" } });

    await connecting;

    expect(bridge.isConnected()).toBe(true);
    socket.emitServer({ type: "session.created" });
    expect(onReady).toHaveBeenCalledOnce();
    bridge.close();
  });

  it.each([
    { model: "grok-voice-think-fast-2.0", configuredVoice: undefined, voice: "eve" },
    { model: "gemini-3.8-live", configuredVoice: undefined, voice: "Kore" },
    { model: "gemini-3.8-live", configuredVoice: "Puck", voice: "Puck" },
    { model: "gemini-3.8-live", configuredVoice: "Aoede", voice: "Aoede" },
    { model: "gemini-3.8-live", configuredVoice: "sulafat", voice: "Sulafat" },
    { model: "gemini-3.8-live", configuredVoice: "rex", voice: "Kore" },
    { model: "grok-voice-think-fast-2.0", configuredVoice: "Gacrux", voice: "eve" },
  ])(
    "connects $model with $configuredVoice through the internal LiteLLM realtime endpoint",
    async ({ model, configuredVoice, voice }) => {
      const provider = buildLiteLlmRealtimeVoiceProvider();
      const bridge = provider.createBridge({
        providerConfig: {
          apiKey: "litellm-fi-test-key", // pragma: allowlist secret
          baseUrl: "http://192.168.5.139:4000/v1",
          model,
          speakerVoice: configuredVoice,
          reasoningEffort: "high",
          sessionResumption: true,
        },
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
      });
      const connecting = bridge.connect();
      await waitForRealtimeState(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const socket = requireSocket();
      socket.open();
      socket.emitServer({ type: "session.updated" });
      await connecting;

      const [url, options] = socket.args as [string, { headers: Record<string, string> }];
      expect(url).toContain("ws://192.168.5.139:4000/v1/realtime?");
      expect(url).toContain(`model=${model}`);
      expect(options.headers.Authorization).toBe("Bearer litellm-fi-test-key");
      expect(requireSession(socket)).toMatchObject({ voice, output_modalities: ["audio"] });
      if (model === "gemini-3.8-live") {
        expect(requireSession(socket)).toMatchObject({
          audio: { output: { transcription: {} } },
        });
      }
      expect(requireSession(socket)).not.toHaveProperty("reasoning");
      expect(requireSession(socket)).not.toHaveProperty("resumption");
      bridge.close();
    },
  );

  it("rejects unapproved model IDs and proxy endpoints before opening a socket", () => {
    const provider = buildLiteLlmRealtimeVoiceProvider();
    const create = (providerConfig: Record<string, string>) =>
      provider.createBridge({
        providerConfig,
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
      });

    expect(() =>
      create({
        apiKey: "litellm-fi-test-key", // pragma: allowlist secret
        baseUrl: "http://192.168.5.139:4000/v1",
        model: "unapproved-model",
      }),
    ).toThrow("Unsupported LiteLLM realtime voice model");
    expect(() =>
      create({
        apiKey: "litellm-fi-test-key", // pragma: allowlist secret
        baseUrl: "https://attacker.example/v1",
        model: "gemini-3.8-live",
      }),
    ).toThrow("LiteLLM realtime baseUrl must be");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("rejects configurations that disable automatic server-VAD interruption", () => {
    const provider = buildLiteLlmRealtimeVoiceProvider();

    expect(() =>
      provider.createBridge({
        providerConfig: {
          apiKey: "litellm-fi-test-key", // pragma: allowlist secret
          baseUrl: "http://192.168.5.139:4000/v1",
          interruptResponseOnInputAudio: false,
        },
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
      }),
    ).toThrow("automatic server-VAD interruption handling");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
