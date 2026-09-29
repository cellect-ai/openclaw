import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  assertLiteLlmRealtimeVoiceRequestSupported,
  assertXaiRealtimeVoiceRequestSupported,
  createLiteLlmRealtimeVoiceProviderMetadata,
  createXaiRealtimeVoiceProviderMetadata,
} from "./capability-provider-metadata.js";
import { resolveXaiRealtimeApiKey } from "./realtime-voice-auth.runtime.js";
import { XaiRealtimeVoiceBridge } from "./realtime-voice-bridge.js";
import { attachLiteLlmRealtimeVoiceCapabilities } from "./realtime-voice-capabilities.js";
import {
  GOOGLE_REALTIME_VOICES,
  LITELLM_REALTIME_BASE_URL,
  LITELLM_REALTIME_VOICE_MODELS,
  XAI_REALTIME_VOICES,
  normalizeXaiRealtimeBaseUrl,
  normalizeXaiRealtimeProviderConfig,
} from "./realtime-voice-config.js";

function resolveLiteLlmRealtimeApiKey(configuredApiKey?: string): string {
  const apiKey =
    normalizeOptionalString(configuredApiKey) ??
    normalizeOptionalString(process.env.FI_USER_LITELLM_API_KEY);
  if (!apiKey) {
    throw new Error("LiteLLM realtime credentials missing; configure FI_USER_LITELLM_API_KEY");
  }
  return apiKey;
}

const GENERIC_REALTIME_VOICES = new Set([
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "marin",
  "sage",
  "shimmer",
  "verse",
]);

function resolveLiteLlmVoice(model: string, configuredVoice?: string): string {
  const isGeminiLive = model.startsWith("gemini-");
  const voice = normalizeOptionalString(configuredVoice);
  if (!voice) {
    return isGeminiLive ? "Kore" : "eve";
  }
  const normalized = voice.toLowerCase();
  const googleVoice = GOOGLE_REALTIME_VOICES.find((name) => name.toLowerCase() === normalized);
  if (isGeminiLive && googleVoice) {
    return googleVoice;
  }
  const conflictsWithSelectedModel = isGeminiLive
    ? XAI_REALTIME_VOICES.includes(normalized as (typeof XAI_REALTIME_VOICES)[number]) ||
      GENERIC_REALTIME_VOICES.has(normalized)
    : GENERIC_REALTIME_VOICES.has(normalized) || googleVoice !== undefined;
  if (conflictsWithSelectedModel) {
    return isGeminiLive ? "Kore" : "eve";
  }
  return voice;
}

export function buildXaiRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    ...createXaiRealtimeVoiceProviderMetadata(),
    createBridge: (req) => {
      const config = normalizeXaiRealtimeProviderConfig(req.providerConfig);
      assertXaiRealtimeVoiceRequestSupported(req);
      return new XaiRealtimeVoiceBridge({
        ...req,
        apiKey: config.apiKey,
        baseUrl: normalizeXaiRealtimeBaseUrl(config.baseUrl),
        model: config.model,
        voice: config.voice,
        vadThreshold: config.vadThreshold,
        silenceDurationMs: config.silenceDurationMs,
        prefixPaddingMs: config.prefixPaddingMs,
        reasoningEffort: config.reasoningEffort,
        sessionResumption: config.sessionResumption,
        resolveApiKey: () => resolveXaiRealtimeApiKey(config.apiKey, req.cfg, req.agentId),
      });
    },
  };
}

export function buildLiteLlmRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  const provider: RealtimeVoiceProviderPlugin = {
    ...createLiteLlmRealtimeVoiceProviderMetadata(),
    createBridge: (req) => {
      const config = normalizeXaiRealtimeProviderConfig(req.providerConfig, "litellm");
      assertLiteLlmRealtimeVoiceRequestSupported(req, config.interruptResponseOnInputAudio);
      const model = config.model ?? LITELLM_REALTIME_VOICE_MODELS[0];
      if (
        !LITELLM_REALTIME_VOICE_MODELS.includes(
          model as (typeof LITELLM_REALTIME_VOICE_MODELS)[number],
        )
      ) {
        throw new Error(`Unsupported LiteLLM realtime voice model: ${model}`);
      }
      const baseUrl = normalizeOptionalString(config.baseUrl) ?? LITELLM_REALTIME_BASE_URL;
      if (baseUrl !== LITELLM_REALTIME_BASE_URL) {
        throw new Error(`LiteLLM realtime baseUrl must be ${LITELLM_REALTIME_BASE_URL}`);
      }
      return new XaiRealtimeVoiceBridge({
        ...req,
        apiKey: config.apiKey,
        baseUrl,
        model,
        // The shared Talk setting may still contain another provider's voice.
        voice: resolveLiteLlmVoice(model, config.voice),
        providerId: "litellm",
        providerLabel: "LiteLLM realtime voice",
        supportsServerVadAssistantAudioTruncation: !model.startsWith("gemini-"),
        vadThreshold: config.vadThreshold,
        silenceDurationMs: config.silenceDurationMs,
        prefixPaddingMs: config.prefixPaddingMs,
        // LiteLLM's realtime route does not expose either vendor's session-resume
        // or reasoning extension fields.
        sessionResumption: false,
        reasoningEffort: undefined,
        resolveApiKey: async () => resolveLiteLlmRealtimeApiKey(config.apiKey),
      });
    },
  };
  return attachLiteLlmRealtimeVoiceCapabilities(provider);
}
