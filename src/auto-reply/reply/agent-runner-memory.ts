import crypto from "node:crypto";
import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { resolveDefaultAgentId } from "../../agents/agent-scope-config.js";
import { MemoryFlushToolsUnavailableError } from "../../agents/agent-tools.memory-flush.js";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import { createDeferredEmbeddedRunLifecycleManager } from "../../agents/embedded-agent-runner/run/deferred-lifecycle-owner.js";
import { emitInternalRunUsageDiagnostic } from "../../agents/internal-run-usage.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import { isRestrictedBackgroundHookRun } from "../../agents/shadow-hook-tool-policy.js";
import {
  resolveAgentIdFromSessionKey,
  resolveFreshSessionTotalTokens,
} from "../../config/sessions.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { logVerbose } from "../../globals.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { emitAgentRunStatusEvent } from "../../infra/agent-run-status-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isMemoryFlushPlanNativeProviderOwned } from "../../plugins/memory-state.js";
import { CommandLane } from "../../process/lanes.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { resolveSessionPinnedHarnessId } from "../../sessions/agent-harness-session-key.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { ReplyPayload } from "../types.js";
import {
  followupOwnsNativeCompaction,
  followupUsesCliRuntime,
  resolveFollowupAgentRuntimeId,
  resolveFollowupContextTokens,
  resolveMemoryFlushSandbox,
} from "./agent-runner-memory-runtime.js";
import {
  estimateContextTokensFromSessionTranscript,
  readSessionLogSnapshot,
} from "./agent-runner-memory-transcript-context.js";
import type { MemoryFlushResult, MemoryFlushRunParams } from "./agent-runner-memory.types.js";
import { embeddedAgentRuntimeLoader } from "./agent-runner-preflight-compaction.js";
import { buildRunEntrySelection } from "./agent-runner-run-params.js";
import {
  buildEmbeddedRunExecutionParams,
  buildModelResolveContext,
  resolveRunThinkingLevelForFallbackCandidate,
} from "./agent-runner-utils.js";
import {
  buildVisibleMemoryFlushFailure,
  resolveVisibleMemoryFlushErrorPayloads,
} from "./memory-flush-errors.js";
import { recordMemoryFlushFailure } from "./memory-flush-failure.js";
import {
  isToolsMemoryFlushPlan,
  memoryFlushResultIsSilent,
  resolveMemoryFlushPlanForRun,
  type MemoryFlushPlanForRunResolution,
} from "./memory-flush-plan.js";
import {
  estimatePromptTokensForMemoryFlush,
  hasAlreadyFlushedForCurrentCompaction,
  resolveCompactionThreshold,
  resolveProjectedPromptTokens,
  shouldRunPreflightCompaction,
} from "./memory-flush.js";
import { startFollowupRunPreAdoptionHeartbeat } from "./queue/lifecycle.js";
import { resolveFollowupAbortSignal } from "./queue/types.js";

const memoryFlushLog = createSubsystemLogger("auto-reply/memory-flush");

const memoryFlushPreparationLoader = createLazyImportLoader(
  () => import("./memory-flush-prepare.js"),
);

