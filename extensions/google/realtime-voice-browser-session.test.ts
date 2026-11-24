import { type RealtimeVoiceTool } from "openclaw/plugin-sdk/realtime-voice";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildThinkingConfig } from "./realtime-voice-model-contract.js";
import { buildGoogleRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const CONSULT = "openclaw_agent_consult";

const EXTENDED = "gemini-3.8-live-extended-thinking";

type MockGoogleLiveConnectParams = {
  model: string;
  config: Record<string, unknown>;
  callbacks: {
    onopen: () => void;
    onmessage: (message: Record<string, unknown>) => void;
    onerror: (event: { error?: unknown; message?: string }) => void;
    onclose: (event?: { code?: number; reason?: string; wasClean?: boolean }) => void;
  };
};
const { createGoogleGenAIMock, createTokenMock, connectMock } = vi.hoisted(() => {
  const liveSession = {
    close: vi.fn(),
    sendClientContent: vi.fn(),
    sendRealtimeInput: vi.fn(),
    sendToolResponse: vi.fn(),
  };
  const connect = vi.fn(async (_params: MockGoogleLiveConnectParams) => liveSession);
  const createToken = vi.fn(async (_params: unknown) => ({
    name: "auth_tokens/browser-session",
  }));
  return {
    session: liveSession,
    connectMock: connect,
    createTokenMock: createToken,
    createGoogleGenAIMock: vi.fn(() => ({
      authTokens: { create: createToken },
      live: { connect },
    })),
  };
});
vi.mock("./google-genai-runtime.js", () => ({ createGoogleGenAI: createGoogleGenAIMock }));

function requireFirstMockArg(mock: ReturnType<typeof vi.fn>, label: string): unknown {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call[0];
}

function createRealtimeTool(name: string): RealtimeVoiceTool {
  return {
    type: "function",
    name,
    description: "Contract test tool",
    parameters: { type: "object", properties: {} },
  };
}
function createRealtimeToolDeclaration(name: string) {
  return {
    name,
    description: "Contract test tool",
    parameters: { type: "object", properties: {} },
  };
}

type GoogleLiveBridgeParams = Parameters<
  ReturnType<typeof buildGoogleRealtimeVoiceProvider>["createBridge"]
>[0];

function createGoogleLiveBridge(params: Partial<GoogleLiveBridgeParams> = {}) {
  const { providerConfig, ...callbacks } = params;
  return buildGoogleRealtimeVoiceProvider().createBridge({
    providerConfig: { apiKey: "gemini-key", ...providerConfig },
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
    ...callbacks,
  });
}
function lastConnectParams() {
  const params = connectMock.mock.calls.at(-1)?.[0];
  if (!params) throw new Error("Expected Google Live connect call");
  return params;
}

describe("buildGoogleRealtimeVoiceProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.stubEnv("GEMINI_API_KEY", undefined);
    vi.stubEnv("GOOGLE_API_KEY", undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(() => {
    vi.doUnmock("./google-genai-runtime.js");
    vi.resetModules();
  });

  it("mints a single-use constrained browser token with the Talk admission expiry", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 1, 12, 34, 56, 789);
    vi.setSystemTime(now);
    const result = await buildGoogleRealtimeVoiceProvider().createBrowserSession?.({
      providerConfig: {
        apiKey: "gemini-key",
        model: "gemini-live-2.5-flash-preview",
        voice: "Puck",
        temperature: 0.4,
        prefixPaddingMs: 100,
        silenceDurationMs: 300,
      },
      prefixPaddingMs: 250,
      silenceDurationMs: 650,
      instructions: "Speak briefly.",
      tools: [createRealtimeTool(CONSULT)],
    });
    expect(createGoogleGenAIMock).toHaveBeenCalledWith({
      apiKey: "gemini-key",
      httpOptions: { apiVersion: "v1alpha", timeout: 30_000 },
    });
    expect(createTokenMock).toHaveBeenCalledExactlyOnceWith({
      config: {
        uses: 1,
        expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
        liveConnectConstraints: {
          model: "gemini-live-2.5-flash-preview",
          config: expect.objectContaining({
            temperature: 0.4,
            systemInstruction: "Speak briefly.",
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } },
            realtimeInputConfig: {
              automaticActivityDetection: { prefixPaddingMs: 250, silenceDurationMs: 650 },
            },
            tools: [
              {
                functionDeclarations: [
                  { ...createRealtimeToolDeclaration(CONSULT), behavior: "NON_BLOCKING" },
                ],
              },
            ],
          }),
        },
      },
    });
    expect(result).toMatchObject({
      transport: "provider-websocket",
      protocol: "google-live-bidi",
      clientSecret: "auth_tokens/browser-session",
      expiresAt: now + 60_000,
      initialMessage: { setup: { model: "models/gemini-live-2.5-flash-preview" } },
    });
  });

  it("omits adaptive thinking budgets for Gemini 3.1 Live", async () => {
    const bridge = createGoogleLiveBridge({ providerConfig: { thinkingBudget: -1 } });
    try {
      await bridge.connect();
      expect(lastConnectParams().config).not.toHaveProperty("thinkingConfig");
    } finally {
      await bridge.close();
    }
  });

  it("applies the requested transcription language hint to Google Live sessions", async () => {
    const bridge = createGoogleLiveBridge({ language: "en" });
    try {
      await bridge.connect();
      expect(lastConnectParams().config.inputAudioTranscription).toEqual({
        languageCodes: ["en-US"],
      });
    } finally {
      await bridge.close();
    }
  });

  it("creates constrained browser sessions for Google Live Talk", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 1, 12, 34, 56, 789);
    vi.setSystemTime(now);
    const provider = buildGoogleRealtimeVoiceProvider();

    const sessionLocal = await provider.createBrowserSession?.({
      providerConfig: {
        apiKey: "gemini-key",
        model: "gemini-live-2.5-flash-preview",
        voice: "Puck",
        temperature: 0.4,
        prefixPaddingMs: 100,
        silenceDurationMs: 300,
      },
      prefixPaddingMs: 250,
      silenceDurationMs: 650,
      language: "en",
      instructions: "Speak briefly.",
      // The browser session must declare the consult question parameter the
      // model needs to invoke the tool; a bare properties:{} contract cannot
      // carry the delegation (mirrors the shared consult descriptor).
      tools: [
        {
          ...createRealtimeTool(CONSULT),
          parameters: {
            type: "object",
            properties: { question: { type: "string" } },
            required: ["question"],
          },
        },
      ],
    });
    expect(createGoogleGenAIMock).toHaveBeenCalledWith({
      apiKey: "gemini-key",
      httpOptions: { apiVersion: "v1alpha", timeout: 30_000 },
    });
    expect(createTokenMock).toHaveBeenCalledExactlyOnceWith({
      config: {
        uses: 1,
        expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
        liveConnectConstraints: {
          model: "gemini-live-2.5-flash-preview",
          config: expect.objectContaining({
            temperature: 0.4,
            systemInstruction: "Speak briefly.",
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } },
            realtimeInputConfig: {
              automaticActivityDetection: { prefixPaddingMs: 250, silenceDurationMs: 650 },
            },
            tools: [
              {
                functionDeclarations: [
                  {
                    ...createRealtimeToolDeclaration(CONSULT),
                    parameters: {
                      type: "object",
                      properties: { question: { type: "string" } },
                      required: ["question"],
                    },
                    behavior: "NON_BLOCKING",
                  },
                ],
              },
            ],
          }),
        },
      },
    });

    expect(createTokenMock).toHaveBeenCalledTimes(1);
    const tokenConfig = requireFirstMockArg(createTokenMock, "Google Live auth token config") as {
      config?: {
        liveConnectConstraints?: {
          config?: {
            realtimeInputConfig?: {
              automaticActivityDetection?: {
                prefixPaddingMs?: number;
                silenceDurationMs?: number;
              };
            };
            inputAudioTranscription?: { languageCodes?: string[] };
            responseModalities?: string[];
            speechConfig?: { voiceConfig?: { prebuiltVoiceConfig?: { voiceName?: string } } };
            systemInstruction?: string;
            temperature?: number;
            tools?: Array<{
              functionDeclarations?: Array<{
                behavior?: string;
                name?: string;
                parameters?: unknown;
                parametersJsonSchema?: unknown;
              }>;
            }>;
          };
          model?: string;
        };
        uses?: number;
      };
    };
    const liveConstraints = tokenConfig.config?.liveConnectConstraints;
    expect(tokenConfig.config?.uses).toBe(1);
    expect(liveConstraints?.model).toBe("gemini-live-2.5-flash-preview");
    expect(liveConstraints?.config?.responseModalities).toEqual(["AUDIO"]);
    expect(liveConstraints?.config?.inputAudioTranscription).toEqual({
      languageCodes: ["en-US"],
    });
    expect(liveConstraints?.config?.temperature).toBe(0.4);
    expect(liveConstraints?.config?.systemInstruction).toBe("Speak briefly.");
    expect(
      liveConstraints?.config?.realtimeInputConfig?.automaticActivityDetection?.prefixPaddingMs,
    ).toBe(250);
    expect(
      liveConstraints?.config?.realtimeInputConfig?.automaticActivityDetection?.silenceDurationMs,
    ).toBe(650);
    expect(liveConstraints?.config?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName).toBe(
      "Puck",
    );
    const declaration = liveConstraints?.config?.tools?.[0]?.functionDeclarations?.[0];
    expect(declaration?.name).toBe("openclaw_agent_consult");
    expect(declaration?.behavior).toBe("NON_BLOCKING");
    expect(declaration?.parameters).toEqual({
      type: "object",
      properties: {
        question: { type: "string" },
      },
      required: ["question"],
    });
    expect(declaration?.parametersJsonSchema).toBeUndefined();
    expect(sessionLocal?.provider).toBe("google");
    expect(sessionLocal?.transport).toBe("provider-websocket");
    const websocketSession = sessionLocal as {
      audio: {
        inputEncoding: string;
        inputSampleRateHz: number;
        outputEncoding: string;
        outputSampleRateHz: number;
      };
      clientSecret: string;
      initialMessage: {
        setup: {
          generationConfig: { responseModalities: string[] };
          inputAudioTranscription?: { languageCodes?: string[] };
          model: string;
        };
      };
      protocol: string;
      websocketUrl: string;
    };
    expect(websocketSession.protocol).toBe("google-live-bidi");
    expect(websocketSession.clientSecret).toBe("auth_tokens/browser-session");
    expect(websocketSession.websocketUrl).toBe(
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
    );
    expect(websocketSession.audio.inputEncoding).toBe("pcm16");
    expect(websocketSession.audio.inputSampleRateHz).toBe(16000);
    expect(websocketSession.audio.outputEncoding).toBe("pcm16");
    expect(websocketSession.audio.outputSampleRateHz).toBe(24000);
    expect(websocketSession.initialMessage.setup.model).toBe(
      "models/gemini-live-2.5-flash-preview",
    );
    expect(websocketSession.initialMessage.setup.generationConfig.responseModalities).toEqual([
      "AUDIO",
    ]);
    expect(websocketSession.initialMessage.setup.inputAudioTranscription).toEqual({
      languageCodes: ["en-US"],
    });
  });

  it("returns browser expiry in the epoch milliseconds required by the Talk gateway", async () => {
    vi.useFakeTimers();
    const nowMs = Date.UTC(2026, 7, 1, 12, 34, 56, 789);
    vi.setSystemTime(nowMs);
    const provider = buildGoogleRealtimeVoiceProvider();

    const sessionLocal = await provider.createBrowserSession?.({
      providerConfig: { apiKey: "gemini-key" },
    });

    const tokenConfig = requireFirstMockArg(createTokenMock, "Google Live auth token config") as {
      config?: {
        expireTime?: string;
        newSessionExpireTime?: string;
      };
    };
    expect(tokenConfig.config?.expireTime).toBe(new Date(nowMs + 30 * 60 * 1000).toISOString());
    expect(tokenConfig.config?.newSessionExpireTime).toBe(
      new Date(nowMs + 60 * 1000).toISOString(),
    );
    expect(sessionLocal?.expiresAt).toBeGreaterThan(nowMs + 5_000);
    vi.advanceTimersByTime(60_001);
    expect(sessionLocal?.expiresAt).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(sessionLocal?.expiresAt).toBe(nowMs + 60 * 1000);
  });

  it("constrains default browser sessions to Gemini 3.1 capabilities", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();

    const sessionLocal = await provider.createBrowserSession?.({
      providerConfig: {
        apiKey: "gemini-key",
        enableAffectiveDialog: true,
        thinkingLevel: "low",
        thinkingBudget: 8_193,
      },
      tools: [createRealtimeTool("openclaw_agent_consult")],
    });

    const tokenConfig = requireFirstMockArg(createTokenMock, "Google Live auth token config") as {
      config?: {
        liveConnectConstraints?: {
          config?: {
            enableAffectiveDialog?: boolean;
            thinkingConfig?: unknown;
            tools?: Array<{
              functionDeclarations?: Array<{ behavior?: string; name?: string }>;
            }>;
          };
          model?: string;
        };
      };
    };
    const constraints = tokenConfig.config?.liveConnectConstraints;
    expect(constraints?.model).toBe("gemini-3.1-flash-live-preview");
    expect(constraints?.config?.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
    expect(constraints?.config).not.toHaveProperty("enableAffectiveDialog");
    expect(constraints?.config?.tools?.[0]?.functionDeclarations?.[0]).toMatchObject({
      name: "openclaw_agent_consult",
    });
    expect(constraints?.config?.tools?.[0]?.functionDeclarations?.[0]).not.toHaveProperty(
      "behavior",
    );
    expect(sessionLocal?.model).toBe("gemini-3.1-flash-live-preview");
  });

  it("creates browser-token clients with a finite request timeout", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    await provider.createBrowserSession?.({
      providerConfig: { apiKey: "test" },
    });

    const clientConfig = requireFirstMockArg(createGoogleGenAIMock, "GoogleGenAI config") as {
      httpOptions?: {
        apiVersion?: string;
        timeout?: number;
      };
    };
    expect(clientConfig.httpOptions).toMatchObject({
      apiVersion: "v1alpha",
      timeout: 30_000,
    });
  });

  it.each([8_640_000_000_000_001, 8_640_000_000_000_000 - 60_000, Number.NaN, Infinity])(
    "rejects invalid browser expiry from %s before creating a client or minting a token",
    async (nowMs) => {
      vi.spyOn(Date, "now").mockReturnValue(nowMs);
      await expect(
        buildGoogleRealtimeVoiceProvider().createBrowserSession?.({
          providerConfig: { apiKey: "gemini-key" },
        }),
      ).rejects.toThrow(
        "Google realtime browser session expiry is outside the supported Date range",
      );
      expect(createGoogleGenAIMock).not.toHaveBeenCalled();
      expect(createTokenMock).not.toHaveBeenCalled();
    },
  );

  it("builds thinking config per model family", () => {
    expect(buildThinkingConfig({}, EXTENDED)).toBeUndefined();
    expect(buildThinkingConfig({ thinkingLevel: "minimal" }, EXTENDED)).toEqual({
      thinkingLevel: "LOW",
    });
    expect(buildThinkingConfig({ thinkingBudget: 4_096 }, EXTENDED)).toEqual({
      thinkingLevel: "MEDIUM",
    });
    expect(buildThinkingConfig({ thinkingBudget: -1 }, EXTENDED)).toBeUndefined();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
