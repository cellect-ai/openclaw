import type {
  OpenAICompatibleRealtimeAudioFormat,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderConfig,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  normalizeResolvedSecretInputString,
  resolveSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import {
  asFiniteNumberInRange,
  asOptionalObjectRecord as readXaiObjectRecord,
  asSafeIntegerInRange,
  normalizeOptionalString,
  parseBooleanValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { XAI_BASE_URL } from "./model-definitions.js";

type XaiRealtimeVoice = "eve" | "ara" | "rex" | "sal" | "leo";
type XaiRealtimeReasoningEffort = "high" | "none";

type XaiRealtimeVoiceProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  voice?: string;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  interruptResponseOnInputAudio?: boolean;
  reasoningEffort?: XaiRealtimeReasoningEffort;
  sessionResumption?: boolean;
};

export type XaiRealtimeVoiceBridgeConfig = RealtimeVoiceBridgeCreateRequest & {
  apiKey?: string;
  baseUrl: string;
  model?: string;
  voice?: string;
  providerId?: string;
  providerLabel?: string;
  supportsServerVadAssistantAudioTruncation?: boolean;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  reasoningEffort?: XaiRealtimeReasoningEffort;
  sessionResumption?: boolean;
  resolveApiKey?: () => Promise<string>;
};

type XaiRealtimeResponseItem = {
  id?: string;
  type?: string;
  status?: "completed" | "incomplete" | "in_progress";
  role?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string; transcript?: string }>;
};

export type XaiRealtimeEvent = {
  type: string;
  delta?: string;
  data?: string;
  text?: string;
  transcript?: string;
  item_id?: string;
  response_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  response?: {
    id?: string;
    status?: string;
    status_details?: unknown;
    output?: XaiRealtimeResponseItem[];
  };
  conversation?: { id?: string };
  item?: XaiRealtimeResponseItem;
  error?: unknown;
};

export type XaiRealtimeSessionUpdate = {
  type: "session.update";
  session: {
    instructions?: string;
    voice?: string;
    output_modalities?: string[];
    turn_detection?: {
      type: "server_vad";
      threshold?: number;
      prefix_padding_ms?: number;
      silence_duration_ms?: number;
    };
    audio: {
      input: {
        format: OpenAICompatibleRealtimeAudioFormat;
        transcription: { model: string; language_hint?: string };
      };
      output: {
        format: OpenAICompatibleRealtimeAudioFormat;
        transcription?: Record<string, never>;
      };
    };
    reasoning?: { effort: XaiRealtimeReasoningEffort };
    resumption?: { enabled: boolean };
    tools?: RealtimeVoiceBridgeCreateRequest["tools"];
    tool_choice?: string;
  };
};

export const XAI_REALTIME_DEFAULT_MODEL = "grok-voice-latest";
export const LITELLM_REALTIME_VOICE_MODELS = [
  "grok-voice-think-fast-2.0",
  "gemini-3.8-live",
] as const;
export const LITELLM_REALTIME_BASE_URL = "http://192.168.5.139:4000/v1";
export const XAI_REALTIME_CONNECT_TIMEOUT_MS = 10_000;
export const XAI_REALTIME_WS_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const XAI_REALTIME_MAX_RECONNECT_ATTEMPTS = 5;
export const XAI_REALTIME_BASE_RECONNECT_DELAY_MS = 1000;
export const XAI_REALTIME_MAX_PENDING_TOOL_RESULTS = 128;
export const XAI_REALTIME_MAX_PENDING_USER_MESSAGES = 128;
export const XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS = 1_024;
export const XAI_REALTIME_DEFAULT_VAD_THRESHOLD = 0.85;
export const XAI_REALTIME_DEFAULT_PREFIX_PADDING_MS = 333;
export const XAI_REALTIME_DEFAULT_SILENCE_DURATION_MS = 500;
export const XAI_REALTIME_INPUT_TRANSCRIPTION_MODEL = "grok-transcribe";
export const XAI_REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX =
  "Conversation already has an active response in progress:";
export const XAI_REALTIME_NO_ACTIVE_RESPONSE_CANCEL_ERROR =
  "Cancellation failed: no active response found";

export const XAI_REALTIME_VOICES = [
  "eve",
  "ara",
  "rex",
  "sal",
  "leo",
] as const satisfies readonly XaiRealtimeVoice[];

