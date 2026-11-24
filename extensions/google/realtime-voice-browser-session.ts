import {
  resolveExpiresAtMsFromDurationMs,
  timestampMsToIsoString,
} from "openclaw/plugin-sdk/number-runtime";
import type {
  RealtimeVoiceBrowserSession,
  RealtimeVoiceBrowserSessionCreateRequest,
} from "openclaw/plugin-sdk/realtime-voice";
import { asSafeIntegerInRange } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveGoogleEnvApiKey } from "./gemini-auth.js";
import { createGoogleGenAI } from "./google-genai-runtime.js";
import {
  buildBrowserInitialSetup,
  buildGoogleLiveConnectConfig,
  GOOGLE_REALTIME_DEFAULT_VOICE,
  normalizeProviderConfig,
} from "./realtime-voice-live-config.js";
import { GOOGLE_REALTIME_DEFAULT_MODEL } from "./realtime-voice-metadata.js";

const GOOGLE_REALTIME_INPUT_SAMPLE_RATE = 16_000;
const GOOGLE_REALTIME_BROWSER_API_VERSION = "v1alpha";
const GOOGLE_REALTIME_BROWSER_WEBSOCKET_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";
const GOOGLE_REALTIME_BROWSER_SESSION_TTL_MS = 30 * 60 * 1000;
const GOOGLE_REALTIME_BROWSER_NEW_SESSION_TTL_MS = 60 * 1000;

export async function createGoogleRealtimeBrowserSession(
  req: RealtimeVoiceBrowserSessionCreateRequest,
): Promise<RealtimeVoiceBrowserSession> {
  const providerConfig = normalizeProviderConfig(req.providerConfig);
  const prefixPaddingMs = asSafeIntegerInRange(req.prefixPaddingMs, { min: 0 });
  const silenceDurationMs = asSafeIntegerInRange(req.silenceDurationMs, { min: 0 });
  const config = {
    ...providerConfig,
    ...(prefixPaddingMs !== undefined ? { prefixPaddingMs } : {}),
    ...(silenceDurationMs !== undefined ? { silenceDurationMs } : {}),
  };
  const apiKey = config.apiKey || resolveGoogleEnvApiKey();
  if (!apiKey) {
    throw new Error("Google Gemini API key missing");
  }
  const model = req.model ?? config.model ?? GOOGLE_REALTIME_DEFAULT_MODEL;
  const voice = req.voice ?? config.voice ?? GOOGLE_REALTIME_DEFAULT_VOICE;
  const nowMs = Date.now();
  const expiresAtMs = resolveExpiresAtMsFromDurationMs(GOOGLE_REALTIME_BROWSER_SESSION_TTL_MS, {
    nowMs,
  });
  const newSessionExpiresAtMs = resolveExpiresAtMsFromDurationMs(
    GOOGLE_REALTIME_BROWSER_NEW_SESSION_TTL_MS,
    { nowMs },
  );
  const expireTime = timestampMsToIsoString(expiresAtMs);
  const newSessionExpireTime = timestampMsToIsoString(newSessionExpiresAtMs);
  if (
    expiresAtMs === undefined ||
    newSessionExpiresAtMs === undefined ||
    !expireTime ||
    !newSessionExpireTime
  ) {
    throw new Error("Google realtime browser session expiry is outside the supported Date range");
  }
  const ai = createGoogleGenAI({
    apiKey,
    httpOptions: {
      apiVersion: GOOGLE_REALTIME_BROWSER_API_VERSION,
      timeout: 30_000,
    },
  });
  const token = await ai.authTokens.create({
    config: {
      uses: 1,
      expireTime,
      newSessionExpireTime,
      liveConnectConstraints: {
        model,
        config: buildGoogleLiveConnectConfig(
          {
            ...config,
            apiKey,
            model,
            voice,
            instructions: req.instructions,
            tools: req.tools,
            language: req.language,
          },
          model,
        ),
      },
    },
  });
  const clientSecret = token.name?.trim();
  if (!clientSecret) {
    throw new Error("Google Live browser session did not return an ephemeral token");
  }

  return {
    provider: "google",
    transport: "provider-websocket",
    protocol: "google-live-bidi",
    clientSecret,
    websocketUrl: GOOGLE_REALTIME_BROWSER_WEBSOCKET_URL,
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: GOOGLE_REALTIME_INPUT_SAMPLE_RATE,
      outputEncoding: "pcm16",
      outputSampleRateHz: 24_000,
    },
    initialMessage: buildBrowserInitialSetup(model, req.language),
    model,
    voice,
    expiresAt: newSessionExpiresAtMs,
  };
}
