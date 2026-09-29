import type { PluginCapabilityCatalogEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  createLazyLiteLlmRealtimeVoiceProvider,
  createLazyXaiSpeechProvider,
  createLazyXaiRealtimeTranscriptionProvider,
  createLazyXaiRealtimeVoiceProvider,
} from "./lazy-capability-provider-factories.js";

const catalog: PluginCapabilityCatalogEntry = (context) => ({
  speechProviders: [createLazyXaiSpeechProvider(context)],
  realtimeTranscriptionProviders: [createLazyXaiRealtimeTranscriptionProvider(context)],
  realtimeVoiceProviders: [
    createLazyXaiRealtimeVoiceProvider(context),
    createLazyLiteLlmRealtimeVoiceProvider(context),
  ],
});

export default catalog;
