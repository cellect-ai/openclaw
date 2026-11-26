import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveEffectiveCompactionReserveTokens } from "../../agents/agent-compaction-constants.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope-config.js";
import { readCompactionTranscriptBytes } from "../../agents/compaction-transcript-bytes.js";
import { isBenignCompactionSkipResult } from "../../agents/embedded-agent-runner/compact-reasons.js";
import type { AcceptedCompactionSuccessor } from "../../agents/embedded-agent-runner/compaction-successor.js";
import { resolveModelCallUrgency } from "../../agents/run-trigger.js";
import { resolvePersistedSessionRuntimeId } from "../../agents/session-runtime-compat.js";
import type { CompactionRequestBudget } from "../../agents/sessions/compaction/request-budget.types.js";
import {
  resolveAgentIdFromSessionKey,
  resolveFreshSessionTotalTokens,
  resolveSessionStorePathCore,
  type InternalSessionEntry as SessionEntry,
} from "../../config/sessions.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveMaxActiveTranscriptBytes,
  refreshTranscriptByteCompactionLatch,
} from "../../context-engine/transcript-byte-limit.js";
import { logVerbose } from "../../globals.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isUnscopedSessionKeySentinel } from "../../routing/session-key.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import { acknowledgeReplySessionTransition } from "../../sessions/session-controller.state.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import {
  defersTokenCompactionToChatGPTBoundary,
  followupOwnsNativeCompaction,
  followupUsesCliRuntime,
  resolveFollowupAgentRuntimeId,
  resolveFollowupContextTokens,
} from "./agent-runner-memory-runtime.js";
import { estimateContextTokensFromSessionTranscript } from "./agent-runner-memory-transcript-context.js";
import {
  resolveCompactionCompletionNotice,
  type CompactionNoticePhase,
} from "./compaction-notice.js";
import { resolveMemoryFlushPlanForRun } from "./memory-flush-plan.js";
import {
  TRANSCRIPT_OUTPUT_READ_BUFFER_TOKENS,
  estimatePromptTokensForMemoryFlush,
  resolveCompactionThreshold,
  resolveProjectedPromptTokens,
  resolveResponsesServerCompactionThreshold,
  shouldRunPreflightCompaction,
  settleFailedPreflightCompaction,
} from "./memory-flush.js";
import { appendPostCompactionRefreshPrompt } from "./post-compaction-context.js";
import { refreshQueuedFollowupSession, type FollowupRun } from "./queue.js";
import { startFollowupRunPreAdoptionHeartbeat } from "./queue/lifecycle.js";
import { incrementCompactionCount } from "./session-updates.js";

const preflightCompactionLog = createSubsystemLogger("auto-reply/preflight-compaction");

export const embeddedAgentRuntimeLoader = createLazyImportLoader(
  () => import("../../agents/embedded-agent.js"),
);

