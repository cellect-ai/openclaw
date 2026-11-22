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
  projection: PluginHookSpawnedRequester;
  revoked: boolean;
  release: () => void;
};

// Source and bundled module instances must see the same host-minted lineage.
const bindings = resolveGlobalSingleton(
  Symbol.for("openclaw.subagentSpawnRequesterBindings"),
  () => new Map<string, Binding>(),
);

function revoke(childRunId: string, binding: Binding): void {
  binding.revoked = true;
  binding.release();
  if (bindings.get(childRunId) === binding) {
    bindings.delete(childRunId);
  }
}

/**
 * Host-proven lineage from an admitted parent run to the one child run it launches,
 * keyed by the child's pre-assigned runId. It proves lineage only: who the child may
 * act for stays the plugin's decision. Minted only while the parent still holds live
 * delegated authority; revoked when the child settles, at its bound, or on demand.
 */
export function mintSubagentRequesterBinding(params: {
  parentRunId?: string;
  childRunId: string;
  childAgentId: string;
  childSessionKey: string;
  childSessionId?: string;
  runTimeoutSeconds: number;
}): { revoke: () => void } | undefined {
  const { childRunId, childAgentId, childSessionKey, childSessionId } = params;
  const previous = bindings.get(childRunId);
  if (previous) {
    revoke(childRunId, previous);
  }
  const parent = params.parentRunId ? getAgentRunContext(params.parentRunId) : undefined;
  const authority = parent?.delegatedAuthority;
  if (
    !params.parentRunId ||
    !parent?.agentId ||
    !parent.sessionKey ||
    !authority ||
    !validateAgentRunDelegatedAuthority(authority) ||
    !childSessionId
  ) {
    return undefined;
  }
  const timeoutMs = params.runTimeoutSeconds > 0 ? params.runTimeoutSeconds * 1000 : MAX_LINEAGE_MS;
  const boundMs = Math.min(timeoutMs, MAX_LINEAGE_MS);
  const expiresAt = Date.now() + boundMs;
  const assertCurrent = () => {
    if (binding.revoked || bindings.get(childRunId) !== binding) {
      throw new Error("Sub-agent lineage is no longer active");
    }
    if (Date.now() >= expiresAt) {
      revoke(childRunId, binding);
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
      revoke(childRunId, binding);
    }
  });
  const timer = setTimeout(() => revoke(childRunId, binding), boundMs);
  timer.unref?.();
  const binding: Binding = {
    revoked: false,
    release: () => {
      clearTimeout(timer);
      unsubscribe();
    },
    projection: Object.freeze({
      parentRunId: params.parentRunId,
      parentAgentId: parent.agentId,
      parentSessionKey: parent.sessionKey,
      ...(parent.sessionId ? { parentSessionId: parent.sessionId } : {}),
      childRunId,
      childAgentId,
      childSessionKey,
      childSessionId,
      expiresAt,
      assertCurrent,
    }),
  };
  bindings.set(childRunId, binding);
  return { revoke: () => revoke(childRunId, binding) };
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

/** Test-only view of the binding minted for a child run, without its liveness checks. */
export function peekSubagentRequesterBindingForTest(
  childRunId: string,
): PluginHookSpawnedRequester | undefined {
  return bindings.get(childRunId)?.projection;
}
