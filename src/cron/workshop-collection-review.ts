import { createHash } from "node:crypto";
import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentModelFallbacksOverride,
  resolveSubagentModelConfigSelectionResult,
  resolveSubagentModelFallbacksOverride,
} from "../agents/agent-scope.js";
import { resolveAvailableAgentHarnessPolicy } from "../agents/harness/availability.js";
import { resolveModelCandidateChain } from "../agents/model-fallback-candidates.js";
import { resolveCliRuntimeExecutionProvider } from "../agents/model-runtime-aliases.js";
import { isCliProvider } from "../agents/model-selection-cli.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import {
  buildModelAliasIndex,
  inferUniqueProviderFromConfiguredModels,
  normalizeModelSelection,
  resolveModelRefFromString,
} from "../agents/model-selection-shared.js";
import { pickSandboxToolPolicy } from "../agents/sandbox-tool-policy.js";
import { isToolAllowedByPolicies } from "../agents/tool-policy-match.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { readSessionEntriesFromStoreInWorker } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import type { ManifestModelIdNormalizationSource } from "../plugins/manifest-model-id-normalization.js";
import { WORKSHOP_COLLECTION_REVIEW_EVERY_MS } from "../skills/workshop-host/collection-review-prompt.js";
import {
  WORKSHOP_COLLECTION_REVIEW_MESSAGE,
  supportsWorkshopCollectionRuntime,
} from "../skills/workshop-host/collection-review.js";
import { resolveSkillWorkshopConfig } from "../skills/workshop-host/config.js";
import { resolveCronAgentSessionKey } from "./isolated-agent/session-key.js";
import type { CronServiceContract } from "./service-contract.js";
import { WORKSHOP_COLLECTION_REVIEW_DECLARATION_PREFIX } from "./system-owned-declaration.js";
import type { CronJob, CronJobCreate } from "./types.js";
export { WORKSHOP_COLLECTION_REVIEW_EVERY_MS } from "../skills/workshop-host/collection-review-prompt.js";