/** Compacts session context before a reply or after a completed direct command. */
export async function runSessionCompactionIfNeeded(params: {
  replyOperation?: ReplyOperation;
  pendingUserEntryId?: string;
  compactionRequestBudget?: CompactionRequestBudget;
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  promptForEstimate?: string;
  defaultModel: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  runtimePolicySessionKey?: string;
  storePath?: string;
  /** Completed commands carry the actual harness, not the originally requested runtime. */
  agentHarnessId?: string;
  abortSignal?: AbortSignal;
  authorize?: () => boolean;
  beforeCompaction?: (entry: SessionEntry) => Promise<SessionEntry | undefined>;
  onCompactionStart?: () => void;
  onCompactionCommitted?: (accepted: AcceptedCompactionSuccessor) => void;
  onSessionIdChanged?: (sessionId: string) => void;
  onCompactionNotice?: (phase: CompactionNoticePhase, text?: string) => Promise<void> | void;
}): Promise<SessionEntry | undefined> {
  const operatorAuthority = params.followupRun.operatorAuthority;
  const assertActive = () => {
    params.abortSignal?.throwIfAborted();
    operatorAuthority?.assertCurrent();
    if (params.authorize?.() === false) {
      throw new Error("Session compaction maintenance is no longer active");
    }
  };
  if (!params.sessionKey) {
    return params.sessionEntry;
  }

  let entry = params.sessionEntry ?? params.sessionStore?.[params.sessionKey];
  if (!entry?.sessionId) {
    return entry;
  }

  const runtimeParams = { ...params, sessionEntry: entry };
  assertActive();
  const runtimeId = resolveFollowupAgentRuntimeId(runtimeParams);
  const isCli = followupUsesCliRuntime(runtimeParams, runtimeId);
  const ownsNativeCompaction = followupOwnsNativeCompaction(runtimeParams, runtimeId);
  if (isCli || ownsNativeCompaction || normalizeLowercaseStringOrEmpty(runtimeId) === "codex") {
    // Native compaction never reaches the pre-compaction hook below, so the checkpoint
    // (which gates itself on token pressure and transcript size) would never run for Codex.
    if (params.beforeCompaction) {
      const refreshed = await params.beforeCompaction(entry);
      assertActive();
      return refreshed ?? entry;
    }
    return entry;
  }

  const compactionSessionKey = params.sessionKey;
  const configuredAgentId = params.followupRun.run.agentId ?? resolveDefaultAgentId(params.cfg);
  const compactionAgentId = isUnscopedSessionKeySentinel(compactionSessionKey)
    ? configuredAgentId
    : resolveAgentIdFromSessionKey(compactionSessionKey, configuredAgentId);
  const compactionStorePath = resolveSessionStorePathForScope({
    agentId: compactionAgentId,
    sessionKey: compactionSessionKey,
    storePath:
      params.storePath ??
      resolveSessionStorePathCore(params.cfg.session?.store, { agentId: compactionAgentId }),
  });
  const compactionStore = params.sessionStore ?? { [compactionSessionKey]: entry };
  const compactionTarget = {
    agentId: compactionAgentId,
    sessionKey: compactionSessionKey,
    storePath: compactionStorePath,
  };
  const readTranscriptSize = async (sessionId: string) =>
    readCompactionTranscriptBytes({
      target: { ...compactionTarget, sessionId },
      rawBytes: undefined,
      runtime: params.followupRun.run,
      maxBytes: maxActiveTranscriptBytes,
      signal: params.abortSignal,
    });

  const contextWindowTokens = resolveFollowupContextTokens(runtimeParams, runtimeId);
  const memoryFlushPlan = resolveMemoryFlushPlanForRun({
    cfg: params.cfg,
    contextWindowTokens,
  })?.plan;
  const reserveTokensFloor =
    memoryFlushPlan?.reserveTokensFloor ??
    resolveEffectiveCompactionReserveTokens({
      contextTokenBudget: contextWindowTokens,
      reserveTokens: 20_000,
    });
  const freshPersistedTokens = resolveFreshSessionTotalTokens(entry);
  const promptTokenEstimate = estimatePromptTokensForMemoryFlush(
    params.promptForEstimate ?? params.followupRun.prompt,
  );
  const responsesServerCompactionThreshold = resolveResponsesServerCompactionThreshold({
    contextWindowTokens,
    cfg: params.cfg,
    provider: params.followupRun.run.provider,
    modelId: params.followupRun.run.model ?? params.defaultModel,
  });
  const threshold = resolveCompactionThreshold({
    contextWindowTokens,
    reserveTokensFloor,
    minimumThresholdTokens: responsesServerCompactionThreshold,
  });
  const freshNeedsOutputRead =
    freshPersistedTokens !== undefined &&
    promptTokenEstimate !== undefined &&
    threshold > 0 &&
    freshPersistedTokens + promptTokenEstimate >= threshold - TRANSCRIPT_OUTPUT_READ_BUFFER_TOKENS;
  const maxActiveTranscriptBytes = resolveMaxActiveTranscriptBytes(params.cfg);
  const shouldCheckActiveTranscriptBytes = maxActiveTranscriptBytes !== undefined;
  const transcriptUsageTokens =
    freshPersistedTokens !== undefined && !freshNeedsOutputRead
      ? undefined
      : await estimateContextTokensFromSessionTranscript({
          ...compactionTarget,
          abortSignal: params.abortSignal,
          sessionId: entry.sessionId,
          contextWindowTokens,
        });
  const activeTranscriptBytes = shouldCheckActiveTranscriptBytes
    ? await readTranscriptSize(entry.sessionId)
    : undefined;
  assertActive();
  const exceedsTranscriptByteThreshold =
    activeTranscriptBytes !== undefined &&
    maxActiveTranscriptBytes !== undefined &&
    activeTranscriptBytes >= maxActiveTranscriptBytes;
  let terminalCompactionNoticeSent = false;
  const notifyCompaction = async (phase: CompactionNoticePhase, text?: string) => {
    terminalCompactionNoticeSent = phase !== "start";
    try {
      await params.onCompactionNotice?.(phase, text);
    } catch (err) {
      logVerbose(`preflightCompaction notice delivery failed: ${String(err)}`);
    }
  };
  const latch = entry.transcriptByteCompactionLatch;
  const refreshedTranscriptByteCompactionLatch = refreshTranscriptByteCompactionLatch(
    latch,
    entry.sessionId,
    maxActiveTranscriptBytes,
    activeTranscriptBytes,
  );
  const transcriptByteCompactionLatched =
    exceedsTranscriptByteThreshold && refreshedTranscriptByteCompactionLatch !== undefined;
  if (refreshedTranscriptByteCompactionLatch !== latch) {
    const compactionCount = await incrementCompactionCount({
      ...compactionTarget,
      amount: 0,
      expectedSession: entry,
      sessionStore: compactionStore,
      transcriptByteCompactionLatch: refreshedTranscriptByteCompactionLatch ?? null,
    });
    assertActive();
    if (compactionCount === undefined) {
      throw new Error("Session changed before byte-compaction progress could be cleared");
    }
    entry = compactionStore[compactionSessionKey] ?? entry;
  }
  const shouldCompactByTranscriptBytes =
    exceedsTranscriptByteThreshold && !transcriptByteCompactionLatched;
  if (transcriptByteCompactionLatched) {
    await notifyCompaction("context_bounded");
    assertActive();
  }
  const projectedTokenCount = resolveProjectedPromptTokens(
    freshPersistedTokens,
    promptTokenEstimate,
    transcriptUsageTokens,
  );
  const tokenCountForCompaction = asPositiveFiniteNumber(projectedTokenCount);

  const shouldCompactByTokens = shouldRunPreflightCompaction({
    entry,
    tokenCount: tokenCountForCompaction,
    threshold,
  });
  if (!shouldCompactByTokens && !shouldCompactByTranscriptBytes) {
    return entry;
  }

  if (params.beforeCompaction) {
    const refreshed = await params.beforeCompaction(entry);
    assertActive();
    // Memory checkpointing may refresh source usage; replan once without repeating it.
    return runSessionCompactionIfNeeded({
      ...params,
      sessionEntry: refreshed,
      beforeCompaction: undefined,
    });
  }

  if (
    shouldCompactByTokens &&
    !shouldCompactByTranscriptBytes &&
    (await defersTokenCompactionToChatGPTBoundary(params.followupRun.run))
  ) {
    assertActive();
    return entry;
  }

  const compactionTrigger = shouldCompactByTranscriptBytes ? "transcript_bytes" : "tokens";
  assertActive();
  params.onCompactionStart?.();
  // Provider work can outlive the caller; never account against a replacement session row.
  let expectedSession = entry;
  let admissionTransition: AcceptedCompactionSuccessor["admissionTransition"];
  let hostAccountingCommitted = false;
  const recordCompactionAccounting = async (
    acceptedEntry: SessionEntry,
    tokensAfter: number | undefined,
    compactionKind: Parameters<typeof incrementCompactionCount>[0]["compactionKind"],
    amount = 1,
  ) => {
    const postCompactionBytes = exceedsTranscriptByteThreshold
      ? await readTranscriptSize(acceptedEntry.sessionId)
      : undefined;
    assertActive();
    const transcriptByteCompactionLatch =
      postCompactionBytes !== undefined &&
      maxActiveTranscriptBytes !== undefined &&
      postCompactionBytes >= maxActiveTranscriptBytes
        ? {
            activeBytes: postCompactionBytes,
            sessionId: acceptedEntry.sessionId,
            maxBytes: maxActiveTranscriptBytes,
          }
        : undefined;
    const compactionCount = await incrementCompactionCount({
      ...compactionTarget,
      sessionStore: compactionStore,
      amount,
      tokensAfter,
      compactionKind,
      expectedSession: acceptedEntry,
      transcriptByteCompactionLatch: transcriptByteCompactionLatch ?? null,
      authorize: () => {
        assertActive();
        return true;
      },
    });
    if (compactionCount === undefined) {
      throw new Error("Session changed before compaction maintenance could be recorded");
    }
  };
  const stopHeartbeat = startFollowupRunPreAdoptionHeartbeat(
    params.followupRun,
    params.abortSignal,
  );
  try {
    await notifyCompaction("start");
    assertActive();
    const runtime = await embeddedAgentRuntimeLoader.load();
    const result = await runtime.compactEmbeddedAgentSession(
      {
        sessionId: entry.sessionId,
        sessionKey: compactionSessionKey,
        sessionTarget: { ...compactionTarget, sessionId: entry.sessionId },
        sandboxSessionKey: params.runtimePolicySessionKey,
        allowGatewaySubagentBinding: true,
        messageChannel: params.followupRun.run.messageProvider,
        clientCaps: params.followupRun.run.clientCaps,
        conversationToolPolicy: params.followupRun.run.conversationToolPolicy,
        requesterOrigin: params.followupRun.run.requesterOrigin,
        conversationId: params.followupRun.run.conversationId,
        messageThreadId: params.followupRun.run.messageThreadId,
        operatorProfileId: params.followupRun.run.operatorProfileId,
        senderIsOwner: params.followupRun.run.senderIsOwner,
        groupId: entry.groupId ?? params.followupRun.run.groupId,
        groupChannel: entry.groupChannel ?? params.followupRun.run.groupChannel,
        groupSpace: entry.space ?? params.followupRun.run.groupSpace,
        senderId: params.followupRun.run.senderId,
        senderName: params.followupRun.run.senderName,
        senderUsername: params.followupRun.run.senderUsername,
        senderE164: params.followupRun.run.senderE164,
        inputProvenance: params.followupRun.run.inputProvenance,
        sessionFile: compactionSessionKey,
        workspaceDir: params.followupRun.run.workspaceDir,
        cwd: params.followupRun.run.cwd,
        agentDir: params.followupRun.run.agentDir,
        config: params.cfg,
        // Group session keys do not encode account identity, so without this the
        // preflight path resolves the root history limit after prompt preparation
        // already used the account limit.
        agentAccountId: params.followupRun.run.agentAccountId,
        conversationRoutePeerId: params.followupRun.run.conversationRoutePeerId,
        chatType: params.followupRun.run.chatType,
        // The session projection omits runtime catalogs; reuse this turn's hydrated selection.
        skillsSnapshot: params.followupRun.run.skillsSnapshot ?? entry.skillsSnapshot,
        provider: params.followupRun.run.provider,
        model: params.followupRun.run.model,
        authProfileId: params.followupRun.run.authProfileId,
        authProfileIdSource: params.followupRun.run.authProfileIdSource,
        sessionEntry: entry,
        agentHarnessId:
          params.agentHarnessId ??
          (entry.sessionId === params.followupRun.run.sessionId
            ? entry.modelSelectionLocked === true
              ? resolvePersistedSessionRuntimeId(entry)
              : runtimeId
            : undefined),
        modelSelectionLocked: entry.modelSelectionLocked === true,
        thinkLevel: params.followupRun.run.thinkLevel,
        bashElevated: params.followupRun.run.bashElevated,
        trigger: "budget",
        modelCallUrgency: resolveModelCallUrgency({
          ...params.followupRun.run,
          trigger: "user",
          currentInboundEventKind: params.followupRun.currentInboundEventKind,
        }),
        force: true,
        forcePreflight: true,
        preflightRequired: true,
        preflightCompactionTrigger: compactionTrigger,
        deferOwningContextEngineCompaction: false,
        contextTokenBudget: contextWindowTokens,
        currentTokenCount: tokenCountForCompaction ?? freshPersistedTokens,
        ownerNumbers: params.followupRun.run.ownerNumbers,
        abortSignal: params.abortSignal,
      },
      {
        assertActive,
        sourceAuthority: { assertActive, operatorAuthority },
        requestBudget: params.compactionRequestBudget,
        pendingUserEntryId: params.pendingUserEntryId,
        // Record every host compaction while its session lane still excludes the next writer.
        onHostCompactionCommitted: async (commit) => {
          await recordCompactionAccounting(
            commit.entry,
            commit.tokensAfter,
            commit.compactionKind,
            hostAccountingCommitted ? 0 : 1,
          );
          hostAccountingCommitted = true;
        },
        onCommitted: (accepted) => {
          admissionTransition = accepted.admissionTransition;
          expectedSession = accepted.entry;
          entry = accepted.entry;
          compactionStore[compactionSessionKey] = accepted.entry;
          params.onCompactionCommitted?.(accepted);
        },
      },
    );

    if (!result?.ok || !result.compacted) {
      assertActive();
      const reason =
        (result?.ok ? normalizeOptionalString(result.reason) : result?.reason) ?? "not_compacted";
      if (!exceedsTranscriptByteThreshold && result && isBenignCompactionSkipResult(result)) {
        await notifyCompaction("skipped");
        logVerbose(`preflightCompaction skipped: sessionKey=${params.sessionKey} reason=${reason}`);
        return entry;
      }
      preflightCompactionLog.warn(`preflight compaction failed: ${reason}`);
      if (exceedsTranscriptByteThreshold) {
        await recordCompactionAccounting(expectedSession, undefined, undefined, 0);
        assertActive();
        await notifyCompaction("context_bounded");
        return compactionStore[compactionSessionKey] ?? entry;
      }
      await notifyCompaction("incomplete");
      assertActive();
      return settleFailedPreflightCompaction(
        entry,
        reason,
        tokenCountForCompaction,
        contextWindowTokens,
      );
    }

    if (params.replyOperation && admissionTransition) {
      await acknowledgeReplySessionTransition(params.replyOperation, admissionTransition);
      assertActive();
    }
    if (!hostAccountingCommitted) {
      await recordCompactionAccounting(
        expectedSession,
        result.result?.tokensAfter,
        result.compactionKind,
      );
    }
    assertActive();
    entry = compactionStore[compactionSessionKey] ?? entry;
    const transcriptByteCompactionLatch = entry.transcriptByteCompactionLatch;
    if (transcriptByteCompactionLatch) {
      preflightCompactionLog.warn(
        "byte-triggered compaction left oversized history; continuing with bounded context",
        {
          sessionKey: compactionSessionKey,
          activeTranscriptBytes: transcriptByteCompactionLatch.activeBytes,
          maxActiveTranscriptBytes: transcriptByteCompactionLatch.maxBytes,
        },
      );
    }
    await appendPostCompactionRefreshPrompt({
      cfg: params.cfg,
      followupRun: params.followupRun,
    });
    assertActive();
    const notice = resolveCompactionCompletionNotice(
      result,
      Boolean(transcriptByteCompactionLatch),
    );
    await notifyCompaction(notice.phase, notice.text);
    assertActive();
    entry = compactionStore[compactionSessionKey] ?? entry;
    const previousSessionId = params.followupRun.run.sessionId;
    params.followupRun.run.sessionId = entry.sessionId;
    params.onSessionIdChanged?.(entry.sessionId);
    const queueKey = params.followupRun.run.sessionKey ?? params.sessionKey;
    if (queueKey) {
      params.followupRun.run.sessionFile = queueKey;
      refreshQueuedFollowupSession({
        key: queueKey,
        previousSessionId,
        nextSessionId: entry.sessionId,
        nextSessionFile: queueKey,
      });
    }
    return entry;
  } catch (err) {
    if (!terminalCompactionNoticeSent && !params.abortSignal?.aborted) {
      await notifyCompaction("incomplete");
    }
    throw err;
  } finally {
    stopHeartbeat?.();
  }
}
