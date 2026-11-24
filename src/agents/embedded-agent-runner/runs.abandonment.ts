import type { SessionControllerEntry } from "../../sessions/session-controller.contracts.js";
import { type ReplyOperation } from "../../sessions/session-controller.js";
import { getSessionControllerEntryForOperation } from "../../sessions/session-controller.state.js";
import {
  sessionTargetOwnersMatch,
  type SessionTarget,
} from "../../sessions/session-controller.target.js";
import {
  getEmbeddedRunAttachment,
  isCurrentEmbeddedRunAttachment,
  ABANDONED_EMBEDDED_RUNS,
  type AbandonedEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "./run-state.js";
import { normalizeSessionFileRegistryKey } from "./runs.session-index.js";

export type EmbeddedRunTimeoutRecoveryMarker = AbandonedEmbeddedRun;

type AbandonmentOwner = SessionControllerEntry | string;

type AbandonmentQuery = {
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
  target?: SessionTarget;
};

function matchesAbandonment(
  owner: AbandonmentOwner,
  abandoned: AbandonedEmbeddedRun,
  query: AbandonmentQuery,
): boolean {
  if (
    query.target &&
    (typeof owner === "string" ||
      !owner.target ||
      !sessionTargetOwnersMatch(owner.target, query.target))
  ) {
    return false;
  }
  const key = query.sessionKey?.trim() ?? query.target?.sessionKey;
  const file = query.sessionFile;
  return Boolean(
    (query.sessionId?.trim() && abandoned.sessionId === query.sessionId.trim()) ||
    (key &&
      (abandoned.sessionKey === key ||
        (typeof owner !== "string" && owner.logicalAliases.has(key)))) ||
    (file && abandoned.sessionFile === file),
  );
}

export function clearEmbeddedRunAbandonment(
  owner: AbandonmentOwner,
  params: AbandonmentQuery,
): void {
  const query = { ...params, sessionFile: normalizeSessionFileRegistryKey(params.sessionFile) };
  for (const [previousOwner, abandoned] of ABANDONED_EMBEDDED_RUNS) {
    // Idle entries are pruned. A successor may have a new entry and session ID,
    // but only the same store/agent and logical key or file clears its timeout.
    const sameScope =
      typeof owner === "string"
        ? typeof previousOwner === "string"
        : typeof previousOwner !== "string" &&
          (owner.target && previousOwner.target
            ? sessionTargetOwnersMatch(owner.target, previousOwner.target)
            : owner.target === previousOwner.target);
    if (
      previousOwner === owner ||
      (sameScope && matchesAbandonment(previousOwner, abandoned, query))
    ) {
      ABANDONED_EMBEDDED_RUNS.delete(previousOwner);
    }
  }
}

export function markActiveEmbeddedRunAbandoned(params: {
  sessionId: string;
  handle: EmbeddedAgentQueueHandle;
  sessionKey?: string;
  sessionFile?: string;
  reason: AbandonedEmbeddedRun["reason"];
}): boolean {
  const sessionId = params.sessionId.trim();
  const attachment = getEmbeddedRunAttachment(params.handle);
  if (
    !sessionId ||
    !attachment ||
    attachment.sessionId !== sessionId ||
    !isCurrentEmbeddedRunAttachment(attachment)
  ) {
    return false;
  }
  const owner = attachment.operation
    ? getSessionControllerEntryForOperation(attachment.operation)
    : sessionId;
  clearEmbeddedRunAbandonment(owner, params);
  const sessionKey = (params.sessionKey ?? attachment.sessionKey)?.trim();
  const sessionFile = normalizeSessionFileRegistryKey(params.sessionFile);
  const runId = params.handle.runId?.trim();
  ABANDONED_EMBEDDED_RUNS.set(owner, {
    sessionId,
    ...(runId ? { runId } : {}),
    abandonedAtMs: Date.now(),
    reason: params.reason,
    ...(sessionKey ? { sessionKey } : {}),
    ...(sessionFile ? { sessionFile } : {}),
  });
  return true;
}

export function resolveEmbeddedRunAbandonment(
  params: Omit<AbandonmentQuery, "sessionFile">,
): AbandonedEmbeddedRun["reason"] | undefined {
  const matches = [...ABANDONED_EMBEDDED_RUNS].filter(([owner, abandoned]) =>
    matchesAbandonment(owner, abandoned, params),
  );
  return matches.length === 1 ? matches[0]![1].reason : undefined;
}

/**
 * Temporarily releases terminal-timeout delivery suppression while a timed-out
 * attempt is performing an eligible compaction-and-retry recovery.
 */
export function markEmbeddedRunRecoveringTimeout(params: {
  sessionId: string;
  runId?: string;
  operation?: ReplyOperation;
}): EmbeddedRunTimeoutRecoveryMarker | undefined {
  const matches = params.operation
    ? [ABANDONED_EMBEDDED_RUNS.get(getSessionControllerEntryForOperation(params.operation))]
    : [...ABANDONED_EMBEDDED_RUNS.values()].filter(
        (abandoned) =>
          abandoned.sessionId === params.sessionId.trim() &&
          (!abandoned.runId || abandoned.runId === params.runId?.trim()),
      );
  const abandoned = matches.length === 1 ? matches[0] : undefined;
  if (
    !abandoned ||
    abandoned.sessionId !== params.sessionId.trim() ||
    abandoned.reason !== "timeout" ||
    (abandoned.runId && abandoned.runId !== params.runId?.trim())
  ) {
    return undefined;
  }
  abandoned.reason = "recovering_timeout";
  return abandoned;
}

/** Restores terminal-timeout suppression when recovery cannot continue. */
export function restoreEmbeddedRunTimeoutAbandonment(
  marker: EmbeddedRunTimeoutRecoveryMarker,
): boolean {
  if (
    marker.reason !== "recovering_timeout" ||
    ![...ABANDONED_EMBEDDED_RUNS.values()].includes(marker)
  ) {
    return false;
  }
  marker.reason = "timeout";
  return true;
}
