import { getAgentRunRegistryState } from "./agent-run-registry-state.js";

/** Exact execution claims and scheduler queue leases, excluding UI projection metadata. */
export function hasAgentRunContextExecutionOwner(runId: string): boolean {
  const state = getAgentRunRegistryState();
  const context = state.contexts.get(runId);
  if (!context || context.lifecycleGeneration !== state.lifecycleGeneration) {
    return false;
  }
  const owners = state.owners.get(runId);
  return (
    (owners?.lifecycleGeneration === state.lifecycleGeneration && owners.claimIds.size > 0) ||
    (state.queuedRunContextLeases?.get(context) ?? 0) > 0
  );
}

/** Counts admitted executions, excluding retained display-only context. */
export function getActiveAgentRunContextCount(): number {
  let count = 0;
  for (const runId of getAgentRunRegistryState().contexts.keys()) {
    if (hasAgentRunContextExecutionOwner(runId)) {
      count += 1;
    }
  }
  return count;
}

/** Live display projection also includes a producer's active-session marker. */
export function hasLiveAgentRunContext(runId: string): boolean {
  const state = getAgentRunRegistryState();
  const context = state.contexts.get(runId);
  return (
    context?.lifecycleGeneration === state.lifecycleGeneration &&
    (hasAgentRunContextExecutionOwner(runId) || context.projectSessionActive === true)
  );
}

export function listLiveAgentRunIds(): string[] {
  return [...getAgentRunRegistryState().contexts.keys()].filter(hasLiveAgentRunContext);
}

/** Lists every registered run of the current lifecycle generation. */
export function listCurrentAgentRunIds(): string[] {
  const state = getAgentRunRegistryState();
  return [...state.contexts]
    .filter(([, context]) => context.lifecycleGeneration === state.lifecycleGeneration)
    .map(([runId]) => runId);
}