/** Runs pre-compaction memory flush when transcript state warrants it. */
export async function runMemoryFlushIfNeeded(
  params: MemoryFlushRunParams,
): Promise<MemoryFlushResult> {
  const abortSignal = resolveFollowupAbortSignal({
    abortSignal: params.replyOperation?.abortSignal ?? params.abortSignal,
    operatorAuthority: params.followupRun.operatorAuthority,
  });
  const assertMemoryFlushCurrent = () => {
    abortSignal?.throwIfAborted();
    params.followupRun.operatorAuthority?.assertCurrent();
  };
  const { writable: memoryFlushWritable, toolPolicy: sandboxToolPolicy } =
    await resolveMemoryFlushSandbox(params, assertMemoryFlushCurrent);

  let entry =
    params.sessionEntry ??
    (params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined);
  if (entry?.incognito === true || isIncognitoSessionKey(params.sessionKey)) {
    return { sessionEntry: entry, outcome: "skipped" };
  }
  // A shadow hook run reads untrusted inbound mail with a member's private data in reach; its
  // content must never be written into the agent's shared memory.
  if (isRestrictedBackgroundHookRun(params.sessionKey, params.runtimePolicySessionKey)) {
    return { sessionEntry: entry, outcome: "skipped" };
  }
  const runtimeParams = { ...params, sessionEntry: entry };
  const runtimeId = resolveFollowupAgentRuntimeId(runtimeParams);
  const isCli =
    followupUsesCliRuntime(runtimeParams, runtimeId) ||
    followupOwnsNativeCompaction(runtimeParams, runtimeId);
  // Only a native provider's flush can persist without a writable workspace, so other
  // resolvers are never called for a session whose workspace cannot be written.
  const canAttemptFlush = (memoryFlushWritable || isMemoryFlushPlanNativeProviderOwned()) && !isCli;
  if (!canAttemptFlush) {
    return { sessionEntry: entry, outcome: "skipped" };
  }

  const flushRunId = crypto.randomUUID();
  let flushRunRegistered = false;
  const recordFailure = (error: unknown) => recordMemoryFlushFailure(error, params, entry);
  const contextWindowTokens = Math.min(
    resolveFollowupContextTokens(runtimeParams, runtimeId),
    params.recoveryContextTokenBudget ?? Number.POSITIVE_INFINITY,
  );
  let memoryFlushResolution: MemoryFlushPlanForRunResolution | null;
  try {
    memoryFlushResolution = resolveMemoryFlushPlanForRun({ cfg: params.cfg, contextWindowTokens });
  } catch (error) {
    return await recordFailure(error);
  }
  if (!memoryFlushResolution) {
    return { sessionEntry: entry, outcome: "skipped" };
  }
  const memoryFlushPlan = memoryFlushResolution.plan;
  if (!isToolsMemoryFlushPlan(memoryFlushPlan) && !memoryFlushWritable) {
    return { sessionEntry: entry, outcome: "skipped" };
  }

  if (!entry || hasAlreadyFlushedForCurrentCompaction(entry)) {
    assertMemoryFlushCurrent();
    return { sessionEntry: entry, outcome: "skipped" };
  }
  const promptTokenEstimate = estimatePromptTokensForMemoryFlush(
    params.promptForEstimate ?? params.followupRun.prompt,
  );
  const persistedPromptTokens = resolveFreshSessionTotalTokens(entry);

  // The soft margin belongs only to early flushing, leaving room before blocking compaction.
  const flushThreshold = Math.max(
    0,
    resolveCompactionThreshold({
      contextWindowTokens,
      reserveTokensFloor: memoryFlushPlan.reserveTokensFloor,
    }) - Math.max(0, Math.floor(memoryFlushPlan.softThresholdTokens)),
  );

  const shouldReadTranscript = persistedPromptTokens === undefined;

  const forceFlushTranscriptBytes = memoryFlushPlan.forceFlushTranscriptBytes;
  const sessionLogSnapshot = await readSessionLogSnapshot({
    agentId: params.followupRun.run.agentId,
    sessionId: params.followupRun.run.sessionId,
    sessionKey: params.sessionKey ?? params.followupRun.run.sessionKey,
    storePath: params.storePath,
    includeByteSize: asPositiveFiniteNumber(forceFlushTranscriptBytes) !== undefined,
    includeTurnTaint: true,
    includeUsage: shouldReadTranscript,
    abortSignal,
  });
  assertMemoryFlushCurrent();
  const transcriptByteSize = sessionLogSnapshot.byteSize;
  const shouldForceFlushByTranscriptSize =
    transcriptByteSize !== undefined && transcriptByteSize >= forceFlushTranscriptBytes;

  const transcriptUsageTokens = shouldReadTranscript
    ? await estimateContextTokensFromSessionTranscript(
        {
          agentId:
            params.followupRun.run.agentId ??
            resolveAgentIdFromSessionKey(params.sessionKey ?? params.followupRun.run.sessionKey),
          sessionId: entry.sessionId,
          sessionKey: params.sessionKey ?? params.followupRun.run.sessionKey,
          storePath: params.storePath,
          contextWindowTokens,
          abortSignal,
        },
        sessionLogSnapshot,
      )
    : undefined;
  assertMemoryFlushCurrent();
  const projectedTokenCount = resolveProjectedPromptTokens(
    asPositiveFiniteNumber(persistedPromptTokens),
    promptTokenEstimate,
    transcriptUsageTokens,
  );
  const tokenCountForFlush = asPositiveFiniteNumber(projectedTokenCount);

  const shouldFlushMemory =
    params.recoveryContextTokenBudget !== undefined ||
    shouldRunPreflightCompaction({
      entry,
      tokenCount: tokenCountForFlush,
      threshold: flushThreshold,
    }) ||
    shouldForceFlushByTranscriptSize;

  if (!shouldFlushMemory) {
    return { sessionEntry: entry, outcome: "skipped" };
  }

  params.replyOperation?.setPhase("memory_flushing");
  let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
    entry?.systemPromptReport ??
      (params.sessionKey
        ? params.sessionStore?.[params.sessionKey]?.systemPromptReport
        : undefined),
  );
  let persistenceToolCallSucceeded = false;
  let preparedAttempt: Awaited<
    ReturnType<typeof import("./memory-flush-prepare.js").prepareMemoryFlushAttempt>
  >;
  try {
    assertMemoryFlushCurrent();
    const runtime = await memoryFlushPreparationLoader.load();
    preparedAttempt = await runtime.prepareMemoryFlushAttempt({
      ...params,
      sessionEntry: entry,
      flushRunId,
      resolution: memoryFlushResolution,
      sandboxToolPolicy,
      abortSignal,
      assertCurrent: assertMemoryFlushCurrent,
      recordPersistenceToolSuccess: () => {
        persistenceToolCallSucceeded = true;
      },
    });
  } catch (error) {
    return await recordFailure(error);
  }
  if (!preparedAttempt) {
    return { sessionEntry: entry, outcome: "skipped" };
  }
  const {
    writePath: memoryFlushWritePath,
    systemPrompt: flushSystemPrompt,
    selection,
    preparedRunAdmission,
    memorySession,
    memoryAudience: flushMemoryAudience,
    memoryFlushTools,
    maintenanceRun,
    sourcePolicySessionKey,
  } = preparedAttempt;
  const deferredLifecycle = createDeferredEmbeddedRunLifecycleManager({
    runId: flushRunId,
    sessionId: memorySession.sessionId,
    sessionKey: memorySession.sessionKey,
    sessionFile: memorySession.sessionFile,
    abortSignal,
  });
  const flushedCompactionCount = entry?.compactionCount ?? 0;
  let visibleErrorPayloads: ReplyPayload[] = [];
  // Only the bounded phase belongs to the parent turn; maintenance content stays private.
  const parentRunId = params.opts?.runId;
  if (parentRunId) {
    emitAgentRunStatusEvent({
      runId: parentRunId,
      sessionKey: params.sessionKey,
      phase: "memory_flushing",
    });
  }
  const stopHeartbeat = startFollowupRunPreAdoptionHeartbeat(params.followupRun, abortSignal);
  // Only runnable maintenance owns a run context. The matching finally is
  // the sole cleanup path so setup, execution, and persistence exits cannot orphan it.
  try {
    if (params.sessionKey) {
      registerAgentRunContext(flushRunId, {
        sessionKey: memorySession.sessionKey,
        sessionId: memorySession.sessionId,
        verboseLevel: params.resolvedVerboseLevel,
        isControlUiVisible: false,
        projectSessionActive: false,
        projectSessionLifecycle: false,
        projectSessionMessages: false,
      });
      flushRunRegistered = true;
    }
    memoryFlushLog.debug("memory flush dispatched", {
      event: "memory_flush_dispatched",
      runId: flushRunId,
      sessionKey: memorySession.sessionKey,
      sessionId: memorySession.sessionId,
      sourceSessionKey: params.sessionKey,
      sourceSessionId: entry?.sessionId,
    });
    const flushExecution = await runEmbeddedAgentEntry({
      preparedRunAdmission,
      modelResolve: {
        prompt: memoryFlushPlan.prompt,
        awaitSessionDiffBaseline: params.followupRun.runObservers?.awaitSessionDiffBaseline,
        cwd: maintenanceRun.cwd,
        modelSelectionLocked: maintenanceRun.modelSelectionLocked,
        context: buildModelResolveContext({
          run: maintenanceRun,
          sessionCtx: {},
          hasRepliedRef: undefined,
          trigger: "memory",
        }),
      },
      selection: buildRunEntrySelection(selection, params.followupRun.run),
      identity: {
        runId: flushRunId,
        agentId: params.followupRun.run.agentId,
        sessionId: memorySession.sessionId,
        sessionKey: memorySession.sessionKey,
        lane: CommandLane.Main,
      },
      harness: {
        workspaceDir: params.followupRun.run.workspaceDir,
        sessionKey: sourcePolicySessionKey,
        preparation: { kind: "direct" },
        resolveRuntimeOverride: (provider) =>
          resolveSessionRuntimeOverrideForProvider({
            provider,
            entry,
            cfg: params.cfg,
          }),
      },
      behavior: { kind: "maintenance" },
      sessionOverride: { kind: "preserve" },
      abortSignal: deferredLifecycle.signal,
      runCandidate: async (provider, model, runOptions) => {
        const sessionRuntimeOverride = runOptions.agentHarnessRuntimeOverride;
        const candidateThinkLevel = resolveRunThinkingLevelForFallbackCandidate({
          cfg: params.cfg,
          provider,
          modelId: model,
          run: params.followupRun.run,
          catalog: params.followupRun.run.thinkingCatalog,
          agentId: params.followupRun.run.agentId,
          sessionKey: sourcePolicySessionKey,
          sessionEntry: entry,
          agentRuntime: sessionRuntimeOverride,
        });
        const runBaseParams = await buildEmbeddedRunExecutionParams({
          run: {
            ...maintenanceRun,
            thinkLevel: candidateThinkLevel,
          },
          sessionCtx: {},
          hasRepliedRef: undefined,
          provider,
          model,
          runId: flushRunId,
          promptCacheKey: params.opts?.promptCacheKey,
          allowTransientCooldownProbe: runOptions.allowTransientCooldownProbe,
        });
        const runtime = await embeddedAgentRuntimeLoader.load();
        const result = await runtime.runEmbeddedAgent({
          preparedRunAdmission,
          ...runBaseParams,
          awaitSessionDiffBaseline: params.followupRun.runObservers?.awaitSessionDiffBaseline,
          ...memorySession,
          agentHarnessId: resolveSessionPinnedHarnessId(entry),
          agentHarnessRuntimeOverride: sessionRuntimeOverride,
          sandboxSessionKey: sourcePolicySessionKey,
          memoryAudience: flushMemoryAudience,
          allowGatewaySubagentBinding: true,
          silentExpected: true,
          allowEmptyAssistantReplyAsSilent: true,
          terminalReplyExpectation: "optional",
          trigger: "memory",
          contextTokenBudget: contextWindowTokens,
          memoryFlushWritePath,
          memoryFlushTools,
          initialTurnTainted:
            !params.followupRun.run.senderIsOwner || sessionLogSnapshot?.turnTainted === true,
          prompt: memoryFlushPlan.prompt,
          transcriptPrompt: "",
          extraSystemPrompt: flushSystemPrompt,
          isFinalFallbackAttempt: runOptions.isFinalFallbackAttempt,
          resolvedModelSelection: runOptions.resolvedModelSelection,
          modelFallbacksOverride: runOptions.modelFallbacksOverride,
          bootstrapPromptWarningSignaturesSeen,
          bootstrapPromptWarningSignature: bootstrapPromptWarningSignaturesSeen.at(-1),
          abortSignal: deferredLifecycle.signal,
          onDeferredLifecycleOwner: deferredLifecycle.adopt,
          onDeferredLifecycleAbort: deferredLifecycle.abort,
          onRetryWait: deferredLifecycle.beginRetryWait,
          assistantErrorTranscript: runOptions.assistantErrorTranscript,
          authProfileFailurePolicy: runOptions.authProfileFailurePolicy,
          contextEngineLogicalTurnLease: runOptions.contextEngineLogicalTurnLease,
          onContextEngineTurnCandidate: runOptions.onContextEngineTurnCandidate,
        });
        visibleErrorPayloads = resolveVisibleMemoryFlushErrorPayloads(result.payloads);
        bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
          result.meta?.systemPromptReport,
        );
        return result;
      },
    });
    await emitInternalRunUsageDiagnostic(flushExecution.result, {
      config: params.cfg,
      agentId: params.followupRun.run.agentId ?? resolveDefaultAgentId(params.cfg),
      agentDir: params.followupRun.run.agentDir,
      sessionId: memorySession.sessionId,
      sessionKey: memorySession.sessionKey,
      provider: flushExecution.provider,
      model: flushExecution.model,
    });
    deferredLifecycle.signal.throwIfAborted();
    if (visibleErrorPayloads.length > 0) {
      // Do not stamp memory-flush success for a resolved run that returned an error.
      throw buildVisibleMemoryFlushFailure(visibleErrorPayloads);
    }
    if (
      memoryFlushTools &&
      !persistenceToolCallSucceeded &&
      !memoryFlushResultIsSilent(flushExecution.result)
    ) {
      throw new Error("no persistence tool call succeeded");
    }
    if (params.storePath && params.sessionKey) {
      try {
        const updatedEntry = await updateSessionEntry(
          { storePath: params.storePath, sessionKey: params.sessionKey },
          async () => ({
            memoryFlush: { kind: "succeeded", compactionCount: flushedCompactionCount },
          }),
          { skipMaintenance: true, takeCacheOwnership: true },
        );
        if (updatedEntry) {
          entry = updatedEntry;
        }
      } catch (err) {
        logVerbose(`failed to persist memory flush metadata: ${String(err)}`);
      }
    }
    return { sessionEntry: entry, outcome: "completed" };
  } catch (error) {
    if (error instanceof MemoryFlushToolsUnavailableError) {
      memoryFlushLog.debug(error.message);
      return { sessionEntry: entry, outcome: "skipped" };
    }
    return await recordFailure(error);
  } finally {
    stopHeartbeat?.();
    if (parentRunId && !abortSignal?.aborted) {
      emitAgentRunStatusEvent({
        runId: parentRunId,
        sessionKey: params.sessionKey,
        phase: "preparing_context",
      });
    }
    await deferredLifecycle.complete();
    if (flushRunRegistered) {
      clearAgentRunContext(flushRunId);
    }
    preparedRunAdmission.close();
    preparedAttempt.release();
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

export { runSessionCompactionIfNeeded } from "./agent-runner-preflight-compaction.js";
