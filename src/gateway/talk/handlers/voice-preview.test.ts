import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import type { RealtimeVoiceAudioOutputPort } from "../../../talk/audio-output-port.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "../../../talk/provider-types.js";
import { authorizeOperatorScopesForMethod } from "../../method-scopes.js";
import { createDirectChatContext } from "../../server-chat.agent-events.test-helpers.js";
import type { GatewayClient, RespondFn } from "../../server-methods/types.js";
import { talkVoicePreviewHandlers } from "./voice-preview.js";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  secret: vi.fn(),
  config: vi.fn(),
}));
vi.mock("../../../talk/provider-resolver.js", () => ({
  resolveConfiguredRealtimeVoiceProvider: mocks.resolve,
}));
vi.mock("../../../secrets/runtime-degraded-state.js", () => ({
  assertSecretOwnerAvailable: mocks.secret,
}));
vi.mock("../session-config.js", () => ({ buildTalkRealtimeConfig: mocks.config }));
vi.mock("../../../talk/provider-internal.js", () => ({
  projectInternalRealtimeVoicePublicConfig: ({ config }: { config: unknown }) => config,
}));

describe("sessionless realtime voice previews", () => {
  let request: RealtimeVoiceBridgeCreateRequest;
  let output: RealtimeVoiceAudioOutputPort | undefined;
  let bridge: RealtimeVoiceBridge;
  let client: GatewayClient;
  let current: boolean;
  let createBridge: ReturnType<
    typeof vi.fn<(req: RealtimeVoiceBridgeCreateRequest) => RealtimeVoiceBridge>
  >;
  const pending: Promise<unknown>[] = [];
  const pcm = Buffer.from([32, 0, 64, 0]);

  function start(
    params: Record<string, unknown> = {
      provider: "selected",
      model: "test-realtime",
      voice: "ember",
    },
  ) {
    const respond = vi.fn<RespondFn>();
    const completed = Promise.resolve(
      talkVoicePreviewHandlers["talk.voice.preview"]!({
        req: { type: "req", method: "talk.voice.preview", id: "preview", params },
        params,
        respond,
        client,
        context: createDirectChatContext({ getRuntimeConfig: () => ({}) }),
        isWebchatConnect: () => false,
        hasCurrentClientAuthority: () => current,
      }),
    );
    pending.push(completed);
    return { respond, completed };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.resolve.mockReset();
    mocks.secret.mockReset();
    mocks.config.mockReset();
    output = undefined;
    current = true;
    client = {
      connId: "preview-client",
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "gateway-client", version: "test", platform: "test", mode: "backend" },
        role: "operator",
        scopes: ["operator.write"],
      },
    };
    bridge = {
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      acknowledgeMark: vi.fn(),
      submitToolResult: vi.fn(),
      isConnected: () => true,
      close: vi.fn(),
      sendUserMessage: vi.fn(),
      setAudioOutputPort: vi.fn((port) => {
        output = port;
      }),
    };
    createBridge = vi.fn((input: RealtimeVoiceBridgeCreateRequest) => {
      request = input;
      return bridge;
    });
    mocks.config.mockReturnValue({
      providers: { selected: { speakerVoice: "old" } },
      model: "saved-model",
      voice: "old",
    });
    mocks.resolve.mockReturnValue({
      provider: { id: "selected", createBridge } satisfies Pick<
        RealtimeVoiceProviderPlugin,
        "id" | "createBridge"
      >,
      providerConfig: { model: "test-realtime", voice: "ember" },
      capabilities: {
        outputAudioFormats: [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }],
      },
    });
  });

  afterEach(async () => {
    await vi.runAllTimersAsync();
    await Promise.allSettled(pending.splice(0));
    vi.useRealTimers();
  });

  it("requires operator write, never just Talk or read access", () => {
    for (const scope of ["operator.read", "operator.talk"]) {
      expect(authorizeOperatorScopesForMethod("talk.voice.preview", [scope])).toMatchObject({
        allowed: false,
      });
    }
    expect(
      authorizeOperatorScopesForMethod("talk.voice.preview", ["operator.write"]),
    ).toMatchObject({ allowed: true });
  });

  it.each(["text", "instructions", "sessionKey", "tools", "apiKey"])(
    "rejects caller-controlled %s before provider access",
    async (field) => {
      const call = start({ provider: "selected", [field]: "untrusted" });
      await call.completed;
      expect(call.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(mocks.resolve).not.toHaveBeenCalled();
    },
  );

  it("returns only the chosen target's PCM and closes its bridge before responding", async () => {
    const call = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.sendUserMessage).toHaveBeenCalledWith("Hello! This is a preview of my voice.");
    expect(request).toMatchObject({
      tools: [],
      audioFormat: { encoding: "pcm16", sampleRateHz: 24000 },
    });
    // Providers that require server VAD reject manual-turn flags. No microphone is sent.
    expect(request.autoRespondToAudio).toBeUndefined();
    expect(request.interruptResponseOnInputAudio).toBeUndefined();
    expect(mocks.resolve.mock.calls[0]?.[0].autoRespondToAudio).toBeUndefined();
    request.onAudio(pcm);
    request.onResponseDone?.({ status: "completed" });
    await call.completed;
    expect(bridge.close).toHaveBeenCalledExactlyOnceWith({ disposition: "abort" });
    expect(call.respond).toHaveBeenCalledWith(
      true,
      {
        provider: "selected",
        model: "test-realtime",
        voice: "ember",
        audioBase64: pcm.toString("base64"),
        sampleRateHz: 24000,
      },
      undefined,
    );
    expect(bridge.setAudioOutputPort).not.toHaveBeenCalled();
    request.onAudio(pcm);
    expect(call.respond).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears both saved voice spellings for explicit provider-default previews", async () => {
    const call = start({ provider: "selected", model: "test-realtime", voice: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        configuredProviderId: "selected",
        providerConfigOverrides: {
          model: "test-realtime",
          voice: undefined,
          speakerVoice: undefined,
          speakerVoiceId: undefined,
        },
      }),
    );
    request.onAudio(pcm);
    request.onResponseDone?.({ status: "completed" });
    await call.completed;
  });

  it("fails unavailable explicit providers without trying another target", async () => {
    mocks.resolve.mockImplementation(() => {
      throw new Error("Selected provider unavailable");
    });
    const call = start();
    await call.completed;
    expect(call.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("Selected provider unavailable"),
      }),
    );
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    expect(createBridge).not.toHaveBeenCalled();
  });

  it("rejects a voice from another model before bridge-local voice fallback can change it", async () => {
    mocks.resolve.mockReturnValue({
      provider: { id: "selected", createBridge, voices: ["ember", "other-model-voice"] },
      providerConfig: { model: "test-realtime", voice: "other-model-voice" },
      capabilities: {
        outputAudioFormats: [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }],
        voicesByModel: { "test-realtime": ["ember"], "other-model": ["other-model-voice"] },
      },
    });
    const call = start({
      provider: "selected",
      model: "test-realtime",
      voice: "other-model-voice",
    });
    await call.completed;
    expect(call.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("did not accept the requested voice"),
      }),
    );
    expect(createBridge).not.toHaveBeenCalled();
  });

  it("accepts case-insensitive canonical voices in the effective model's catalog", async () => {
    mocks.resolve.mockReturnValue({
      provider: { id: "selected", createBridge, voices: ["other-model-voice"] },
      providerConfig: { model: "test-realtime", voice: "Ember" },
      capabilities: {
        outputAudioFormats: [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }],
        voicesByModel: { "test-realtime": ["Ember"] },
      },
    });
    const call = start({ provider: "selected", model: "test-realtime", voice: "EMBER" });
    await vi.advanceTimersByTimeAsync(0);
    request.onAudio(pcm);
    request.onResponseDone?.({ status: "completed" });
    await call.completed;
    expect(call.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ voice: "Ember" }),
      undefined,
    );
  });

  it.each([
    "connect",
    "provider-error",
    "tool",
    "delegation",
    "overflow",
    "odd-pcm",
    "empty",
    "disconnect",
  ])("fails and closes on %s without starting agent work", async (fault) => {
    if (fault === "connect")
      vi.mocked(bridge.connect).mockRejectedValue(new Error("connect failed"));
    const call = start();
    await vi.advanceTimersByTimeAsync(0);
    if (fault === "provider-error") request.onError?.(new Error("provider failed"));
    if (fault === "tool")
      request.onToolCall?.({ itemId: "item", callId: "call", name: "unexpected", args: {} });
    if (fault === "delegation")
      await expect(request.runAgentConsult?.({ prompt: "perform work" })).rejects.toThrow(
        "disabled",
      );
    if (fault === "overflow") request.onAudio(Buffer.alloc(480002));
    if (fault === "odd-pcm") request.onAudio(Buffer.alloc(3));
    if (fault === "empty") request.onResponseDone?.({ status: "completed" });
    if (fault === "disconnect") {
      current = false;
      await vi.advanceTimersByTimeAsync(100);
    }
    await call.completed;
    expect(call.respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(bridge.close).toHaveBeenCalledExactlyOnceWith({ disposition: "abort" });
    expect(bridge.submitToolResult).not.toHaveBeenCalled();
    expect(bridge.sendAudio).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["connect", "audio"])(
    "bounds stalled %s and drains a hung close within 20 seconds",
    async (stage) => {
      if (stage === "connect")
        vi.mocked(bridge.connect).mockReturnValue(new Promise<void>(() => undefined));
      vi.mocked(bridge.close).mockReturnValue(new Promise<void>(() => undefined));
      const call = start();
      await vi.advanceTimersByTimeAsync(18000);
      expect(bridge.close).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2000);
      await call.completed;
      expect(call.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: expect.stringContaining("Voice preview timed out"),
        }),
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("drains continuous provider-port audio past completed markers and finishes only on trailing silence", async () => {
    bridge.outputAudioMode = "continuous";
    const call = start();
    await vi.advanceTimersByTimeAsync(0);
    if (!output) throw new Error("Missing provider audio port");
    output.port.postMessage({ type: "audio", audio: new Uint8Array(48000) });
    request.onResponseDone?.({ status: "completed" });
    await setImmediate();
    output.port.postMessage({ type: "audio", audio: new Uint8Array(pcm) });
    request.onResponseDone?.({ status: "completed" });
    await setImmediate();
    expect(call.respond).not.toHaveBeenCalled();
    output.port.postMessage({ type: "audio", audio: new Uint8Array(36000) });
    await setImmediate();
    await vi.waitFor(() => expect(bridge.close).toHaveBeenCalledTimes(1));
    await call.completed;
    expect(call.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        audioBase64: Buffer.concat([pcm, Buffer.alloc(36000)]).toString("base64"),
      }),
      undefined,
    );
    expect(bridge.close).toHaveBeenCalledTimes(1);
    expect(Atomics.load(new Int32Array(output.state), 0)).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