/** Returns undefined when static config cannot prove the full runtime chain. */
export function hasEligibleSkillCollectionReviewRuntime(
  cfg: OpenClawConfig,
  agentId: string,
  manifestPlugins: ManifestModelIdNormalizationSource,
): boolean | undefined {
  const normalization = { manifestPlugins, allowPluginNormalization: false } as const;
  const agentConfig = resolveAgentConfig(cfg, agentId);
  const cfgWithAgentDefaults = cfg;
  const defaultRef = resolveDefaultModelForAgent({
    cfg: cfgWithAgentDefaults,
    agentId,
    ...normalization,
  });
  const selection = resolveSubagentModelConfigSelectionResult({
    cfg,
    agentId,
    agentConfigOverride: agentConfig,
  });
  const selectedRaw = selection ? normalizeModelSelection(selection.raw) : undefined;
  const aliasIndex = buildModelAliasIndex({
    cfg,
    agentId,
    defaultProvider: defaultRef.provider,
    ...normalization,
  });
  const selected = selectedRaw
    ? resolveModelRefFromString({
        cfg,
        agentId,
        aliasIndex,
        ...normalization,
        raw: selectedRaw,
        defaultProvider: !selectedRaw.includes("/")
          ? (inferUniqueProviderFromConfiguredModels({
              cfg,
              agentId,
              model: selectedRaw,
              manifestPlugins,
            }) ?? defaultRef.provider)
          : defaultRef.provider,
      })?.ref
    : defaultRef;
  if (!selected) {
    return undefined;
  }

  const agentModel = agentConfig?.model;
  const inheritsDefaultFallbacks =
    typeof agentModel === "string" &&
    resolveAgentModelPrimaryValue(agentModel) ===
      resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model);
  const defaultFallbacks =
    (inheritsDefaultFallbacks
      ? resolveAgentModelFallbackValues(cfgWithAgentDefaults.agents?.defaults?.model)
      : resolveAgentModelFallbacksOverride(cfgWithAgentDefaults, agentId)) ??
    resolveAgentModelFallbackValues(cfgWithAgentDefaults.agents?.defaults?.model);
  const fallbacksOverride =
    (selection?.source === "subagent" || selection?.source === "default-subagent"
      ? resolveSubagentModelFallbacksOverride(cfgWithAgentDefaults, agentId)
      : defaultFallbacks) ?? defaultFallbacks;

  // Advisory model selections are accepted only against the execution owner's live
  // catalog/policy. Projection cannot prove that acceptance, so also consider the
  // default chain that execution retains when the advisory selection is rejected.
  const chains = [
    { selected, fallbacksOverride },
    { selected: defaultRef, fallbacksOverride: defaultFallbacks },
  ];
  const eligibility = new Set(
    chains.map((chain) => {
      // A plugin-owned or otherwise unresolved ref may become runnable after runtime preparation.
      // Keep the job enabled unless every configured candidate can be classified now.
      if (
        chain.fallbacksOverride.some(
          (raw) =>
            !resolveModelRefFromString({
              cfg: cfgWithAgentDefaults,
              agentId,
              aliasIndex,
              ...normalization,
              raw,
              defaultProvider: chain.selected.provider,
            }),
        )
      ) {
        return undefined;
      }

      const candidates = resolveModelCandidateChain({
        cfg: cfgWithAgentDefaults,
        ...normalization,
        agentId,
        provider: chain.selected.provider,
        model: chain.selected.model,
        requestedRouteResolution: "resolved",
        fallbacksOverride: chain.fallbacksOverride,
      });
      if (candidates.length === 0) {
        return undefined;
      }
      const candidateEligibility = candidates.map((candidate) => {
        const policy = resolveAvailableAgentHarnessPolicy({
          mode: "projection",
          config: cfgWithAgentDefaults,
          provider: candidate.provider,
          modelId: candidate.model,
          agentId,
        });
        const executionProvider =
          resolveCliRuntimeExecutionProvider({
            cfg: cfgWithAgentDefaults,
            provider: candidate.provider,
            modelId: candidate.model,
            agentId,
          }) ?? candidate.provider;
        // Implicit/auto runtime selection can still fall back to embedded
        // execution after harness preparation; it cannot prove rejection here.
        return (
          policy.runtimeSource === "implicit" ||
          policy.runtime === "auto" ||
          supportsWorkshopCollectionRuntime(
            policy.runtime,
            isCliProvider(executionProvider, cfgWithAgentDefaults),
          )
        );
      });
      return candidateEligibility.includes(true)
        ? true
        : candidateEligibility.includes(undefined)
          ? undefined
          : false;
    }),
  );
  return eligibility.has(true) ? true : eligibility.has(undefined) ? undefined : false;
}

export function workshopCollectionReviewAgentId(
  job: Pick<CronJob, "declarationKey" | "agentId">,
): string | undefined {
  const key = job.declarationKey;
  if (!key?.startsWith(WORKSHOP_COLLECTION_REVIEW_DECLARATION_PREFIX)) return undefined;
  const agentId = key.slice(WORKSHOP_COLLECTION_REVIEW_DECLARATION_PREFIX.length);
  return agentId && agentId === job.agentId ? agentId : undefined;
}

async function hasStoredExecutionPreference(
  cfg: OpenClawConfig,
  agentId: string,
  jobId: string,
): Promise<boolean> {
  try {
    const sessionKey = resolveCronAgentSessionKey({ sessionKey: `cron:${jobId}`, agentId, cfg });
    const prepared = await readSessionEntriesFromStoreInWorker({
      agentId,
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
      sessionKeys: [sessionKey],
    });
    const entry = prepared.entries.find((item) => item.sessionKey === sessionKey)?.entry;
    return Boolean(entry?.modelOverride || entry?.agentRuntimeOverride);
  } catch {
    return true;
  } // Unavailable is not proof of absence; the execution owner rechecks.
}

