import {
  buildAgentRunProjectionIndex,
  projectedRunIdentity,
  resolveAgentRunProjectionProgressState,
} from "./agent-run-projection.js";
import { getAgentRunRegistryState } from "./agent-run-registry-state.js";
import type {
  AgentRunModel,
  ProjectedAgentRunIndex,
  ProjectedAgentRunState,
} from "./agent-run-registry.types.js";

export function resolveProjectedAgentRunModel(params: {
  agentId: string;
  sessionId?: string;
  index?: ProjectedAgentRunIndex;
}): AgentRunModel | null | undefined {
  return params.sessionId === undefined
    ? undefined
    : (params.index ?? buildProjectedAgentRunIndex()).modelsBySessionId.get(
        projectedRunIdentity(params.agentId, params.sessionId),
      );
}

export function buildProjectedAgentRunIndex(): ProjectedAgentRunIndex {
  const { contexts, lifecycleGeneration } = getAgentRunRegistryState();
  return buildAgentRunProjectionIndex({ contexts: contexts.values(), lifecycleGeneration });
}

export function resolveProjectedAgentRunProgressState(
  params: Parameters<typeof resolveAgentRunProjectionProgressState>[0] & {
    index?: ProjectedAgentRunIndex;
  },
): ProjectedAgentRunState | undefined {
  return resolveAgentRunProjectionProgressState(
    params,
    params.index ?? buildProjectedAgentRunIndex(),
  );
}

// Both the snapshot and its prepared queries are weak: cold rows never pin old run indexes.
const preparedProgressStates = new WeakMap<
  ProjectedAgentRunIndex,
  WeakMap<object, ProjectedAgentRunState | null>
>();

/** Bind an immutable query once; each owner-published run index supplies its progress fact. */
export function prepareProjectedAgentRunProgressState(
  query: Readonly<Parameters<typeof resolveAgentRunProjectionProgressState>[0]>,
) {
  return (index: ProjectedAgentRunIndex): ProjectedAgentRunState | undefined => {
    let facts = preparedProgressStates.get(index);
    if (!facts) {
      facts = new WeakMap();
      preparedProgressStates.set(index, facts);
    }
    let progress = facts.get(query);
    if (progress === undefined) {
      progress = resolveAgentRunProjectionProgressState(query, index) ?? null;
      facts.set(query, progress);
    }
    return progress ?? undefined;
  };
}
