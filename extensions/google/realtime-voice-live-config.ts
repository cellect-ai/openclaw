import {
  ActivityHandling,
  Behavior,
  EndSensitivity,
  type FunctionDeclaration,
  type LiveConnectConfig,
  type LiveServerContent,
  Modality,
  type RealtimeInputConfig,
  StartSensitivity,
  TurnCoverage,
} from "@google/genai";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import type {
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceTool,
} from "openclaw/plugin-sdk/realtime-voice";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "openclaw/plugin-sdk/realtime-voice-provider";
import { warn } from "openclaw/plugin-sdk/runtime-env";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  asBoolean,
  asFiniteNumber,
  asOptionalRecord,
  asSafeIntegerInRange,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildThinkingConfig,
  isGemini31LiveModel,
  supportsAsyncFunctionCalling,
} from "./realtime-voice-model-contract.js";

export const GOOGLE_REALTIME_DEFAULT_VOICE = "Kore";

export const GOOGLE_REALTIME_TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;

export type GoogleRealtimeSensitivity = "low" | "high";

export type GoogleRealtimeThinkingLevel = "minimal" | "low" | "medium" | "high";

export type GoogleRealtimeActivityHandling = "start-of-activity-interrupts" | "no-interruption";

export type GoogleRealtimeTurnCoverage =
  | "only-activity"
  | "all-input"
  | "audio-activity-and-all-video";

export const START_SENSITIVITY = {
  high: StartSensitivity.START_SENSITIVITY_HIGH,
  low: StartSensitivity.START_SENSITIVITY_LOW,
} satisfies Record<GoogleRealtimeSensitivity, StartSensitivity>;

export const END_SENSITIVITY = {
  high: EndSensitivity.END_SENSITIVITY_HIGH,
  low: EndSensitivity.END_SENSITIVITY_LOW,
} satisfies Record<GoogleRealtimeSensitivity, EndSensitivity>;

export const ACTIVITY_HANDLING = {
  "start-of-activity-interrupts": ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
  "no-interruption": ActivityHandling.NO_INTERRUPTION,
} satisfies Record<GoogleRealtimeActivityHandling, ActivityHandling>;

export const TURN_COVERAGE = {
  "only-activity": TurnCoverage.TURN_INCLUDES_ONLY_ACTIVITY,
  "all-input": TurnCoverage.TURN_INCLUDES_ALL_INPUT,
  "audio-activity-and-all-video": TurnCoverage.TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO,
} satisfies Record<GoogleRealtimeTurnCoverage, TurnCoverage>;

export type GoogleRealtimeVoiceProviderConfig = Partial<ReturnType<typeof normalizeProviderConfig>>;

export type GoogleRealtimeLiveConfig = GoogleRealtimeVoiceProviderConfig & {
  apiKey: string;
  instructions?: string;
  language?: string;
  tools?: RealtimeVoiceTool[];
};

export type GoogleRealtimeVoiceBridgeConfig = RealtimeVoiceBridgeCreateRequest &
  GoogleRealtimeLiveConfig;

export type GoogleLiveTranscription = NonNullable<LiveServerContent["inputTranscription"]>;

export type GoogleLiveTranscriptAccumulator = {
  text: string;
  byteCount: number;
};

export function normalizeGoogleTranscriptionLanguage(value: unknown): string | undefined {
  const language = normalizeOptionalString(value)?.replaceAll("_", "-");
  if (!language) {
    return undefined;
  }
  // Google Live documents language hints as BCP-47. The shared UI's English
  // default is intentionally provider-neutral (`en`); use an explicit locale
  // for Live's transcription configuration.
  return language.toLowerCase() === "en" ? "en-US" : language;
}

export function buildGoogleInputAudioTranscription(language?: string) {
  const normalizedLanguage = normalizeGoogleTranscriptionLanguage(language);
  return normalizedLanguage ? { languageCodes: [normalizedLanguage] } : {};
}

export function asSensitivity(value: unknown): GoogleRealtimeSensitivity | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  return normalized === "low" || normalized === "high" ? normalized : undefined;
}

export function asThinkingLevel(value: unknown): GoogleRealtimeThinkingLevel | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  return normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high"
    ? normalized
    : undefined;
}

export function asActivityHandling(value: unknown): GoogleRealtimeActivityHandling | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase().replaceAll("_", "-");
  switch (normalized) {
    case "start-of-activity-interrupts":
    case "start-of-activity-interrupt":
    case "interrupt":
    case "interrupts":
      return "start-of-activity-interrupts";
    case "no-interruption":
    case "no-interruptions":
    case "none":
      return "no-interruption";
    default:
      return undefined;
  }
}

export function asTurnCoverage(value: unknown): GoogleRealtimeTurnCoverage | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase().replaceAll("_", "-");
  switch (normalized) {
    case "only-activity":
    case "turn-includes-only-activity":
      return "only-activity";
    case "all-input":
    case "turn-includes-all-input":
      return "all-input";
    case "audio-activity-and-all-video":
    case "turn-includes-audio-activity-and-all-video":
      return "audio-activity-and-all-video";
    default:
      return undefined;
  }
}

