import type { PluginCapabilityCatalogHostEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  createLazyLiteLlmRealtimeVoiceProvider,
  createLazyXaiSpeechProvider,
  createLazyXaiRealtimeTranscriptionProvider,
  createLazyXaiRealtimeVoiceProvider,
} from "./lazy-capability-provider-factories.js";

const catalog: PluginCapabilityCatalogHostEntry = (context) => ({
  speechProviders: [createLazyXaiSpeechProvider(context)],
  realtimeTranscriptionProviders: [createLazyXaiRealtimeTranscriptionProvider(context)],
  realtimeVoiceProviders: [
    createLazyXaiRealtimeVoiceProvider(context),
    createLazyLiteLlmRealtimeVoiceProvider(context),
  ],
});

export default catalog;
