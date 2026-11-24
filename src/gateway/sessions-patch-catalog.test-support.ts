import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { OpenClawConfig } from "../config/config.js";
import { type ApplySessionsPatchArgs } from "./sessions-patch.test-support.js";

type ModelDefaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;

export function agentConfig(
  defaults: ModelDefaults | undefined,
  entries?: NonNullable<OpenClawConfig["agents"]>["entries"],
): OpenClawConfig {
  return { agents: { ...(defaults ? { defaults } : {}), ...(entries ? { entries } : {}) } };
}

export function modelConfig(primary: string, defaults: ModelDefaults = {}): OpenClawConfig {
  return agentConfig({ model: { primary }, ...defaults });
}

export function catalogEntry(
  ref: string,
  metadata: Partial<ModelCatalogEntry> = {},
): ModelCatalogEntry {
  const separator = ref.indexOf("/");
  if (separator < 0) {
    throw new Error(`model ref must include provider: ${ref}`);
  }
  const id = ref.slice(separator + 1);
  return {
    provider: ref.slice(0, separator),
    id,
    name: id,
    ...metadata,
  };
}

export function loadCatalog(...refs: string[]): ApplySessionsPatchArgs["loadGatewayModelCatalog"] {
  return async () => refs.map((ref) => catalogEntry(ref));
}
