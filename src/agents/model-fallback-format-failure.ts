import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type AdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import {
  type ModelFallbackErrorHandler,
  type ModelFallbackResultClassifier,
  type ModelFallbackRunFn,
  type ModelFallbackRuntimeContext,
  type ModelFallbackStepHandler,
} from "./model-fallback-attempt.js";
import { resolveModelCandidateChain } from "./model-fallback-candidates.js";
import {
  type ModelFallbackCandidate,
  type ModelFallbackRouteResolution,
} from "./model-fallback.types.js";
import type { ModelManifestNormalizationContext } from "./model-ref-shared.js";

export function resolveDeferredFormatFailureCandidates(params: {
  cfg: OpenClawConfig | undefined;
  agentId?: string;
  provider: string;
  model: string;
  formatFailureFallbacks?: string[];
  requestedRouteResolution?: ModelFallbackRouteResolution;
  manifestPlugins?: ModelManifestNormalizationContext["manifestPlugins"];
  candidates: readonly ModelFallbackCandidate[];
  allows?: (candidate: { provider: string; model: string }) => boolean;
}): ModelFallbackCandidate[] {
  const fallbacks = params.formatFailureFallbacks
    ?.map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (!params.cfg || !fallbacks || fallbacks.length === 0) {
    return [];
  }
  const seen = new Set(
    params.candidates.map((candidate) => `${candidate.provider}\0${candidate.model}`),
  );
  const extra: ModelFallbackCandidate[] = [];
  for (const candidate of resolveModelCandidateChain({
    cfg: params.cfg,
    agentId: params.agentId,
    provider: params.provider,
    model: params.model,
    fallbacksOverride: fallbacks,
    requestedRouteResolution: params.requestedRouteResolution,
    manifestPlugins: params.manifestPlugins,
  })) {
    if (candidate.routeOrigin === "requested") {
      continue;
    }
    const key = `${candidate.provider}\0${candidate.model}`;
    if (seen.has(key) || (params.allows && !params.allows(candidate))) {
      continue;
    }
    seen.add(key);
    extra.push(candidate);
  }
  return extra;
}

export type RunWithModelFallbackParams<T> = ModelFallbackRuntimeContext & {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  runId?: string;
  sessionId?: string;
  /** Keeps a rate-limit fallback first for this session's next turns so the provider prompt cache stays warm. */
  stickyRateLimitFallback?: boolean;
  userLockedAuthProfileId?: string;
  prepareCandidateChain?: (candidates: readonly ModelFallbackCandidate[]) => Promise<void> | void;
  lane?: string;
  agentDir?: string;
  /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
  fallbacksOverride?: string[];
  /**
   * Models held back from the normal ladder. They run only after a format failure
   * when `fallbacksOverride` is empty because a user pin suppressed configured fallbacks.
   */
  formatFailureFallbacks?: string[];
  requestedRouteResolution?: ModelFallbackRouteResolution;
  run: ModelFallbackRunFn<T>;
  onError?: ModelFallbackErrorHandler;
  onFallbackStep?: ModelFallbackStepHandler;
  classifyResult?: ModelFallbackResultClassifier<T>;
  /** Return false when a thrown attempt committed work that must not be replayed. */
  canFallbackAfterError?: (
    attempt: Parameters<ModelFallbackErrorHandler>[0],
  ) => boolean | Promise<boolean>;
  mergeExhaustedResult?: (params: { latestResult: T; preferredResult: T }) => T;
  /** The attempt owner admits its runtime and selects credentials. */
  skipAuthProfileRuntime?: boolean;
  abortSignal?: AbortSignal;
  operatorAuthority?: AdmittedRunOperatorAuthority;
} & ModelManifestNormalizationContext;
