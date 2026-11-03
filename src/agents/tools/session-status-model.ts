import { randomUUID } from "node:crypto";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/index.js";
import { patchSessionEntryWithKey, type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasOperatorToolGatewayAuthority } from "../../gateway/operator-invocation-authority.js";
import { withSessionStatusModelPatchOrigin } from "../../gateway/session-model-patch-origin.js";
import { triggerSessionPatchHook } from "../../gateway/session-patch-hooks.js";
import type { SessionsPatchResult } from "../../gateway/session-utils.types.js";
import {
  isPluginMetadataSnapshotCompatible,
  resolvePluginMetadataSnapshot,
} from "../../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { applyModelOverrideWithAuthProfileCompatibility } from "../../sessions/auth-profile-preservation.js";
import {
  buildModelAliasIndex,
  modelKey,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../model-selection.js";
import { createModelVisibilityPolicy } from "../model-visibility-policy.js";
import { loadPublishedPreparedModelCatalog } from "../prepared-model-catalog.js";
import { normalizeToolModelOverride, ToolAuthorizationError } from "./common.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import type { ResolvedStatusSessionEntry as ResolvedStatusSession } from "./session-status-session-resolve.js";

function modelSelectionRecovery(
  error: Error,
  raw: string,
  models: readonly Pick<
    ModelsListResult["models"][number],
    "provider" | "id" | "name" | "available" | "manualSelectionAllowed"
  >[],
): Error {
  const requested = raw.trim().toLowerCase().split("/").at(-1) ?? "";
  const choices = models
    .filter((entry) => entry.manualSelectionAllowed !== false && entry.available !== false)
    .map((entry) => ({
      key: modelKey(entry.provider, entry.id),
      matches: `${entry.id} ${entry.name}`.toLowerCase().includes(requested),
    }))
    .toSorted((a, b) => Number(b.matches) - Number(a.matches) || a.key.localeCompare(b.key));
  const keys = [...new Set(choices.map((entry) => entry.key))];
  return keys.length
    ? new Error(
        `${error.message} Retry session_status with a configured canonical model ID: ${keys.slice(0, 8).join(", ")}.${keys.length > 8 ? " (Showing up to 8 choices, matching names first.)" : ""} A rejected nickname does not establish that the requested model is unavailable.`,
        { cause: error },
      )
    : error;
}

/** Gateway requests use the mutation owner; standalone runs retain their local store contract. */
export async function patchSessionStatusModel(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  storePath: string;
  raw: string;
  resolved: ResolvedStatusSession;
  metadataSnapshot?: PluginMetadataSnapshot;
  gatewayCall?: AgentToolGatewayRequestCaller;
}): Promise<{ resolved: ResolvedStatusSession; changedModel: boolean }> {
  const { cfg, agentId, resolved } = params;
  if (hasOperatorToolGatewayAuthority() && !params.gatewayCall) {
    throw new ToolAuthorizationError("Operator model selection requires a current Gateway.");
  }
  if (params.gatewayCall) {
    const gatewayCall = params.gatewayCall;
    const { result, applied } = await withSessionStatusModelPatchOrigin(() =>
      gatewayCall<SessionsPatchResult>({
        method: "sessions.patch",
        params: {
          key: resolved.key,
          agentId,
          ...(resolved.persisted
            ? {
                ...(resolved.entry.sessionId.trim()
                  ? { expectedSessionId: resolved.entry.sessionId }
                  : {}),
                expectedLifecycleRevision: resolved.entry.lifecycleRevision,
              }
            : {}),
          model: normalizeToolModelOverride(params.raw) ?? null,
        },
      }).catch(async (error: unknown) => {
        if (!(error instanceof Error) || !/model not allowed:/i.test(error.message)) {
          throw error;
        }
        // The existing catalog owner filters this exact session and operator;
        // never advertise another agent's models or expand nickname policy.
        const catalog = await gatewayCall<ModelsListResult>({
          method: "models.list",
          params: { agentId, sessionKey: resolved.key, preparedOnly: true },
        }).catch(() => undefined);
        throw catalog ? modelSelectionRecovery(error, params.raw, catalog.models) : error;
      }),
    );
    return {
      resolved: { key: result.key, entry: result.entry, persisted: true },
      changedModel: applied,
    };
  }

  const configured = resolveDefaultModelForAgent({ cfg, agentId });
  const raw = normalizeToolModelOverride(params.raw);
  let modelSelection = { ...configured, isDefault: true };
  if (raw) {
    const currentProvider = resolved.entry.providerOverride?.trim() || configured.provider;

    const aliasIndex = buildModelAliasIndex({
      cfg: params.cfg,
      agentId: params.agentId,
      defaultProvider: currentProvider,
    });
    const catalog = await loadPublishedPreparedModelCatalog({
      config: params.cfg,
      agentId: params.agentId,
      agentDir: params.agentDir,
      readOnly: true,
      ...(resolved.entry.spawnedWorkspaceDir
        ? { workspaceDir: resolved.entry.spawnedWorkspaceDir }
        : {}),
    });
    const workspaceDir = resolved.entry.spawnedWorkspaceDir ?? params.workspaceDir;
    const manifestMetadataSnapshot =
      params.metadataSnapshot &&
      params.metadataSnapshot.pluginIds === undefined &&
      isPluginMetadataSnapshotCompatible({
        snapshot: params.metadataSnapshot,
        config: params.cfg,
        env: process.env,
        workspaceDir,
      })
        ? params.metadataSnapshot
        : resolvePluginMetadataSnapshot({
            config: params.cfg,
            ...(workspaceDir ? { workspaceDir } : {}),
            env: process.env,
          });
    const policy = createModelVisibilityPolicy({
      cfg: params.cfg,
      catalog,
      defaultProvider: currentProvider,
      defaultModel: configured,
      agentId: params.agentId,
      allowManifestNormalization: true,
      allowPluginNormalization: true,
      manifestPlugins: manifestMetadataSnapshot,
    });

    const selected = resolveModelRefFromString({
      cfg: params.cfg,
      agentId: params.agentId,
      raw,
      defaultProvider: currentProvider,
      aliasIndex,
      allowManifestNormalization: true,
      allowPluginNormalization: true,
      manifestPlugins: manifestMetadataSnapshot,
    });
    if (!selected) {
      throw new Error(`Unrecognized model "${raw}".`);
    }
    const key = modelKey(selected.ref.provider, selected.ref.model);
    if (!policy.allows(selected.ref)) {
      throw modelSelectionRecovery(
        new Error(`Model "${key}" is not allowed.`),
        raw,
        policy.allowedCatalog,
      );
    }
    modelSelection = {
      ...selected.ref,
      isDefault:
        selected.ref.provider === configured.provider && selected.ref.model === configured.model,
    };
  }
  const applySelection = (entry: SessionEntry) =>
    applyModelOverrideWithAuthProfileCompatibility({
      cfg,
      agentDir: params.agentDir,
      entry,
      currentProvider:
        entry.providerOverride?.trim() || entry.modelProvider?.trim() || configured.provider,
      selection: modelSelection,
      explicitDefaultSelection: modelSelection.isDefault,
      markLiveSwitchPending: true,
    });
  const applied = applySelection({ ...resolved.entry });
  if (!applied.updated) {
    return { resolved, changedModel: false };
  }
  const patched = await patchSessionEntryWithKey(
    { agentId, sessionKey: resolved.key, storePath: params.storePath },
    (entry, context) => {
      const next: SessionEntry = { ...entry };
      applySelection(next);
      if (!next.sessionId.trim() && !context.existingEntry?.sessionId?.trim()) {
        next.sessionId = randomUUID();
      }
      return next;
    },
    { fallbackEntry: resolved.persisted ? undefined : resolved.entry, replaceEntry: true },
  );
  if (!patched) {
    throw new Error(`Unknown sessionKey: ${resolved.key}`);
  }
  triggerSessionPatchHook({
    cfg,
    sessionEntry: patched.entry,
    sessionKey: patched.sessionKey,
    patch: {
      key: patched.sessionKey,
      model: raw ? `${modelSelection.provider}/${modelSelection.model}` : null,
    },
  });
  return {
    resolved: { entry: patched.entry, key: patched.sessionKey, persisted: true },
    changedModel: true,
  };
}
