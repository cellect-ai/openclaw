import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  THREAD_CONTINUATION_MAX_MEMBERS,
  type ThreadContinuationDescription,
  type ThreadContinuationMember,
  type ThreadContinuationSnapshot,
} from "../../packages/gateway-protocol/src/schema/thread-continuation.js";
import {
  isSubagentRunLive,
  isSubagentRunQueued,
  listSubagentRunsForRequester,
} from "../agents/subagents/registry/subagent-registry-read.js";
import {
  listSessionPendingInputs,
  readSessionSubmittedInput,
} from "../config/sessions/session-accessor.js";
import { listLiveSessionPendingInputs } from "../config/sessions/session-accessor.sqlite-pending-inputs.js";
import { extractEditorText } from "../config/sessions/session-message-cut-content.js";
import type { SessionPendingInputReceipt } from "../config/sessions/session-pending-input-receipt.types.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { listAgentRunsForSession, hasLiveAgentRunContext } from "../infra/agent-run-registry.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import type { RpcSourceRef } from "../sessions/session-controller.rpc-sources.js";
import { isRpcSourceRegistered } from "../sessions/session-controller.rpc-sources.js";
import { findSessionControllerEntries } from "../sessions/session-controller.state.js";
import {
  sessionChanges,
  sessionChangeScopeAffectsStoredRows,
} from "../sessions/session-row-changes.js";
import { buildRunUserTurnIdempotencyKey } from "../sessions/user-turn-transcript.metadata.js";
import type { UserTurnOriginalInputCommit } from "../sessions/user-turn-transcript.types.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { requireSessionRowProjection } from "./session-row-projection-access.js";
import type { EntryRow } from "./session-row-projection-record.js";
import { readThreadStatusObservation } from "./thread-status-observation.js";
import { getWorkerInferenceSessionControl } from "./worker-environments/inference-control-internal.js";

const gatewayInstance = randomUUID();
const SNAPSHOT_TTL_MS = 60_000;
const slackThreadKey = /^agent:[^:]+:slack:channel:([^:]+):thread:(\d+\.\d+)$/;
const changed = () =>
  new Error("Thread continuation changed or is unavailable; inspect the thread again.");
