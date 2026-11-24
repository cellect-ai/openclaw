import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { prepareLocalWorkspaceAttachments } from "../../agents/workspace-attachments.local.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSnapshotMetadata,
  hashRuntimeConfigValue,
} from "../../config/runtime-snapshot.js";
import type { ApplyMediaUnderstandingResult } from "../../media-understanding/apply.js";
import { hasStagedMediaFacts, type MediaFact } from "../../media/media-facts.js";
import {
  getReplyOperationSessionReader,
  getReplyOperationSessionTarget,
} from "../../sessions/session-controller.session-reader.js";
import { captureChannelReadScope } from "../../shared/channel-read-authority.js";
import { canReadReplyAttachmentPaths } from "./get-reply-preprocessing.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import type { StageSandboxMediaResult } from "./stage-sandbox-media.js";

// Only native filesystem failures are eligible. Permission/authentication errors,
// generic exceptions, and wrappers with unknown provenance retain their failure.
const LOCAL_IO_CODES = new Set(["EIO", "ENOSPC", "EROFS", "EMFILE", "ENFILE"]);

/** Return a retained assertion, never a new local-read grant or replacement input. */
export async function recoverManagedPdfStagingFailure(params: {
  error: unknown;
  policy: Parameters<typeof canReadReplyAttachmentPaths>[0];
  options: InternalGetReplyOptions | undefined;
  canDisclose: boolean;
  assertCurrent: () => void;
}): Promise<() => void> {
  const { error, policy, options } = params;
  try {
    if (
      !(error instanceof Error) ||
      error.name !== "Error" ||
      !("code" in error) ||
      typeof error.code !== "string" ||
      !LOCAL_IO_CODES.has(error.code) ||
      !("syscall" in error) ||
      typeof error.syscall !== "string" ||
      !params.canDisclose ||
      options?.disableTools === true ||
      policy.stagedAttachmentCount !== 0 ||
      policy.sessionCtx.MediaRemoteHost ||
      resolveSandboxConfigForAgent(policy.cfg, policy.agentId).backend === "ssh" ||
      (
        policy.sessionEntry.skillLibrarySelections ??
        policy.sessionEntry.skillsSnapshot?.librarySelections
      )?.length
    ) {
      throw error;
    }
    const operation = options?.replyOperation;
    const reader = getReplyOperationSessionReader(operation);
    const target = getReplyOperationSessionTarget(operation);
    if (
      !operation ||
      !reader ||
      !target ||
      reader.sessionKey !== policy.sessionKey ||
      reader.logicalAgentId !== policy.agentId ||
      operation.sessionId !== policy.sessionEntry.sessionId
    ) {
      throw error;
    }
    const configRevision = getRuntimeConfigSnapshotMetadata();
    const channelRead = captureChannelReadScope();
    const media = policy.sessionCtx.media?.map((fact) => ({ ...fact })) ?? [];
    const mediaIdentity = JSON.stringify(media);
    const entryIdentity = JSON.stringify(policy.sessionEntry);
    const stagingWorkspace =
      resolveIngressWorkspaceOverrideForSessionRun({
        spawnedBy: policy.sessionEntry.spawnedBy,
        workspaceDir: policy.sessionEntry.spawnedWorkspaceDir,
        cwd: policy.sessionEntry.spawnedCwd,
      }) ?? policy.workspaceDir;
    const assertCurrent = () => {
      try {
        options?.abortSignal?.throwIfAborted();
        operation.abortSignal.throwIfAborted();
        options?.operatorAuthority?.assertCurrent();
        if (options?.internalEventExecution) {
          if (!options.internalEventExecution.assertCurrent) throw error;
          options.internalEventExecution.assertCurrent();
        }
        params.assertCurrent();
        channelRead?.assertCurrent();
        reader.assertCurrent();
        if (
          operation.result ||
          getReplyOperationSessionReader(operation) !== reader ||
          getReplyOperationSessionTarget(operation) !== target ||
          getRuntimeConfigSnapshot() !== policy.cfg ||
          getRuntimeConfigSnapshotMetadata() !== configRevision ||
          !configRevision ||
          hashRuntimeConfigValue(policy.cfg) !== configRevision.fingerprint ||
          JSON.stringify(policy.sessionCtx.media ?? []) !== mediaIdentity ||
          JSON.stringify(policy.sessionEntry) !== entryIdentity ||
          getAgentWorkspaceAccess(policy.workspaceDir) ||
          getAgentWorkspaceAccess(stagingWorkspace)
        ) {
          throw error;
        }
      } catch {
        throw error;
      }
    };
    assertCurrent();
    const before = await reader.readEntry(assertCurrent);
    assertCurrent();
    if (
      before.entry.sessionId !== policy.sessionEntry.sessionId ||
      before.entry.lifecycleRevision !== policy.sessionEntry.lifecycleRevision ||
      !(await canReadReplyAttachmentPaths({
        ...policy,
        spawnedBy: before.entry.spawnedBy,
        sessionEntry: before.entry,
      }))
    ) {
      throw error;
    }
    assertCurrent();
    const verified = await prepareLocalWorkspaceAttachments({
      media,
      execution: { config: policy.cfg, readAllowed: true, maxChars: 60_000 },
      requireManagedPdf: true,
      assertCurrent,
    });
    assertCurrent();
    const after = await reader.readEntry(assertCurrent);
    assertCurrent();
    if (!verified || JSON.stringify(before.entry) !== JSON.stringify(after.entry)) {
      throw error;
    }
    return assertCurrent;
  } catch {
    // No authorization, cancellation, provider, or unknown error becomes success.
    throw error;
  }
}