export function normalizeProviderConfig(config: RealtimeVoiceProviderConfig, cfg?: OpenClawConfig) {
  const providers = asOptionalRecord(config.providers);
  const raw = asOptionalRecord(providers?.google) ?? asOptionalRecord(config.google) ?? config;
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw.apiKey ?? cfg?.models?.providers?.google?.apiKey,
      path: "plugins.entries.voice-call.config.realtime.providers.google.apiKey",
    }),
    model: normalizeOptionalString(raw.model),
    voice: normalizeOptionalString(raw.speakerVoice) ?? normalizeOptionalString(raw.voice),
    temperature: asFiniteNumber(raw.temperature),
    apiVersion: normalizeOptionalString(raw.apiVersion),
    prefixPaddingMs: asSafeIntegerInRange(raw.prefixPaddingMs, { min: 0 }),
    silenceDurationMs: asSafeIntegerInRange(raw.silenceDurationMs, { min: 0 }),
    startSensitivity: asSensitivity(raw.startSensitivity),
    endSensitivity: asSensitivity(raw.endSensitivity),
    activityHandling: asActivityHandling(raw.activityHandling),
    turnCoverage: asTurnCoverage(raw.turnCoverage),
    automaticActivityDetectionDisabled: asBoolean(raw.automaticActivityDetectionDisabled),
    enableAffectiveDialog: asBoolean(raw.enableAffectiveDialog),
    sessionResumption: asBoolean(raw.sessionResumption),
    contextWindowCompression: asBoolean(raw.contextWindowCompression),
    thinkingLevel: asThinkingLevel(raw.thinkingLevel),
    thinkingBudget: asSafeIntegerInRange(raw.thinkingBudget, { min: -1, max: 24_576 }),
  };
}

export function buildRealtimeInputConfig(
  config: GoogleRealtimeLiveConfig,
): RealtimeInputConfig | undefined {
  const startSensitivity = config.startSensitivity
    ? START_SENSITIVITY[config.startSensitivity]
    : undefined;
  const endSensitivity = config.endSensitivity ? END_SENSITIVITY[config.endSensitivity] : undefined;
  const activityHandling = config.activityHandling
    ? ACTIVITY_HANDLING[config.activityHandling]
    : undefined;
  const turnCoverage = config.turnCoverage ? TURN_COVERAGE[config.turnCoverage] : undefined;
  const automaticActivityDetection = {
    ...(config.automaticActivityDetectionDisabled !== undefined
      ? { disabled: config.automaticActivityDetectionDisabled }
      : {}),
    ...(startSensitivity ? { startOfSpeechSensitivity: startSensitivity } : {}),
    ...(endSensitivity ? { endOfSpeechSensitivity: endSensitivity } : {}),
    ...(config.prefixPaddingMs !== undefined ? { prefixPaddingMs: config.prefixPaddingMs } : {}),
    ...(config.silenceDurationMs !== undefined
      ? { silenceDurationMs: config.silenceDurationMs }
      : {}),
  };
  const realtimeInputConfig = {
    ...(Object.keys(automaticActivityDetection).length > 0 ? { automaticActivityDetection } : {}),
    ...(activityHandling ? { activityHandling } : {}),
    ...(turnCoverage ? { turnCoverage } : {}),
  };
  return Object.keys(realtimeInputConfig).length > 0 ? realtimeInputConfig : undefined;
}

export function buildFunctionDeclarations(
  tools: RealtimeVoiceTool[] | undefined,
  allowNonBlocking: boolean,
): FunctionDeclaration[] {
  const declarations: FunctionDeclaration[] = [];
  let omitted = 0;
  for (const tool of tools ?? []) {
    try {
      const name = tool.name;
      if (typeof name !== "string" || !GOOGLE_REALTIME_TOOL_NAME_RE.test(name)) {
        omitted += 1;
        continue;
      }
      // Live preview models honor the OpenAPI `parameters` field; the SDK normalizes
      // our lowercase JSON Schema types before sending the mutually exclusive field.
      const declaration: FunctionDeclaration = {
        name,
        description: tool.description,
        parameters: tool.parameters as unknown as FunctionDeclaration["parameters"],
      };
      if (allowNonBlocking && name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
        declaration.behavior = Behavior.NON_BLOCKING;
      }
      declarations.push(declaration);
    } catch {
      omitted += 1;
    }
  }
  if (omitted > 0) {
    warn(`google realtime: omitted ${omitted} tool definition(s) with unsupported names`);
  }
  return declarations;
}

export function buildGoogleLiveConnectConfig(
  config: GoogleRealtimeLiveConfig,
  model: string,
): LiveConnectConfig {
  const functionDeclarations = buildFunctionDeclarations(
    config.tools,
    supportsAsyncFunctionCalling(model),
  );
  const realtimeInputConfig = buildRealtimeInputConfig(config);
  const thinkingConfig = buildThinkingConfig(config, model);
  return {
    responseModalities: [Modality.AUDIO],
    ...(config.temperature !== undefined && config.temperature > 0
      ? { temperature: config.temperature }
      : {}),
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: config.voice ?? GOOGLE_REALTIME_DEFAULT_VOICE,
        },
      },
    },
    systemInstruction: config.instructions,
    ...(functionDeclarations.length > 0 ? { tools: [{ functionDeclarations }] } : {}),
    ...(realtimeInputConfig ? { realtimeInputConfig } : {}),
    inputAudioTranscription: buildGoogleInputAudioTranscription(config.language),
    outputAudioTranscription: {},
    ...(!isGemini31LiveModel(model) && config.enableAffectiveDialog !== undefined
      ? { enableAffectiveDialog: config.enableAffectiveDialog }
      : {}),
    ...(thinkingConfig ? { thinkingConfig } : {}),
  };
}

export function toGoogleModelResource(model: string): string {
  return model.startsWith("models/") ? model : `models/${model}`;
}

export function buildBrowserInitialSetup(model: string, language?: string) {
  return {
    setup: {
      model: toGoogleModelResource(model),
      generationConfig: {
        responseModalities: [Modality.AUDIO],
      },
      inputAudioTranscription: buildGoogleInputAudioTranscription(language),
      outputAudioTranscription: {},
    },
  };
}