// Native-audio Live uses Google's prebuilt TTS voices, with case-sensitive names.
// https://ai.google.dev/gemini-api/docs/speech-generation#voice-options
export const GOOGLE_REALTIME_VOICES = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat",
] as const;

export function serializeXaiRealtimeToolResult(result: unknown): string {
  const message = "xAI realtime voice tool result is not JSON-serializable";
  try {
    const serialized = JSON.stringify(result);
    if (typeof serialized === "string") {
      return serialized;
    }
  } catch (cause) {
    throw new Error(message, { cause });
  }
  throw new Error(message);
}

function readNestedXaiConfig(rawConfig: RealtimeVoiceProviderConfig, providerId = "xai") {
  const raw = readXaiObjectRecord(rawConfig);
  const providers = readXaiObjectRecord(raw?.providers);
  return readXaiObjectRecord(providers?.[providerId] ?? raw?.[providerId] ?? raw) ?? {};
}

export function normalizeXaiRealtimeBaseUrl(value?: string): string {
  return normalizeOptionalString(value ?? process.env.XAI_BASE_URL) ?? XAI_BASE_URL;
}

function normalizeXaiRealtimeVoice(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const lower = normalized.toLowerCase();
  return XAI_REALTIME_VOICES.includes(lower as XaiRealtimeVoice)
    ? (lower as XaiRealtimeVoice)
    : normalized;
}

function asXaiVadThreshold(value: unknown): number | undefined {
  return asFiniteNumberInRange(value, { min: 0.1, max: 0.9 });
}

function asXaiDurationMs(value: unknown): number | undefined {
  return asSafeIntegerInRange(value, { min: 0, max: 10_000 });
}

function asXaiReasoningEffort(value: unknown): XaiRealtimeReasoningEffort | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  if (normalized === "high" || normalized === "none") {
    return normalized;
  }
  throw new Error('xAI realtime voice reasoningEffort must be "high" or "none"');
}

export function normalizeXaiRealtimeProviderConfig(
  config: RealtimeVoiceProviderConfig,
  providerId = "xai",
): XaiRealtimeVoiceProviderConfig {
  const raw = readNestedXaiConfig(config, providerId);
  const apiKeyPath = `talk.realtime.providers.${providerId}.apiKey`;
  // OpenClaw deliberately leaves SecretRefs for non-selected Talk providers
  // unresolved in the active runtime snapshot. LiteLLM's credential is still
  // available to the gateway process from its role-scoped environment, so
  // cataloging this selectable provider must not strictly read the inactive
  // SecretRef. At connection time resolveLiteLlmRealtimeApiKey uses that
  // gateway-only environment value; active/resolved refs continue to win.
  const apiKey =
    providerId === "litellm"
      ? resolveSecretInputString({
          value: raw.apiKey,
          path: apiKeyPath,
          mode: "inspect",
        }).value
      : normalizeResolvedSecretInputString({ value: raw.apiKey, path: apiKeyPath });
  return {
    apiKey,
    baseUrl: normalizeOptionalString(raw.baseUrl),
    model: normalizeOptionalString(raw.model),
    voice: normalizeXaiRealtimeVoice(raw.speakerVoice ?? raw.voice),
    vadThreshold: asXaiVadThreshold(raw.vadThreshold),
    silenceDurationMs: asXaiDurationMs(raw.silenceDurationMs),
    prefixPaddingMs: asXaiDurationMs(raw.prefixPaddingMs),
    interruptResponseOnInputAudio: parseBooleanValue(raw.interruptResponseOnInputAudio),
    reasoningEffort: asXaiReasoningEffort(raw.reasoningEffort),
    sessionResumption: parseBooleanValue(raw.sessionResumption),
  };
}

export function readXaiRealtimeErrorDetail(
  error: unknown,
  providerLabel = "xAI realtime voice",
): string {
  if (typeof error === "string" && error) {
    return error;
  }
  const record = readXaiObjectRecord(error);
  return (
    normalizeOptionalString(record?.message) ??
    normalizeOptionalString(record?.code) ??
    `${providerLabel} error`
  );
}

export function toXaiRealtimeWsUrl(
  baseUrl: string,
  model: string,
  conversationId?: string,
): string {
  const url = new URL(normalizeXaiRealtimeBaseUrl(baseUrl));
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/realtime`;
  url.searchParams.set("model", model);
  if (conversationId) {
    url.searchParams.set("conversation_id", conversationId);
  }
  return url.toString();
}
