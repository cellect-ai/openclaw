import { onAgentEventForRun } from "../../../infra/agent-events.js";
import {
  getAgentRunContext,
  validateAgentRunDelegatedAuthority,
} from "../../../infra/agent-run-registry.js";
import type { PluginHookSpawnedRequester } from "../../../plugins/hook-agent-context.types.js";
import { resolveGlobalSingleton } from "../../../shared/global-singleton.js";

/** Upper bound on any child's lineage, whatever its run timeout says. */
const MAX_LINEAGE_MS = 30 * 60_000;

type Binding = {
  parentRunId?: string;
  childSessionKey: string;
  /** Channel the parent run arrived on; provenance only, recorded with or without authority. */
  requesterChannel?: string;
  /** Lineage, only while the parent held live delegated authority at launch. */
  projection?: PluginHookSpawnedRequester;
  keys: Set<string>;
  revoked: boolean;
  release: () => void;
};

// Source and bundled module instances must see the same host-minted lineage.
const bindings = resolveGlobalSingleton(
  Symbol.for("openclaw.subagentSpawnRequesterBindings"),
  () => new Map<string, Binding>(),
);

function revoke(binding: Binding): void {
  binding.revoked = true;
  binding.release();
  for (const key of binding.keys) {
    if (bindings.get(key) === binding) {
      bindings.delete(key);
    }
  }
}

export type SubagentRequesterBindingHandle = {
  revoke: () => void;
  /** The gateway accepted another run id: drop the lineage, keep the provenance for that run. */
  rekey: (acceptedRunId: string) => void;
};

/**
 * Host-recorded provenance of the one child run a spawn launches, keyed by the
 * child's pre-assigned runId: the parent's channel always, and lineage to the
 * admitted parent run only while that run still holds live delegated authority.
 * It proves lineage only: who the child may act for stays the plugin's decision.
 * Revoked when the child settles, at its bound, or on demand. A child run already
 * bound to another parent is never rebound.
 */
export function mintSubagentRequesterBinding(params: {
  parentRunId?: string;
  requesterChannel?: string;
  completionTarget?: "parent";
  childRunId: string;
  childAgentId: string;
  childSessionKey: string;
  childSessionId?: string;
  runTimeoutSeconds: number;
}): SubagentRequesterBindingHandle | undefined {
  const { childRunId, childAgentId, childSessionKey, childSessionId } = params;
  const previous = bindings.get(childRunId);
  if (previous && previous.parentRunId !== params.parentRunId) {
    return undefined;
  }
  if (previous) {
    revoke(previous);
  }
  const parent = params.parentRunId ? getAgentRunContext(params.parentRunId) : undefined;
  const authority = parent?.delegatedAuthority;
  const authorized = Boolean(
    params.parentRunId &&
    parent?.agentId &&
    parent.sessionKey &&
    authority &&
    validateAgentRunDelegatedAuthority(authority) &&
    childSessionId,
  );
  const timeoutMs = params.runTimeoutSeconds > 0 ? params.runTimeoutSeconds * 1000 : MAX_LINEAGE_MS;
  const boundMs = Math.min(timeoutMs, MAX_LINEAGE_MS);
  const expiresAt = Date.now() + boundMs;
  const assertCurrent = () => {
    if (binding.revoked || bindings.get(childRunId) !== binding || !binding.projection) {
      throw new Error("Sub-agent lineage is no longer active");
    }
    if (Date.now() >= expiresAt) {
      revoke(binding);
      throw new Error("Sub-agent lineage is no longer active");
    }
    const child = getAgentRunContext(childRunId);
    if (
      child?.agentId !== childAgentId ||
      child.sessionKey !== childSessionKey ||
      child.sessionId !== childSessionId
    ) {
      throw new Error("Sub-agent lineage is no longer active");
    }
  };
  const unsubscribe = onAgentEventForRun(childRunId, (event) => {
    if (
      event.stream === "lifecycle" &&
      event.data.executionSettled === true &&
      (event.data.phase === "end" || event.data.phase === "error")
    ) {
      revoke(binding);
    }
  });
  const timer = setTimeout(() => revoke(binding), boundMs);
  timer.unref?.();
  const binding: Binding = {
    ...(params.parentRunId ? { parentRunId: params.parentRunId } : {}),
    childSessionKey,
    ...(params.requesterChannel ? { requesterChannel: params.requesterChannel } : {}),
    keys: new Set([childRunId]),
    revoked: false,
    release: () => {
      clearTimeout(timer);
      unsubscribe();
    },
    ...(authorized && params.parentRunId && parent?.agentId && parent.sessionKey && childSessionId
      ? {
          projection: Object.freeze({
            parentRunId: params.parentRunId,
            parentAgentId: parent.agentId,
            parentSessionKey: parent.sessionKey,
            ...(parent.sessionId ? { parentSessionId: parent.sessionId } : {}),
            childRunId,
            childAgentId,
            childSessionKey,
            childSessionId,
            ...(params.completionTarget ? { completionTarget: params.completionTarget } : {}),
            expiresAt,
            assertCurrent,
          }),
        }
      : {}),
  };
  bindings.set(childRunId, binding);
  return {
    revoke: () => revoke(binding),
    rekey: (acceptedRunId) => {
      binding.projection = undefined;
      if (!binding.revoked && !bindings.has(acceptedRunId)) {
        binding.keys.add(acceptedRunId);
        bindings.set(acceptedRunId, binding);
      }
    },
  };
}

/** Projects lineage only to the exact child run and session it was minted for. */
export function resolveSubagentSpawnedFrom(params: {
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
}): PluginHookSpawnedRequester | undefined {
  const binding = params.runId ? bindings.get(params.runId) : undefined;
  const projection = binding?.projection;
  if (
    !projection ||
    projection.childRunId !== params.runId ||
    projection.childSessionKey !== params.sessionKey ||
    projection.childSessionId !== params.sessionId
  ) {
    return undefined;
  }
  try {
    projection.assertCurrent();
  } catch {
    return undefined;
  }
  return projection;
}

/** The channel a spawned child's parent run arrived on; provenance only, it grants nothing. */
export function resolveSubagentRequesterChannel(params: {
  runId?: string;
  sessionKey?: string;
}): string | undefined {
  const binding = params.runId ? bindings.get(params.runId) : undefined;
  return binding && !binding.revoked && binding.childSessionKey === params.sessionKey
    ? binding.requesterChannel
    : undefined;
}

/** Test-only view of the lineage minted for a child run, without its liveness checks. */
export function peekSubagentRequesterBindingForTest(
  childRunId: string,
): PluginHookSpawnedRequester | undefined {
  return bindings.get(childRunId)?.projection;
}

/** Test-only view of the parent channel recorded for a child run. */
export function peekSubagentRequesterChannelForTest(childRunId: string): string | undefined {
  return bindings.get(childRunId)?.requesterChannel;
}