export async function reconcileWorkshopCollectionReviews(params: {
  cfg: OpenClawConfig;
  cron: Pick<CronServiceContract, "list" | "add" | "update">;
  enabled: boolean;
  isCurrent: () => boolean;
  logger: { warn: (message: string) => void };
}): Promise<void> {
  const commitGuard = () => {
    if (!params.isCurrent())
      throw new DOMException("Workshop reconciliation superseded", "AbortError");
  };
  commitGuard();
  const jobs = await params.cron.list({ includeDisabled: true });
  commitGuard();
  const mode = resolveSkillWorkshopConfig(params.cfg).autonomous.mode;
  if (mode === "auto" && !params.enabled)
    params.logger.warn(
      "Weekly Skill Workshop collection reviews require cron.enabled and OPENCLAW_SKIP_CRON unset; no separate timer runs them.",
    );
  const manifestPlugins =
    getCurrentPluginMetadataSnapshot({ config: params.cfg, allowWorkspaceScopedSnapshot: true }) ??
    [];
  const agentIds = new Set(listAgentIds(params.cfg));
  for (const job of jobs) {
    const agentId = workshopCollectionReviewAgentId(job);
    if (agentId && !agentIds.has(agentId))
      await params.cron.update(
        job.id,
        { enabled: false, displayName: `[agent-removed] Skill collection review (${agentId})` },
        { commitGuard },
      );
  }
  for (const agentId of agentIds) {
    const existing = jobs.find((job) => workshopCollectionReviewAgentId(job) === agentId);
    const eligibility = hasEligibleSkillCollectionReviewRuntime(
      params.cfg,
      agentId,
      manifestPlugins,
    );
    const unknownPreference =
      eligibility === false && existing
        ? await hasStoredExecutionPreference(params.cfg, agentId, existing.id)
        : false;
    commitGuard();
    const policies = [
      pickSandboxToolPolicy(params.cfg.tools),
      pickSandboxToolPolicy(resolveAgentConfig(params.cfg, agentId)?.tools),
    ];
    const reason =
      mode !== "auto"
        ? `mode-${mode}`
        : !isToolAllowedByPolicies("skill_workshop", policies)
          ? "no-workshop-tools"
          : eligibility === false && !unknownPreference
            ? "no-rooted-runtime"
            : undefined;
    // A disabled row without one of our policy labels carries an explicit pause through migration/reload.
    const policyDisabled =
      /^\[(?:mode-off|mode-propose|no-workshop-tools|no-rooted-runtime|agent-removed)\]/.test(
        existing?.displayName ?? "",
      );
    const enabled = !reason && (!existing || existing.enabled || policyDisabled);
    const input: CronJobCreate = {
      declarationKey: `${WORKSHOP_COLLECTION_REVIEW_DECLARATION_PREFIX}${agentId}`,
      name: `skill-collection-review-${agentId}`,
      displayName: `${reason ? `[${reason}] ` : ""}Skill collection review (${agentId})`,
      agentId,
      enabled,
      schedule: {
        kind: "every",
        everyMs: WORKSHOP_COLLECTION_REVIEW_EVERY_MS,
        anchorMs:
          existing?.schedule.kind === "every"
            ? existing.schedule.anchorMs
            : createHash("sha256").update(agentId).digest().readUInt32BE(0) %
              WORKSHOP_COLLECTION_REVIEW_EVERY_MS,
      },
      payload: {
        kind: "agentTurn",
        message: WORKSHOP_COLLECTION_REVIEW_MESSAGE,
        toolsAllow: ["skill_workshop"],
        lightContext: true,
        timeoutSeconds: 120,
      },
      idleOnly: true,
      sessionTarget: "isolated",
      delivery: { mode: "none" },
      wakeMode: "next-heartbeat",
    };
    await params.cron.add(input, { systemOwned: true, enabledExplicit: true, commitGuard });
  }
}