const keyOf = (row: Pick<EntryRow, "agentId" | "key">) => `${row.agentId}\0${row.key}`;
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}
function fingerprint(row: EntryRow, entry = row.entry) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        stable({
          storePath: row.storeTarget.storePath,
          entry,
          watermark: row.retainedDatabaseFacts?.activitySummaryWatermark ?? null,
        }),
      ),
    )
    .digest("hex");
}
export function threadContinuationIdempotencyKey(snapshot: ThreadContinuationSnapshot) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "thread-resume",
        snapshot.owner.agentId,
        snapshot.owner.sessionKey,
        snapshot.owner.sessionId,
        snapshot.owner.lifecycleRevision,
        snapshot.failedSessionKey,
        snapshot.failedRunId,
      ]),
    )
    .digest("hex");
}
function rowsForThread(
  context: GatewayRequestContext,
  owner: { agentId: string; sessionKey: string },
) {
  if (!slackThreadKey.test(owner.sessionKey)) throw changed();
  const projection = requireSessionRowProjection(context);
  const roots = projection.selectEntries({ key: owner.sessionKey, agentId: owner.agentId });
  if (roots.length !== 1) throw changed();
  const rows = [roots[0]!];
  const seen = new Map([[keyOf(rows[0]!), rows[0]!]]);
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    for (const child of projection.selectEntries({
      parentSessionKey: { key: row.key, agentId: row.agentId },
    })) {
      const prior = seen.get(keyOf(child));
      if (prior) {
        if (
          prior.storeTarget.storePath !== child.storeTarget.storePath ||
          !isDeepStrictEqual(prior.entry, child.entry)
        )
          throw changed();
        continue;
      }
      if (rows.length === THREAD_CONTINUATION_MAX_MEMBERS)
        throw new Error(
          "Thread membership exceeds the complete-read bound; resume is unavailable.",
        );
      seen.set(keyOf(child), child);
      rows.push(child);
    }
  }
  if (rows.some((row) => row.unresolvedDatabaseFacts || row.entryAcquisitionPending))
    throw changed();
  return rows.toSorted((a, b) => keyOf(a).localeCompare(keyOf(b)));
}
function nativeWorkState(
  context: GatewayRequestContext,
  row: EntryRow,
  own?: RpcSourceRef,
): "running" | "queued" | undefined {
  let queued = false;
  const target = captureSessionTarget({
    storeScope: row.storeTarget.storePath,
    sessionKey: row.key,
    agentId: row.agentId,
    incarnation: row.entry.sessionId,
  });
  const ownInput = own?.input;
  const physicalPaths = requireSessionRowProjection(context).physicalPaths(
    row.storeTarget.storePath,
    row.agentId,
  );
  if (
    physicalPaths.some((path) =>
      listLiveSessionPendingInputs(path, row.key, row.entry.sessionId, true).some(
        (input) => !ownInput?.protocolRunId || input.runId !== ownInput.protocolRunId,
      ),
    )
  )
    queued = true;
  if (
    listAgentRunsForSession({ sessionKey: row.key, sessionId: row.entry.sessionId }).some(
      ({ runId }) => runId !== ownInput?.protocolRunId && hasLiveAgentRunContext(runId),
    )
  )
    return "running";
  if (listSubagentRunsForRequester(row.key).some(isSubagentRunLive)) return "running";
  if (listSubagentRunsForRequester(row.key).some(isSubagentRunQueued)) queued = true;
  for (const controller of findSessionControllerEntries(row.key, target)) {
    if (controller.active && controller.active !== ownInput?.claim?.operation) return "running";
    if (controller.mailbox?.droppedCount) queued = true;
    if (controller.mailbox?.entries.some((input) => input !== ownInput && !input.custody.completed))
      queued = true;
    const claim = controller.mailbox?.claim;
    if (claim && !claim.released && !claim.inputs.every((input) => input === ownInput))
      queued = true;
    if (controller.lifecycle?.mutations.length || controller.lifecycle?.closures.size)
      return "running";
    if (
      [...(controller.lifecycle?.effects ?? [])].some(
        (effect) => effect.phase !== "released" && (!ownInput || effect.sourceInput !== ownInput),
      )
    )
      return "running";
  }
  if (
    getWorkerInferenceSessionControl(context.workerEnvironmentService)?.hasSession(
      row.entry.sessionId,
    )
  )
    return "running";
  return queued ? "queued" : undefined;
}
function describeMember(
  context: GatewayRequestContext,
  row: EntryRow,
  own?: RpcSourceRef,
): ThreadContinuationMember {
  const entry = row.entry;
  const active = nativeWorkState(context, row, own);
  const recoveryPending = Boolean(entry.resumeAfterRestart || entry.mainRestartRecovery);
  return {
    agentId: row.agentId,
    sessionKey: row.key,
    sessionId: entry.sessionId,
    lifecycleRevision: entry.lifecycleRevision ?? null,
    fingerprint: fingerprint(row),
    status: active ?? entry.status ?? "unknown",
    recoveryPending,
    updatedAt: entry.updatedAt,
    endedAt: entry.endedAt ?? null,
    terminalRunId: entry.lastRunId ?? null,
  };
}
function terminalCandidate(members: ThreadContinuationMember[]) {
  if (
    members.some(
      (member) =>
        ["running", "queued", "unknown"].includes(member.status) || member.recoveryPending,
    )
  )
    return undefined;
  const newest = members.toSorted((a, b) => (b.endedAt ?? -1) - (a.endedAt ?? -1));
  const first = newest[0];
  if (
    !first?.terminalRunId ||
    first.endedAt === null ||
    !["failed", "timeout", "interrupted"].includes(first.status)
  )
    return undefined;
  if (
    newest[1]?.endedAt === first.endedAt ||
    members.some((member) => member.updatedAt > first.endedAt!)
  )
    return undefined;
  return first;
}
async function assertNoPendingInputs(rows: EntryRow[]) {
  for (const row of rows) {
    const page = await listSessionPendingInputs(
      {
        agentId: row.agentId,
        sessionKey: row.key,
        sessionId: row.entry.sessionId,
        storePath: row.storeTarget.storePath,
      },
      { limit: 1 },
    );
    if (page.total > 0 || page.items.length > 0 || page.nextBefore !== undefined)
      throw new Error("Thread has queued input; no continuation is admissible.");
  }
}
function registrySignature(ownerKey: string) {
  return JSON.stringify(
    stable(
      listSubagentRunsForRequester(ownerKey)
        .map((run) => ({
          runId: run.runId,
          childSessionKey: run.childSessionKey,
          requesterSessionKey: run.requesterSessionKey,
          execution: run.execution,
          delivery: run.delivery,
        }))
        .sort((a, b) => a.runId.localeCompare(b.runId)),
    ),
  );
}
function assertRegistryIdle(ownerKey: string) {
  if (
    listSubagentRunsForRequester(ownerKey).some(
      (run) => isSubagentRunLive(run) || isSubagentRunQueued(run),
    )
  )
    throw changed();
}
/** Native roster and worker reads are the only source of continuation eligibility. */
export async function describeThreadContinuation(params: {
  context: GatewayRequestContext;
  owner: { agentId: string; sessionKey: string };
  assertVisible: (rows: EntryRow[]) => Promise<void>;
  assertCurrent: () => void;
  includeStatus?: boolean;
}): Promise<ThreadContinuationDescription> {
  const projection = requireSessionRowProjection(params.context);
  await projection.prepareSelection({ metadataOnly: true });
  params.assertCurrent();
  const rows = rowsForThread(params.context, params.owner);
  await params.assertVisible(rows);
  params.assertCurrent();
  const members = rows.map((row) => describeMember(params.context, row));
  const status = params.includeStatus
    ? await readThreadStatusObservation({
        rows,
        owner: params.owner,
        assertCurrent: params.assertCurrent,
      })
    : undefined;
  if (params.includeStatus) {
    await params.assertVisible(rows);
    params.assertCurrent();
    if (
      !isDeepStrictEqual(
        rowsForThread(params.context, params.owner).map((row) =>
          describeMember(params.context, row),
        ),
        members,
      )
    )
      throw changed();
  }
  const root = members.find(
    (member) =>
      member.sessionKey === params.owner.sessionKey && member.agentId === params.owner.agentId,
  )!;
  const candidate = terminalCandidate(members);
  if (!candidate)
    return {
      complete: true,
      members,
      ...(status ? { status } : {}),
      reason: "No current idle terminal failure is eligible for continuation.",
    };
  const registry = registrySignature(root.sessionKey);
  assertRegistryIdle(root.sessionKey);
  await assertNoPendingInputs(rows);
  const ownerRow = rows.find((row) => row.key === root.sessionKey && row.agentId === root.agentId)!;
  const childRun = listSubagentRunsForRequester(root.sessionKey).find(
    (run) => run.runId === candidate.terminalRunId && run.childSessionKey === candidate.sessionKey,
  );
  const triggerRunId =
    candidate.sessionKey === root.sessionKey
      ? candidate.terminalRunId
      : childRun?.requesterTurnRunId;
  const submitted = triggerRunId
    ? await readSessionSubmittedInput(
        {
          agentId: ownerRow.agentId,
          sessionKey: ownerRow.key,
          sessionId: ownerRow.entry.sessionId,
          storePath: ownerRow.storeTarget.storePath,
        },
        buildRunUserTurnIdempotencyKey(triggerRunId),
        { includeSource: true },
      )
    : undefined;
  // Complete text is required; media-only or uncorrelated legacy inputs cannot
  // be replaced with an observer summary or a different user's latest message.
  const text =
    submitted?.source === "transcript"
      ? extractEditorText(submitted.message.content)?.trim()
      : undefined;
  const media =
    Array.isArray(submitted?.message.content) &&
    submitted.message.content.some((block) => block.type !== "text");
  await params.assertVisible(rows);
  params.assertCurrent();
  const current = rowsForThread(params.context, params.owner).map((row) =>
    describeMember(params.context, row),
  );
  if (!isDeepStrictEqual(current, members) || registrySignature(root.sessionKey) !== registry)
    throw changed();
  if (!text || media)
    return {
      complete: true,
      members,
      ...(status ? { status } : {}),
      reason:
        "Exact complete triggering text is unavailable; continuation requires native input custody.",
    };
  const originalTask = childRun ? `${text}\n\nFailed delegated task:\n${childRun.task}` : text;
  return {
    complete: true,
    members,
    ...(status ? { status } : {}),
    originalTask,
    continuation: {
      version: 1,
      gatewayInstance,
      expiresAt: Date.now() + SNAPSHOT_TTL_MS,
      owner: {
        agentId: root.agentId,
        sessionKey: root.sessionKey,
        sessionId: root.sessionId,
        lifecycleRevision: root.lifecycleRevision,
      },
      failedSessionKey: candidate.sessionKey,
      failedRunId: candidate.terminalRunId!,
      members,
    },
  };
}