/** Keep final path disclosure adjacent to the retained recovery assertion. */
export async function prepareReplyAttachmentPaths(params: {
  stage?: (
    awaitSessionDiffBaseline: (() => Promise<void>) | undefined,
  ) => Promise<StageSandboxMediaResult>;
  beforeStage?: () => Promise<void>;
  stagedMedia: readonly MediaFact[] | undefined;
  policy: Parameters<typeof canReadReplyAttachmentPaths>[0];
  options: InternalGetReplyOptions | undefined;
  enableLocalPathSelfServe: ApplyMediaUnderstandingResult["enableLocalPathSelfServe"];
  contexts: Parameters<NonNullable<ApplyMediaUnderstandingResult["enableLocalPathSelfServe"]>>[0];
  assertCurrent: () => void;
}): Promise<void> {
  let staged: ReadonlyMap<number, string> = hasStagedMediaFacts(params.stagedMedia)
    ? new Map(
        (params.stagedMedia ?? []).flatMap((fact, index) =>
          fact.path ? [[index, fact.path] as const] : [],
        ),
      )
    : new Map<number, string>();
  let assertRecovered: (() => void) | undefined;
  if (params.stage) {
    let baselineFailed = false;
    const awaitBaseline = params.beforeStage
      ? async () => {
          try {
            await params.beforeStage?.();
          } catch (error) {
            baselineFailed = true;
            throw error;
          }
        }
      : undefined;
    const contextMedia = JSON.stringify(params.contexts.map((ctx) => ctx.media));
    try {
      staged = (await params.stage(awaitBaseline)).staged;
    } catch (error) {
      // Keep the native baseline ordering; its failure is never attachment recovery.
      if (baselineFailed) throw error;
      assertRecovered = await recoverManagedPdfStagingFailure({
        error,
        policy: { ...params.policy, stagedAttachmentCount: staged.size },
        options: params.options,
        canDisclose: Boolean(params.enableLocalPathSelfServe),
        assertCurrent: () => {
          params.assertCurrent();
          if (JSON.stringify(params.contexts.map((ctx) => ctx.media)) !== contextMedia) {
            throw error;
          }
        },
      });
    }
  }
  if (
    params.enableLocalPathSelfServe &&
    params.options?.disableTools !== true &&
    (assertRecovered ||
      (await canReadReplyAttachmentPaths({
        ...params.policy,
        stagedAttachmentCount: staged.size,
      })))
  ) {
    assertRecovered?.();
    params.enableLocalPathSelfServe(params.contexts, staged.size > 0 ? staged : undefined);
  }
}
