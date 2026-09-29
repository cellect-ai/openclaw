import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice";
import {
  GOOGLE_REALTIME_VOICES,
  LITELLM_REALTIME_VOICE_MODELS,
  XAI_REALTIME_VOICES,
} from "./realtime-voice-config.js";

const INTERNAL_REALTIME_VOICE_PROVIDER = Symbol.for("openclaw.internal.realtime-voice-provider.v1");

type InternalRealtimeVoiceCapabilities = NonNullable<
  RealtimeVoiceProviderPlugin["capabilities"]
> & {
  voicesByModel?: Record<string, readonly string[]>;
};

/** Adds private, model-aware catalog hooks without loading the realtime transport implementation. */
export function attachLiteLlmRealtimeVoiceCapabilities(
  provider: RealtimeVoiceProviderPlugin,
): RealtimeVoiceProviderPlugin {
  const providerCapabilities = provider.capabilities;
  if (!providerCapabilities) {
    throw new Error("LiteLLM realtime voice metadata is missing capabilities");
  }
  // Catalogs must include inactive models too: changing the UI selection does
  // not change the provider config used to fetch this metadata.
  const resolveModelCapabilities = (): InternalRealtimeVoiceCapabilities => ({
    ...providerCapabilities,
    voicesByModel: {
      [LITELLM_REALTIME_VOICE_MODELS[0]]: XAI_REALTIME_VOICES,
      [LITELLM_REALTIME_VOICE_MODELS[1]]: GOOGLE_REALTIME_VOICES,
    },
  });

  Object.defineProperty(provider, INTERNAL_REALTIME_VOICE_PROVIDER, {
    configurable: true,
    value: {
      // LiteLLM realtime connects through the Gateway relay only.
      isBrowserSessionConfigured: () => false,
      resolveBrowserSessionCapabilities: resolveModelCapabilities,
      resolveGatewayRelayCapabilities: resolveModelCapabilities,
    },
  });
  return provider;
}
