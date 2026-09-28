import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/capability-provider.types.js";
import type { InternalRealtimeVoiceProviderCapabilities } from "../../../talk/provider-internal.js";
import type { RealtimeVoiceProviderConfig } from "../../../talk/provider-types.js";
import { resolveCatalogValue } from "./catalog-selection.js";

export function buildRealtimeProviderCatalog(params: {
  providers: RealtimeVoiceProviderPlugin[];
  available: boolean;
  resolveRawConfig: (provider: RealtimeVoiceProviderPlugin) => RealtimeVoiceProviderConfig;
  resolveProviderConfig: (
    provider: RealtimeVoiceProviderPlugin,
    rawConfig: RealtimeVoiceProviderConfig,
  ) => RealtimeVoiceProviderConfig;
  resolveCapabilities: (
    provider: RealtimeVoiceProviderPlugin,
    providerConfig: RealtimeVoiceProviderConfig,
  ) => InternalRealtimeVoiceProviderCapabilities | undefined;
  isConfigured: (
    provider: RealtimeVoiceProviderPlugin,
    providerConfig: RealtimeVoiceProviderConfig,
  ) => boolean;
}) {
  return params.providers.map((provider) => {
    // Config reads can themselves resolve SecretRefs (and throw when a provider's
    // secret is unavailable in this runtime snapshot). Keep that failure scoped
    // to the affected provider just like provider-specific normalization below.
    const rawConfig = resolveCatalogValue(
      () => params.resolveRawConfig(provider),
      () => ({}),
    );
    const defaultRawConfig = { ...rawConfig };
    delete defaultRawConfig.model;
    const providerState = params.available
      ? resolveCatalogValue(
          () => {
            const defaultProviderConfig = params.resolveProviderConfig(provider, defaultRawConfig);
            const providerConfig =
              rawConfig.model === undefined
                ? defaultProviderConfig
                : params.resolveProviderConfig(provider, rawConfig);
            return {
              defaultProviderConfig,
              providerConfig,
              capabilities: params.resolveCapabilities(provider, providerConfig),
            };
          },
          () => undefined,
        )
      : undefined;
    // One unresolved provider credential must not take down the picker or be retried via a fallback.
    const defaultProviderConfig = providerState?.defaultProviderConfig ?? defaultRawConfig;
    const capabilities: InternalRealtimeVoiceProviderCapabilities | undefined =
      providerState?.capabilities ?? provider.capabilities;
    const entry: Record<string, unknown> = {
      id: provider.id,
      label: provider.label,
      configured:
        params.available &&
        providerState !== undefined &&
        resolveCatalogValue(
          () => params.isConfigured(provider, providerState.providerConfig),
          () => false,
        ),
      modes: ["realtime"],
      brains:
        capabilities?.supportsToolCalls === false && capabilities.handlesAgentConsult !== true
          ? ["none"]
          : ["agent-consult"],
      supportsBrowserSession: Boolean(
        capabilities?.supportsBrowserSession ?? provider.createBrowserSession,
      ),
    };
    const defaultModel =
      normalizeOptionalString(defaultProviderConfig.model) ?? provider.defaultModel;
    if (defaultModel) {
      entry.defaultModel = defaultModel;
    }
    if (provider.models?.length) {
      entry.models = [...provider.models];
    }
    if (provider.voices) {
      entry.voices = [...provider.voices];
    }
    if (capabilities?.voices) {
      entry.activeVoices = [...capabilities.voices];
    }
    if (capabilities?.voiceSelectionPolicy) {
      entry.activeVoiceSelectionPolicy = capabilities.voiceSelectionPolicy;
    }
    if (capabilities?.voicesByModel) {
      entry.voicesByModel = capabilities.voicesByModel;
    }
    if (provider.aliases?.length) {
      entry.aliases = [...provider.aliases];
    }
    if (capabilities?.transports) {
      entry.transports = [...capabilities.transports];
    }
    if (capabilities?.inputAudioFormats) {
      entry.inputAudioFormats = capabilities.inputAudioFormats.map((format) => ({ ...format }));
    }
    if (capabilities?.outputAudioFormats) {
      entry.outputAudioFormats = capabilities.outputAudioFormats.map((format) => ({ ...format }));
    }
    if (capabilities?.supportsBargeIn !== undefined) {
      entry.supportsBargeIn = capabilities.supportsBargeIn;
    }
    if (capabilities?.supportsToolCalls !== undefined) {
      entry.supportsToolCalls = capabilities.supportsToolCalls;
    }
    if (capabilities?.supportsVideoFrames !== undefined) {
      entry.supportsVideoFrames = capabilities.supportsVideoFrames;
    }
    if (capabilities?.supportsSessionResumption !== undefined) {
      entry.supportsSessionResumption = capabilities.supportsSessionResumption;
    }
    return entry;
  });
}
