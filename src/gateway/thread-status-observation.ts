import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ThreadObservedTask,
  ThreadStatusObservation,
} from "../../packages/gateway-protocol/src/schema/thread-continuation.js";
import { listSubagentRunsForRequester } from "../agents/subagents/registry/subagent-registry-read.js";
import { readSessionSubmittedInput } from "../config/sessions/session-accessor.js";
import { extractEditorText } from "../config/sessions/session-message-cut-content.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { buildRunUserTurnIdempotencyKey } from "../sessions/user-turn-transcript.metadata.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { EntryRow } from "./session-row-projection-record.js";
import { readSessionTranscriptBoundedMessageTailPageAsync } from "./session-transcript-readers.js";

const EVENT_LIMIT = 200;
const nonempty = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);

/** Descriptive native history. The caller retains and rechecks row visibility and identity. */
export async function readThreadStatusObservation(params: {
  rows: EntryRow[];
  owner: { agentId: string; sessionKey: string };
  assertCurrent: () => void;
}): Promise<ThreadStatusObservation> {
  params.assertCurrent();
  const owner = params.rows.find(
    (row) => row.key === params.owner.sessionKey && row.agentId === params.owner.agentId,
  );
  if (!owner) throw new Error("Thread status owner is unavailable");
  const ownerTarget = {
    agentId: owner.agentId,
    sessionKey: owner.key,
    sessionId: owner.entry.sessionId,
    storePath: owner.storeTarget.storePath,
  };
  const selectedRows = params.rows.map((row) => ({
    agentId: row.agentId,
    key: row.key,
    sessionId: row.entry.sessionId,
    lifecycleRevision: row.entry.lifecycleRevision ?? null,
    lastRunId: row.entry.lastRunId,
    status: row.entry.status,
    storePath: row.storeTarget.storePath,
  }));
  const readChildRuns = () =>
    selectedRows
      .flatMap((row) => listSubagentRunsForRequester(row.key))
      .map((run) => ({
        runId: run.runId,
        childSessionKey: run.childSessionKey,
        childAgentId: run.childAgentId ?? resolveAgentIdFromSessionKey(run.childSessionKey),
        childSessionIdentity: run.childSessionIdentity
          ? { ...run.childSessionIdentity }
          : undefined,
        requesterSessionKey: run.requesterSessionKey,
        createdAt: run.createdAt,
        task: run.task,
      }));
  const childRuns = readChildRuns();
  const context = captureOpenClawStateReadWorkerContext({});
  const assertCurrent = () => {
    context.admission.assertCurrent();
    params.assertCurrent();
  };
  const heads = await executeExistingOpenClawStateRead(
    {},
    {
      type: "sessionState.versions",
      input: selectedRows.map((row) => ({ sessionKey: row.key, agentId: row.agentId })),
    },
    { context },
  );
  assertCurrent();
  const tasks = new Map<string, ThreadObservedTask>();
  let historyAvailable = heads !== undefined;
  let historyComplete = historyAvailable;
  let latestAvailable = historyAvailable;
  for (const row of selectedRows) {
    if (!heads) break;
    const head = heads.versions[row.agentId]?.[row.key] ?? 0;
    const afterSequence = Math.max(0, head - EVENT_LIMIT);
    const result = await executeExistingOpenClawStateRead(
      {},
      {
        type: "sessionState.events",
        input: { sessionKey: row.key, agentId: row.agentId, afterSequence, limit: EVENT_LIMIT },
      },
      { context },
    );
    assertCurrent();
    if (!result) {
      historyAvailable = false;
      historyComplete = false;
      latestAvailable = false;
      break;
    }
    historyComplete &&= afterSequence === 0 && !result.page.truncated && !result.page.historyGap;
    latestAvailable &&= !result.page.truncated;
    for (const event of result.page.events) {
      if (event.sessionKey !== row.key || event.agentId !== row.agentId)
        throw new Error("Thread history returned a different owner");
      const childRun = childRuns.find(
        (run) =>
          run.runId === event.runId &&
          run.childSessionKey === row.key &&
          run.childAgentId === row.agentId &&
          run.childSessionIdentity?.sessionId === row.sessionId &&
          (run.childSessionIdentity.lifecycleRevision ?? null) === row.lifecycleRevision,
      );
      if (event.sessionId ? event.sessionId !== row.sessionId : !childRun) {
        historyComplete = false;
        continue;
      }
      if (event.kind !== "run_failed" && event.kind !== "run_completed") continue;
      if (!event.runId) {
        historyComplete = false;
        latestAvailable = false;
        continue;
      }
      const outcome = nonempty(event.payload?.outcome);
      const identity = JSON.stringify([row.agentId, row.key, row.sessionId, event.runId]);
      const previous = tasks.get(identity);
      if (previous && previous.sequence >= event.sequence) continue;
      tasks.set(identity, {
        taskId: event.runId,
        status:
          event.kind === "run_completed"
            ? "succeeded"
            : outcome === "timeout"
              ? "timed_out"
              : outcome === "cancelled"
                ? "cancelled"
                : "failed",
        agentId: row.agentId,
        ownerKey: row.key,
        requesterSessionKey: childRun?.requesterSessionKey ?? row.key,
        createdAt: childRun?.createdAt ?? null,
        lastEventAt: event.occurredAt,
        sequence: event.sequence,
        ...(event.kind === "run_failed"
          ? { error: outcome ? `${event.summary} (${outcome})` : event.summary }
          : {}),
        task: childRun?.task ?? null,
        observationSummary: event.summary,
      });
    }
  }
  const tail = await readSessionTranscriptBoundedMessageTailPageAsync(ownerTarget, {
    maxMessages: 400,
    maxBytes: 1024 * 1024,
    offset: 0,
    readOnly: true,
  });
  assertCurrent();
  let lastTool: string | null = null;
  let lastToolAt: string | null = null;
  let lastError: string | null = null;
  // Sparse salvaged older events cannot establish the most recent tool/error.
  const suffix =
    tail.newestContiguousEventCount > 0 ? tail.events.slice(-tail.newestContiguousEventCount) : [];
  for (const { event } of suffix.toReversed()) {
    if (!isRecord(event) || !isRecord(event.message)) continue;
    const message = event.message;
    const first = Array.isArray(message.content) ? message.content[0] : undefined;
    if (!lastTool && message.role === "toolResult") {
      lastTool =
        nonempty(message.toolName) ??
        (isRecord(first) ? (nonempty(first.toolName) ?? nonempty(first.name)) : null);
      if (lastTool) lastToolAt = nonempty(event.timestamp);
    }
    if (!lastError) {
      lastError = nonempty(message.errorMessage);
      if (!lastError && isRecord(first) && first.isError === true)
        lastError = nonempty(first.content)?.slice(0, 500) ?? null;
      if (!lastError && message.isError === true && isRecord(first))
        lastError = nonempty(first.text)?.slice(0, 500) ?? null;
    }
  }
  const latestTask = latestAvailable
    ? ([...tasks.values()].toSorted(
        (a, b) => b.lastEventAt - a.lastEventAt || b.sequence - a.sequence,
      )[0] ?? null)
    : null;
  if (latestTask && latestTask.task === null) {
    const selected = selectedRows.find(
      (row) => row.key === latestTask.ownerKey && row.agentId === latestTask.agentId,
    )!;
    const submitted = await readSessionSubmittedInput(
      {
        agentId: selected.agentId,
        sessionKey: selected.key,
        sessionId: selected.sessionId,
        storePath: selected.storePath,
      },
      buildRunUserTurnIdempotencyKey(latestTask.taskId),
      { includeSource: true },
    );
    assertCurrent();
    if (
      submitted &&
      (!Array.isArray(submitted.message.content) ||
        submitted.message.content.every((part) => part.type === "text"))
    )
      latestTask.task = extractEditorText(submitted.message.content)?.trim() || null;
  }
  if (!isDeepStrictEqual(readChildRuns(), childRuns))
    throw new Error("Thread descriptive run identity changed");
  const currentTerminalCoverageComplete = selectedRows.every((row) => {
    if (!row.lastRunId) return false;
    const observation = tasks.get(
      JSON.stringify([row.agentId, row.key, row.sessionId, row.lastRunId]),
    );
    if (!observation) return false;
    return row.status === "done"
      ? observation.status === "succeeded"
      : row.status === "failed"
        ? observation.status === "failed"
        : row.status === "timeout"
          ? observation.status === "timed_out"
          : false;
  });
  return {
    lastTool,
    lastToolAt,
    lastError: latestTask?.error ?? lastError,
    latestTask,
    taskCount: historyAvailable ? tasks.size : null,
    historyAvailable,
    historyComplete: historyComplete && currentTerminalCoverageComplete,
    historyScope: "retained-terminal-observations",
    currentTerminalCoverageComplete,
    transcriptComplete: tail.newestContiguousEventCount === tail.totalMessages,
  };
}