export type ThreadContinuationGuard = {
  assertCurrent(): void;
  bindSource(source: RpcSourceRef): void;
  assertEntry(entry: InternalSessionEntry | undefined): void;
  onSessionCommitted(entry: InternalSessionEntry): void;
  onOriginalInputCommitted(commit: UserTurnOriginalInputCommit): void;
  onPendingInputCommitted(receipt: SessionPendingInputReceipt): void;
  dispose(): void;
};
const sourceGuards = new WeakMap<RpcSourceRef, ThreadContinuationGuard>();
export function getThreadContinuationGuard(source: RpcSourceRef | undefined) {
  return source && sourceGuards.get(source);
}
/** Retain the precondition until the exact native original-input receipt takes custody. */
export async function prepareThreadContinuationGuard(params: {
  context: GatewayRequestContext;
  snapshot: ThreadContinuationSnapshot;
  runId: string;
  source?: RpcSourceRef;
}): Promise<ThreadContinuationGuard> {
  const { context, snapshot } = params;
  if (
    snapshot.gatewayInstance !== gatewayInstance ||
    snapshot.expiresAt <= Date.now() ||
    snapshot.expiresAt > Date.now() + SNAPSHOT_TTL_MS
  )
    throw changed();
  if (params.runId !== threadContinuationIdempotencyKey(snapshot)) throw changed();
  const projection = requireSessionRowProjection(context);
  const cfg = context.getRuntimeConfig();
  await projection.prepareSelection({ metadataOnly: true });
  const rows = rowsForThread(context, snapshot.owner);
  if (
    !isDeepStrictEqual(
      rows.map((row) => describeMember(context, row, params.source)),
      snapshot.members,
    )
  )
    throw changed();
  const ownerRow = rows.find(
    (row) => row.key === snapshot.owner.sessionKey && row.agentId === snapshot.owner.agentId,
  )!;
  if (
    ownerRow.entry.sessionId !== snapshot.owner.sessionId ||
    (ownerRow.entry.lifecycleRevision ?? null) !== snapshot.owner.lifecycleRevision
  )
    throw changed();
  const initialOwnerEntry = structuredClone(ownerRow.entry);
  const registry = registrySignature(snapshot.owner.sessionKey);
  assertRegistryIdle(snapshot.owner.sessionKey);
  const expected = new Map(
    snapshot.members.map((member) => [
      `${member.agentId}\0${member.sessionKey}`,
      member.fingerprint,
    ]),
  );
  const candidate = terminalCandidate(snapshot.members);
  if (
    !candidate ||
    candidate.sessionKey !== snapshot.failedSessionKey ||
    candidate.terminalRunId !== snapshot.failedRunId
  )
    throw changed();
  let source = params.source;
  let committed = false;
  let disposed = false;
  let transcriptChanged = false;
  let ownerEntry: InternalSessionEntry | undefined;
  const unsubscribe = sessionChanges.subscribeFacts((change) => {
    if (committed) return;
    if (
      ("all" in change && sessionChangeScopeAffectsStoredRows(change)) ||
      (!("all" in change) &&
        change.scope === "transcript" &&
        snapshot.members.some(
          (member) =>
            member.sessionKey === change.sessionKey &&
            (!change.agentId || member.agentId === change.agentId),
        ))
    )
      transcriptChanged = true;
  });
  const assertCurrent = () => {
    // The additional condition ends at accepted input custody. The pending
    // owner and ordinary request authority continue to validate execution.
    if (committed) return;
    if (
      disposed ||
      context.getRuntimeConfig() !== cfg ||
      requireSessionRowProjection(context) !== projection
    )
      throw changed();
    if (transcriptChanged || snapshot.expiresAt <= Date.now()) throw changed();
    if (source && (!isRpcSourceRegistered(source) || source.input.abortSignal.aborted))
      throw changed();
    const current = rowsForThread(context, snapshot.owner);
    if (
      current.length !== expected.size ||
      registrySignature(snapshot.owner.sessionKey) !== registry
    )
      throw changed();
    for (const row of current) {
      const identity = snapshot.members.find(
        (member) => member.agentId === row.agentId && member.sessionKey === row.key,
      );
      if (
        !identity ||
        row.entry.sessionId !== identity.sessionId ||
        (row.entry.lifecycleRevision ?? null) !== identity.lifecycleRevision ||
        nativeWorkState(context, row, source)
      )
        throw changed();
      if (row.entry.resumeAfterRestart || row.entry.mainRestartRecovery) throw changed();
      const own = row.agentId === snapshot.owner.agentId && row.key === snapshot.owner.sessionKey;
      if (ownerEntry && own) {
        if (!isDeepStrictEqual(row.entry, ownerEntry)) throw changed();
      } else if (fingerprint(row) !== expected.get(keyOf(row))) throw changed();
    }
  };
  const dispose = () => {
    disposed = true;
    unsubscribe();
    if (source) sourceGuards.delete(source);
  };
  try {
    await assertNoPendingInputs(rows);
    assertCurrent();
  } catch (error) {
    dispose();
    throw error;
  }
  const guard: ThreadContinuationGuard = {
    assertCurrent,
    bindSource(next: RpcSourceRef) {
      if (source && source !== next) throw changed();
      source = next;
      sourceGuards.set(next, guard);
    },
    assertEntry(entry: InternalSessionEntry | undefined) {
      if (committed) return;
      if (
        !entry ||
        entry.sessionId !== snapshot.owner.sessionId ||
        (entry.lifecycleRevision ?? null) !== snapshot.owner.lifecycleRevision
      )
        throw changed();
      if (!isDeepStrictEqual(entry, ownerEntry ?? initialOwnerEntry)) throw changed();
    },
    onSessionCommitted(entry: InternalSessionEntry) {
      // Only the native guarded write's exact committed return value is adopted.
      if (
        committed ||
        entry.sessionId !== snapshot.owner.sessionId ||
        (entry.lifecycleRevision ?? null) !== snapshot.owner.lifecycleRevision
      )
        throw changed();
      ownerEntry = structuredClone(entry);
    },
    onPendingInputCommitted(receipt: SessionPendingInputReceipt) {
      // The native staged receipt is a durable accepted input, before later
      // participant/lifecycle writes. Its private live owner binds path and run.
      if (
        !source ||
        !isRpcSourceRegistered(source) ||
        source.input.abortSignal.aborted ||
        receipt.message.idempotencyKey !== buildRunUserTurnIdempotencyKey(params.runId) ||
        !projection
          .physicalPaths(ownerRow.storeTarget.storePath, ownerRow.agentId)
          .some((path) =>
            listLiveSessionPendingInputs(path, ownerRow.key, ownerRow.entry.sessionId, true).some(
              (input) => input.inputId === receipt.inputId && input.runId === params.runId,
            ),
          )
      )
        throw changed();
      receipt.assertLifetimeCurrent?.();
      committed = true;
      unsubscribe();
    },
    onOriginalInputCommitted(commit: UserTurnOriginalInputCommit) {
      if (
        !source ||
        !isRpcSourceRegistered(source) ||
        commit.anchor.sessionId !== snapshot.owner.sessionId ||
        commit.anchor.sessionKey !== snapshot.owner.sessionKey ||
        commit.anchor.agentId !== snapshot.owner.agentId ||
        !projection
          .physicalPaths(ownerRow.storeTarget.storePath, ownerRow.agentId)
          .includes(commit.anchor.storePath) ||
        commit.message.idempotencyKey !== buildRunUserTurnIdempotencyKey(params.runId)
      )
        throw changed();
      committed = true;
      unsubscribe();
    },
    dispose,
  };
  if (source) guard.bindSource(source);
  return guard;
}
