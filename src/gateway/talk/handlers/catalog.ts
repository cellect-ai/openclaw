import { asOptionalRecord, filterStringRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { type TalkCatalogParams } from "../../../../packages/gateway-protocol/src/index.js";
import { getRuntimeAuthProfileStoreCredentialsRevision } from "../../../agents/auth-profiles/runtime-snapshots.js";
import { getRuntimeConfigSnapshotMetadata } from "../../../config/runtime-snapshot.js";
import { resolveActiveTalkProviderConfig } from "../../../config/talk.js";
import type { TalkProviderConfig } from "../../../config/types.gateway.js";
import type { OpenClawConfig, TtsConfig, TtsProviderConfigMap } from "../../../config/types.js";
import { resolveProviderRawConfig } from "../../../plugin-sdk/provider-selection-runtime.js";
import { getCurrentPluginMetadataSnapshot } from "../../../plugins/current-plugin-metadata-snapshot.js";
import { getPluginRegistryVersion } from "../../../plugins/runtime-state.js";
import {
  getCanonicalGatewayContextResolver,
  getGatewayContextLifetime,
  getPluginRegistryForContext,
  withPluginRuntimeGatewayContextResolver,
  withPluginRuntimeRegistryScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "../../../plugins/runtime/generation-scope.js";
import { tryBeginGatewayIndependentRootWorkAdmission } from "../../../process/gateway-work-admission.js";
import {
  assertSecretOwnerAvailable,
  isSecretOwnerAvailable,
} from "../../../secrets/runtime-degraded-state.js";
import { getActiveSecretsRuntimeSnapshotRevisionState } from "../../../secrets/runtime-state.js";
import { runInDetachedAsyncContext } from "../../../shared/detached-async-context.js";
import { resolveTalkSessionAgentId } from "../../../talk/agent-target.js";
import { type InternalRealtimeVoiceProviderCapabilities } from "../../../talk/provider-internal.js";
import {
  canonicalizeRealtimeVoiceProviderId,
  listRealtimeVoiceProviders,
} from "../../../talk/provider-registry.js";
import {
  isRealtimeVoiceProviderConfiguredAsync,
  resolveConfiguredRealtimeVoiceProviderAsync,
  resolveRealtimeVoiceProviderCapabilitiesAsync,
} from "../../../talk/provider-resolver.js";
import {
  canonicalizeSpeechProviderId,
  getSpeechProvider,
  listSpeechProviders,
} from "../../../tts/provider-registry.js";
import {
  withSpeakerSelectionCompat,
  withSpeakerSelectionFallbackCompat,
} from "../../../tts/speaker.js";
import { isTtsProviderConfiguredAsync, resolveTtsConfig } from "../../../tts/tts.js";
import { providerMatchesId } from "../../../tts/voice-models.js";
import type { GatewayRequestContext } from "../../server-methods/types.js";
import { buildTalkRealtimeConfig } from "../session-config.js";
import {
  buildTalkTranscriptionCatalog,
  resolveCatalogProviderSelection,
  settleTalkCatalogTasks,
} from "./provider-catalog.js";

export function resolveTalkVoiceId(
  providerConfig: TalkProviderConfig,
  requested: string | undefined,
): string | undefined {
  if (!requested) {
    return undefined;
  }
  const aliases = filterStringRecord(providerConfig.voiceAliases);
  if (!aliases) {
    return requested;
  }
  const normalizedRequested = normalizeLowercaseStringOrEmpty(requested);
  for (const [alias, voiceId] of Object.entries(aliases)) {
    if (normalizeLowercaseStringOrEmpty(alias) === normalizedRequested) {
      return voiceId;
    }
  }
  return requested;
}

export function withTalkBaseTtsSpeakerSelectionCompat(
  baseTts: Record<string, unknown>,
  talkProvider?: { provider: { id: string; aliases?: readonly string[] }; apiKey?: unknown },
): Record<string, unknown> {
  const next = withSpeakerSelectionCompat(baseTts);
  const providers = asOptionalRecord(baseTts.providers);
  if (providers) {
    next.providers = Object.fromEntries(
      Object.entries(providers).map(([providerId, providerConfig]) => {
        const normalized = withSpeakerSelectionCompat(asOptionalRecord(providerConfig) ?? {});
        // Talk-owned overrides must shield provider normalization from a cold global TTS ref.
        if (
          typeof talkProvider?.apiKey === "string" &&
          providerMatchesId(talkProvider.provider, providerId) &&
          typeof normalized.apiKey === "object"
        ) {
          normalized.apiKey = talkProvider.apiKey;
        }
        return [providerId, normalized];
      }),
    );
  }
  return next;
}

export function buildTalkTtsConfig(
  config: OpenClawConfig,
):
  | { cfg: OpenClawConfig; provider: string; providerConfig: TalkProviderConfig }
  | { error: string; reason: TalkSpeakReason } {
  const resolved = resolveActiveTalkProviderConfig(config.talk);
  const provider = canonicalizeSpeechProviderId(resolved?.provider, config);
  if (!resolved || !provider) {
    return {
      error: "talk.speak unavailable: talk provider not configured",
      reason: "talk_unconfigured",
    };
  }
  assertSecretOwnerAvailable("capability", "talk:speech");

  const speechProvider = getSpeechProvider(provider, config);
  if (!speechProvider) {
    return {
      error: `talk.speak unavailable: speech provider "${provider}" does not support Talk mode`,
      reason: "talk_provider_unsupported",
    };
  }

  const providerConfig = withSpeakerSelectionFallbackCompat(resolved.config);
  const baseTts = withTalkBaseTtsSpeakerSelectionCompat(asOptionalRecord(config.tts) ?? {}, {
    provider: speechProvider,
    apiKey: providerConfig.apiKey,
  }) as TtsConfig;
  const resolvedProviderConfig =
    speechProvider.resolveTalkConfig?.({
      cfg: config,
      baseTtsConfig: baseTts as Record<string, unknown>,
      talkProviderConfig: providerConfig,
      timeoutMs: baseTts.timeoutMs ?? 30_000,
    }) ?? providerConfig;
  const talkTts: TtsConfig = {
    ...baseTts,
    auto: "always",
    provider,
    providers: {
      ...((asOptionalRecord(baseTts.providers) ?? {}) as TtsProviderConfigMap),
      [provider]: resolvedProviderConfig,
    },
  };

  return {
    provider,
    providerConfig,
    cfg: {
      ...config,
      tts: talkTts,
    },
  };
}

export type TalkCatalogSnapshot = Awaited<ReturnType<typeof buildTalkCatalog>>;

export type TalkCatalogEntry = {
  snapshot?: TalkCatalogSnapshot;
  revision?: readonly unknown[];
  refreshAfter: number;
  pending?: Promise<void>;
};

export const talkCatalogs = new WeakMap<object, Map<string, TalkCatalogEntry>>();

export const CATALOG_REFRESH_MS = 30_000;

export const CATALOG_REFRESH_DEADLINE_MS = 5_000;

export function readTalkCatalog(
  context: GatewayRequestContext,
  config: OpenClawConfig,
  params: TalkCatalogParams,
): TalkCatalogSnapshot | undefined {
  const agentId = resolveTalkSessionAgentId(config, params.sessionKey);
  const resolver = context.resolveGatewayContext
    ? getCanonicalGatewayContextResolver(context.resolveGatewayContext)
    : undefined;
  const owner = resolver ?? context.getRuntimeConfig;
  const lifetime = resolver ? getGatewayContextLifetime(resolver).signal : undefined;
  if (lifetime?.aborted) {
    return undefined;
  }
  let entries = talkCatalogs.get(owner);
  if (!entries) {
    const ownedEntries = new Map<string, TalkCatalogEntry>();
    entries = ownedEntries;
    talkCatalogs.set(owner, entries);
    lifetime?.addEventListener("abort", () => ownedEntries.clear(), { once: true });
  }
  const key = JSON.stringify([agentId, params.provider?.trim(), params.model?.trim()]);
  let entry = entries.get(key);
  if (!entry) {
    // Bound arbitrary model overrides; never evict work that still owns a provider call.
    if (entries.size >= 64) {
      const oldest = [...entries].find(([, candidate]) => !candidate.pending);
      if (!oldest) {
        return undefined;
      }
      entries.delete(oldest[0]);
    }
    entry = { refreshAfter: 0 };
    entries.set(key, entry);
  }
  const registry = getPluginRegistryForContext();
  const metadataSnapshot = getCurrentPluginMetadataSnapshot({
    config,
    allowSynchronousPolicyRead: false,
  });
  const revision = [
    config,
    getRuntimeConfigSnapshotMetadata()?.revision,
    registry,
    getPluginRegistryVersion(registry),
    metadataSnapshot,
    getRuntimeAuthProfileStoreCredentialsRevision(),
    getActiveSecretsRuntimeSnapshotRevisionState(),
    isSecretOwnerAvailable("capability", "talk:speech"),
    isSecretOwnerAvailable("capability", "talk:realtime"),
  ];
  if (
    !entry.pending &&
    (Date.now() >= entry.refreshAfter ||
      !entry.revision?.every((value, index) => value === revision[index]))
  ) {
    const retained = entry;
    const started = Date.now();
    const phases: Record<string, number> = {};
    const running = new Set<string>();
    const measure = async <T>(phase: string, run: () => Promise<T>): Promise<T> => {
      const start = Date.now();
      running.add(phase);
      try {
        return await run();
      } finally {
        running.delete(phase);
        phases[phase] = Date.now() - start;
      }
    };
    retained.revision = revision;
    retained.refreshAfter = started + CATALOG_REFRESH_MS;
    retained.pending = runInDetachedAsyncContext(async () => {
      const admission = tryBeginGatewayIndependentRootWorkAdmission("talk-catalog-refresh", {
        detachedWork: true,
      });
      if (!admission) {
        retained.refreshAfter = 0;
        return;
      }
      let expired = false;
      const logSlow = (outcome: string) => {
        const elapsedMs = Date.now() - started;
        if (elapsedMs >= 1_000 || outcome === "failed") {
          context.logGateway?.warn(
            `talk.catalog refresh ${outcome} elapsedMs=${elapsedMs} phases=${JSON.stringify(phases)} waiting=${[...running].join(",")}`,
          );
        }
      };
      const deadline = setTimeout(() => {
        expired = true;
        logSlow("deadline");
      }, CATALOG_REFRESH_DEADLINE_MS);
      deadline.unref();
      try {
        const build = () =>
          buildTalkCatalog(config, params, measure, retained.snapshot !== undefined);
        const snapshot = await admission.run(() =>
          withPluginRuntimeGatewayContextResolver(
            resolver,
            () =>
              metadataSnapshot
                ? withPluginRuntimeGenerationScope(
                    { metadataSnapshot, pluginRegistry: registry ?? undefined },
                    build,
                  )
                : withPluginRuntimeRegistryScope(registry ?? undefined, build),
            { inheritRequestScope: false },
          ),
        );
        if (!lifetime?.aborted) {
          retained.snapshot = snapshot;
        }
        if (!expired) {
          logSlow("completed");
        }
      } catch {
        logSlow("failed");
      } finally {
        clearTimeout(deadline);
        admission.release();
      }
    }).finally(() => {
      // A deadline does not cancel third-party hooks. Keep their single flight until settlement.
      retained.pending = undefined;
      if (!retained.snapshot) {
        retained.refreshAfter = Date.now() + 1_000;
      }
    });
  }
  return entry.snapshot;
}

export async function buildTalkCatalog(
  config: OpenClawConfig,
  params: TalkCatalogParams,
  measure: <T>(phase: string, run: () => Promise<T>) => Promise<T>,
  hasSnapshot: boolean,
) {
  const onReadinessError = (error: unknown): false => {
    if (hasSnapshot) {
      throw error;
    }
    return false;
  };
  // Reject ambiguous ownership before provider discovery loads unrelated plugins.
  const realtimeAgentId = resolveTalkSessionAgentId(config, params.sessionKey);
  const talkResolved = resolveActiveTalkProviderConfig(config.talk);
  const activeSpeechProvider = canonicalizeSpeechProviderId(talkResolved?.provider, config);
  const requestedProvider = normalizeOptionalString(params.provider);
  const requestedModel = normalizeOptionalString(params.model);
  const realtimeConfig = await measure("realtimeConfig", () =>
    buildTalkRealtimeConfig(config, requestedProvider, requestedModel),
  );
  const realtimeProviderIds = [
    ...(requestedProvider ? [requestedProvider] : []),
    ...Object.keys(realtimeConfig.providers),
  ];
  const realtimeSurface =
    realtimeConfig.transport === "gateway-relay" ? "gateway-relay" : "browser-session";
  const realtimeResolveContext = {
    cfg: config,
    agentId: realtimeAgentId,
    surface: realtimeSurface,
    ...(realtimeSurface === "gateway-relay"
      ? { autoRespondToAudio: realtimeConfig.consultRouting !== "force-agent-consult" }
      : {}),
  } as const;

  // Mirror talk.client.create's resolution inputs (agent scope + top-level model
  // override) so catalog readiness matches what session creation will actually do;
  // diverging here previously reported GPT-Live over OAuth as unconfigured.
  const realtimeModel = requestedModel ?? realtimeConfig.model;
  const realtimeModelOverride = realtimeModel
    ? { providerConfigOverrides: { model: realtimeModel } }
    : {};
  const realtimeSelection = await measure("realtimeSelection", () =>
    resolveCatalogProviderSelection(
      canonicalizeRealtimeVoiceProviderId(realtimeConfig.provider, config),
      async () => {
        assertSecretOwnerAvailable("capability", "talk:realtime");
        return resolveConfiguredRealtimeVoiceProviderAsync({
          ...realtimeResolveContext,
          configuredProviderId: realtimeConfig.provider,
          providerConfigs: realtimeConfig.providers,
          ...realtimeModelOverride,
          defaultModel: realtimeConfig.model,
        });
      },
    ),
  );
  const activeRealtimeProvider = realtimeSelection.activeProvider;
  const speechAvailable = isSecretOwnerAvailable("capability", "talk:speech");

  const [speechProviders, transcription, realtimeProviders] = await settleTalkCatalogTasks([
    measure("speech", () =>
      settleTalkCatalogTasks(
        listSpeechProviders(config).map(async (provider) => {
          let configured = false;
          if (speechAvailable) {
            const setup =
              provider.id === activeSpeechProvider ? buildTalkTtsConfig(config) : undefined;
            const effectiveConfig = setup && !("error" in setup) ? setup.cfg : config;
            const effectiveTts = resolveTtsConfig(effectiveConfig);
            effectiveTts.timeoutMs = Math.min(effectiveTts.timeoutMs, CATALOG_REFRESH_DEADLINE_MS);
            effectiveTts.timeoutMsSource = "config";
            configured = await isTtsProviderConfiguredAsync(
              effectiveTts,
              provider,
              undefined,
              onReadinessError,
            );
          }
          const entry: Record<string, unknown> = {
            id: provider.id,
            label: provider.label,
            configured,
            modes: ["stt-tts"],
            brains: ["agent-consult"],
          };
          if (provider.models) {
            entry.models = [...provider.models];
          }
          if (provider.aliases?.length) {
            entry.aliases = [...provider.aliases];
          }
          if (provider.voices) {
            entry.voices = [...provider.voices];
          }
          return entry;
        }),
      ),
    ),
    measure("transcription", () =>
      buildTalkTranscriptionCatalog(config, realtimeAgentId, onReadinessError),
    ),
    measure("realtimeProviders", () =>
      settleTalkCatalogTasks(
        listRealtimeVoiceProviders(config, realtimeProviderIds).map(async (provider) => {
          const available = isSecretOwnerAvailable("capability", "talk:realtime");
          const selected =
            available && provider.id === activeRealtimeProvider
              ? realtimeSelection.resolved
              : undefined;
          const rawConfig = resolveProviderRawConfig({
            providerConfigs: realtimeConfig.providers ?? {},
            providerId: provider.id,
            providerAliases: provider.aliases,
            configuredProviderId:
              provider.id === activeRealtimeProvider ? realtimeConfig.provider : undefined,
          });
          // Top-level talk.realtime.model overrides provider-level config, matching
          // talk.client.create's providerConfigOverrides precedence at session time.
          const model =
            provider.id === activeRealtimeProvider ? realtimeModel : realtimeConfig.model;
          const rawConfigWithModel = model ? { ...rawConfig, model } : rawConfig;
          const defaultRawConfig = { ...rawConfig };
          delete defaultRawConfig.model;
          const resolveConfig = async (rawInput: typeof defaultRawConfig) =>
            available
              ? ((await (provider.resolveConfigAsync?.({
                  ...realtimeResolveContext,
                  rawConfig: rawInput,
                }) ??
                  provider.resolveConfig?.({ ...realtimeResolveContext, rawConfig: rawInput }))) ??
                rawInput)
              : rawInput;
          // Selection already prepared this request's effective config and capabilities.
          // Only an explicit model needs a separate discovery-default resolution.
          const defaultProviderConfig =
            selected && rawConfigWithModel.model === undefined
              ? selected.providerConfig
              : await resolveConfig(defaultRawConfig);
          const providerConfig =
            selected?.providerConfig ??
            (available && rawConfigWithModel.model === undefined
              ? defaultProviderConfig
              : await resolveConfig(rawConfigWithModel));
          const capabilities: InternalRealtimeVoiceProviderCapabilities | undefined = selected
            ? selected.capabilities
            : available
              ? await resolveRealtimeVoiceProviderCapabilitiesAsync({
                  provider,
                  providerConfig,
                  cfg: config,
                  agentId: realtimeAgentId,
                  surface: realtimeSurface,
                })
              : provider.capabilities;
          const entry: Record<string, unknown> = {
            id: provider.id,
            label: provider.label,
            configured:
              available &&
              (selected !== undefined ||
                (await isRealtimeVoiceProviderConfiguredAsync({
                  provider,
                  cfg: config,
                  providerConfig,
                  agentId: realtimeAgentId,
                  surface: realtimeSurface,
                }).catch(onReadinessError))),
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
          if (capabilities?.modelFamilySettings) {
            entry.modelFamilySettings = capabilities.modelFamilySettings;
          }
          if (provider.aliases?.length) {
            entry.aliases = [...provider.aliases];
          }
          if (capabilities?.transports) {
            entry.transports = [...capabilities.transports];
          }
          for (const key of ["inputAudioFormats", "outputAudioFormats"] as const) {
            const formats = capabilities?.[key];
            if (formats) {
              entry[key] = formats.map((format) => Object.assign({}, format));
            }
          }
          for (const key of [
            "supportsBargeIn",
            "supportsToolCalls",
            "supportsVideoFrames",
            "supportsSessionResumption",
          ] as const) {
            if (capabilities?.[key] !== undefined) {
              entry[key] = capabilities[key];
            }
          }
          return entry;
        }),
      ),
    ),
  ]);
  return {
    modes: ["realtime", "stt-tts", "transcription"],
    transports: ["webrtc", "provider-websocket", "gateway-relay", "managed-room"],
    brains: ["agent-consult", "direct-tools", "none"],
    speech: {
      ...(activeSpeechProvider ? { activeProvider: activeSpeechProvider } : {}),
      providers: speechProviders,
    },
    transcription,
    realtime: {
      ready: realtimeSelection.ready,
      ...(activeRealtimeProvider ? { activeProvider: activeRealtimeProvider } : {}),
      providers: realtimeProviders,
    },
  };
}
export type TalkSpeakReason =
  | "talk_unconfigured"
  | "talk_provider_unsupported"
  | "method_unavailable"
  | "synthesis_failed"
  | "invalid_audio_result";
