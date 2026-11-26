import { hasCompletionMessageSessionSpawn } from "../../agents/accepted-session-spawn.js";
import {
  hasCommittedSourceReplyDeliveryEvidence,
  hasCompletedSourceReplyDeliveryEvidence,
  hasVisibleCommittedMessagingToolDeliveryEvidence,
  resolveExplicitFinalSourceReplyDeliveryEvidence,
  resolveSourceReplyDelivery,
} from "../../agents/embedded-agent-runner/delivery-evidence.js";
import {
  createMissingReplyNotice,
  MISSING_REPLY_NOTICE_TEXT,
  isRequiredReplyExpectation,
  isSyntheticSourceReplyTurn,
  resolveClaimedReplyExpectation,
  resolveReplyCompletion,
  shouldDeliverMissingReplyNotice,
} from "../../agents/reply-completion.js";
import { selectLegacyHeartbeatReplyPayloads } from "../../cron/legacy-heartbeat-reply-policy.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import {
  getReplyPayloadMetadata,
  isReplyPayloadTerminalContent,
  markReplyPayloadForSourceSuppressionDelivery,
  selectAutomationReplyPayloads,
} from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  normalizeAssistantFinalDeliveryText,
  resolveTerminalReplyDelivery,
} from "./agent-runner-core.js";
import type { AgentTurnExecutionResult } from "./agent-runner-execution.types.js";
import {
  markPostCompactionModelFailurePayload,
  renderPostCompactionModelFailurePayload,
} from "./agent-runner-failure-reply.js";
import type { AccountedAgentTurn } from "./agent-runner-result-accounting.js";
import { appendUsageLine, resolveResponseUsageLine } from "./agent-runner-usage-line.js";
import {
  resolveAutomationReplyState,
  retainAutomationReasoningWithFinal,
} from "./automation-reply-payloads.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery-payloads.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import type { AdmittedFollowupTurn } from "./reply-agent-turn-preparation.js";
import {
  resolveFollowupReplyExpectation,
  resolveSourceReplyVisibilityPolicy,
} from "./source-reply-delivery-mode.js";
import {
  isReplyOperationStalledBeforeOutput,
  resolveStalledTurnNoticeText,
} from "./stalled-turn-recovery.js";
import { resolveStrandedReplyRecovery } from "./stranded-reply-recovery.js";
import { buildWaitingStatusPayload } from "./waiting-status.js";

export function resolveFollowupPayloadContext(turn: AdmittedFollowupTurn) {
  return {
    cfg: turn.config,
    messageProvider: turn.queued.run.messageProvider,
    originatingAccountId: turn.queued.originatingAccountId ?? turn.queued.run.agentAccountId,
    originatingChannel: turn.queued.originatingChannel,
    originatingChatType: turn.queued.originatingChatType,
    originatingReplyToMode: turn.queued.originatingReplyToMode,
    originatingTo: turn.queued.originatingTo,
    originatingThreadId: turn.queued.originatingThreadId,
  };
}

export async function resolveFollowupDeliveryDecision(params: {
  turn: AdmittedFollowupTurn;
  execution: AgentTurnExecutionResult;
  accounting?: Pick<
    AccountedAgentTurn,
    | "providerUsed"
    | "modelUsed"
    | "terminalFailurePayload"
    | "payloadArray"
    | "usage"
    | "preserveUserFacingSessionState"
    | "replyUsageState"
    | "preparePricing"
  > & {
    compactionNotice?: ReplyPayload;
    diagnosticsPayload?: ReplyPayload;
  };
  opts?: InternalGetReplyOptions;
}) {
  const { turn, execution, accounting, opts } = params;
  if (turn.sendPolicy === "deny") {
    return { kind: "suppress" as const, reason: "send-policy" as const };
  }
  if (
    turn.queued.currentInboundEventKind === "room_event" &&
    !isInternalMessageChannel(turn.queued.originatingChannel)
  ) {
    return { kind: "suppress" as const, reason: "room-event" as const };
  }
  const sourcePolicy = resolveSourceReplyVisibilityPolicy({
    cfg: turn.config,
    scheduledAutomation: turn.queued.run.scheduledAutomation !== undefined,
    ctx: {
      ChatType: turn.queued.originatingChatType ?? turn.queued.run.chatType,
      InboundEventKind: turn.queued.currentInboundEventKind,
      Provider: turn.queued.originatingChannel ?? turn.queued.run.messageProvider,
      Surface: turn.queued.originatingChannel ?? turn.queued.run.messageProvider,
    },
    requested: turn.queued.run.sourceReplyDeliveryMode ?? opts?.sourceReplyDeliveryMode,
    sendPolicy: turn.sendPolicy,
  });
  const terminalReplyExpectation = resolveFollowupReplyExpectation(turn.queued, turn.config);
  const isInteractive =
    isRequiredReplyExpectation(terminalReplyExpectation) ||
    (!isSyntheticSourceReplyTurn({
      inputProvenance: turn.queued.run.inputProvenance,
      scheduledAutomation: turn.queued.run.scheduledAutomation !== undefined,
    }) &&
      !isInternalMessageChannel(
        turn.queued.originatingChannel ?? turn.queued.run.messageProvider,
      ) &&
      Boolean(
        turn.queued.originatingTo?.trim() ||
        opts?.onBlockReply ||
        turn.queued.queuedFollowupReplyDisposition?.kind === "deliver",
      ));
  const deliveryContext = resolveFollowupPayloadContext(turn);
  const preparePayloads = (
    payloads: ReplyPayload[],
    options: Omit<
      Parameters<typeof resolveFollowupDeliveryPayloads>[0],
      "payloads" | keyof typeof deliveryContext
    > = {},
  ) => resolveFollowupDeliveryPayloads({ ...deliveryContext, ...options, payloads });
  if (execution.outcome.kind === "aborted") {
    // The one recovery run for a stalled turn stalled too: the notice is the last resort.
    // Like the dispatch-owned notice it replaces, it bypasses message-tool-only suppression.
    if (
      turn.queued.stalledTurnRecovery === true &&
      isReplyOperationStalledBeforeOutput(turn.operation)
    ) {
      const payloads = preparePayloads([
        markReplyPayloadForSourceSuppressionDelivery({
          text: resolveStalledTurnNoticeText(turn.operation),
          isError: true,
        }),
      ]);
      if (payloads.length > 0) {
        return { kind: "deliver" as const, payloads };
      }
    }
    return { kind: "suppress" as const, reason: "aborted" as const };
  }
  const postCompactionModelFailure = execution.outcome.postCompactionModelFailure;
  const renderFailurePayloads = (payloads: ReplyPayload[]) =>
    payloads.map((payload) =>
      renderPostCompactionModelFailurePayload(
        markPostCompactionModelFailurePayload(postCompactionModelFailure, payload),
      ),
    );
  if (execution.outcome.kind === "rejected") {
    if (!isInteractive) {
      return { kind: "suppress" as const, reason: "silent" as const };
    }
    if (
      sourcePolicy.sourceReplyDeliveryMode === "message_tool_only" &&
      getReplyPayloadMetadata(execution.outcome.payload)?.deliverDespiteSourceReplySuppression !==
        true
    ) {
      return { kind: "suppress" as const, reason: "message-tool-only" as const };
    }
    const payloads = renderFailurePayloads(
      preparePayloads([execution.outcome.payload], {
        reasoningPayloadsEnabled: opts?.reasoningPayloadsEnabled === true,
        commentaryPayloadsEnabled: opts?.commentaryPayloadsEnabled === true,
      }),
    );
    return payloads.length > 0
      ? {
          kind: "deliver" as const,
          payloads,
          resolved: execution.outcome.resolved,
        }
      : { kind: "suppress" as const, reason: "silent" as const };
  }
  if (!accounting) {
    return { kind: "suppress" as const, reason: "silent" as const };
  }
  const runtimeResolved = {
    provider: accounting.providerUsed,
    model: accounting.modelUsed,
  };
  const result = execution.outcome.result;
  const terminalRunFailed = execution.outcome.status === "failed";
  const missingReplyNoticeAllowed = shouldDeliverMissingReplyNotice({
    ...turn.queued.run,
    scheduledAutomation: turn.queued.run.scheduledAutomation !== undefined,
    terminalReplyExpectation,
    trigger: turn.queued.run.internalEventExecution ? "event" : "user",
    currentInboundEventKind: turn.queued.currentInboundEventKind,
  });
  const {
    authoredSilence,
    pendingContinuation,
    automationNoChange,
    reasoningPayloadsEnabled,
    successfulTerminal,
  } = resolveAutomationReplyState(execution.outcome, {
    opts,
    terminalFailurePayload: accounting.terminalFailurePayload,
    legacyHeartbeatExplicitOnly:
      turn.queued.run.scheduledAutomation?.job.legacyHeartbeatReplyPolicy === true &&
      turn.queued.run.sourceReplyDeliveryMode === "message_tool_only",
  });
  const directBlockDeliveries = execution.outcome.directBlockDeliveries;
  const sourceReplyDelivery = resolveSourceReplyDelivery(
    result,
    await resolveTerminalReplyDelivery({
      directBlockDeliveries,
      resolveReplyDelivery: opts?.resolveReplyDelivery,
      sourceReplyDeliveryState: result.sourceReplyDeliveryState,
    }),
  );
  let completion = resolveReplyCompletion(
    resolveClaimedReplyExpectation(terminalReplyExpectation, result.meta),
    result.meta?.error?.kind === "hook_block" || result.didSendDeterministicApprovalPrompt === true
      ? "blocked"
      : authoredSilence
        ? "silent"
        : sourceReplyDelivery !== "missing"
          ? sourceReplyDelivery
          : automationNoChange
            ? "silent"
            : pendingContinuation
              ? "pending"
              : "empty",
  );
  const explicitSilence = completion.outcome === "silent";
  const sourcePayloads = selectAutomationReplyPayloads(
    selectLegacyHeartbeatReplyPayloads({
      explicitOnly:
        turn.queued.run.scheduledAutomation?.job.legacyHeartbeatReplyPolicy === true &&
        turn.queued.run.sourceReplyDeliveryMode === "message_tool_only",
      payloads: accounting.payloadArray,
      result: execution.outcome.automation?.result,
      successful: successfulTerminal,
      pending: pendingContinuation,
    }),
    automationNoChange,
    authoredSilence,
  );
  if ((explicitSilence || automationNoChange) && sourcePayloads.length === 0) {
    return { kind: "suppress" as const, reason: "silent" as const };
  }
  const completedSourceDelivery = hasCompletedSourceReplyDeliveryEvidence(result);
  const hasLegacyMessagingToolEvidence =
    result.sourceReplyDeliveryState === undefined &&
    resolveExplicitFinalSourceReplyDeliveryEvidence(result) === undefined;
  const assistantFinalText = normalizeAssistantFinalDeliveryText(
    result.meta?.finalAssistantVisibleText ?? "",
  );
  let payloads = preparePayloads(sourcePayloads, {
    reasoningPayloadsEnabled,
    commentaryPayloadsEnabled: opts?.commentaryPayloadsEnabled === true,
    sentMediaUrls: result.messagingToolSentMediaUrls,
    sentTargets: result.messagingToolSentTargets,
    sentTexts: result.messagingToolSentTexts,
    onDeliveredTerminalDuplicate: hasLegacyMessagingToolEvidence
      ? () => {
          if (completion.outcome !== "blocked") {
            completion = resolveReplyCompletion(terminalReplyExpectation, "delivered");
          }
        }
      : undefined,
  });
  if (!completedSourceDelivery && completion.outcome === "delivered") {
    await opts?.onObservedReplyDelivery?.();
  }
  const recovery =
    explicitSilence ||
    terminalRunFailed ||
    !missingReplyNoticeAllowed ||
    completion.outcome !== "missing"
      ? ({ kind: "none" } as const)
      : resolveStrandedReplyRecovery({
          base: turn.queued,
          payloads,
          finalText: assistantFinalText,
          terminalReply: result.meta?.terminalReply,
          sourceReplyDeliveryMode: sourcePolicy.sourceReplyDeliveryMode,
          sendPolicyDenied: sourcePolicy.sendPolicyDenied,
          successfulSourceReplyDelivery: completedSourceDelivery,
          isRoomEvent: false,
        });
  if (recovery.kind === "retry") {
    return {
      kind: "retry-source-delivery" as const,
      run: recovery.run,
      finalTextLength: assistantFinalText.trim().length,
      resolved: runtimeResolved,
    };
  }
  if (recovery.kind === "diagnostic") {
    const [payload] = preparePayloads([recovery.payload]);
    return payload
      ? { kind: "deliver" as const, payloads: [payload], resolved: runtimeResolved }
      : { kind: "suppress" as const, reason: "silent" as const };
  }
  const hasTerminalPayload = payloads.some(
    (payload) =>
      isReplyPayloadTerminalContent(payload) &&
      // Private terminal content is not an empty result. Source visibility is
      // enforced below; genuine failures and yield acknowledgments still win.
      ((!terminalRunFailed && !pendingContinuation) ||
        sourcePolicy.sourceReplyDeliveryMode !== "message_tool_only" ||
        getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true),
  );
  if (!hasTerminalPayload && completion.outcome === "missing" && !turn.operation.result) {
    turn.operation.fail("run_failed", new Error(MISSING_REPLY_NOTICE_TEXT));
    opts?.onAgentRunTerminalOutcome?.("failed");
  }
  const waitingStatusParams = {
    completion,
    continuationPending: result.meta?.continuationPending === true,
    mediaContinuation:
      result.meta?.continuationPending === true &&
      !hasCompletionMessageSessionSpawn(result.acceptedSessionSpawns),
    yielded: result.meta?.yielded === true,
    yieldAcknowledgment: result.meta?.yieldAcknowledgment,
    // Child spawns are side effects, not user-visible messages. They must not
    // suppress the explicit waiting reply for the parent turn.
    hasVisibleMessageDelivery:
      hasCommittedSourceReplyDeliveryEvidence(result) ||
      hasVisibleCommittedMessagingToolDeliveryEvidence(result) ||
      result.didSendDeterministicApprovalPrompt === true,
  };
  const waitingStatusPayload = terminalRunFailed
    ? undefined
    : buildWaitingStatusPayload(waitingStatusParams);
  const fallbackPayload = terminalRunFailed
    ? accounting.terminalFailurePayload &&
      isInteractive &&
      completion.outcome !== "delivered" &&
      completion.outcome !== "pending" &&
      completion.outcome !== "blocked"
      ? sourcePolicy.sourceReplyDeliveryMode === "message_tool_only"
        ? markReplyPayloadForSourceSuppressionDelivery(accounting.terminalFailurePayload)
        : accounting.terminalFailurePayload
      : undefined
    : (waitingStatusPayload ??
      (missingReplyNoticeAllowed && completion.outcome === "missing"
        ? createMissingReplyNotice()
        : undefined));
  if (!hasTerminalPayload && fallbackPayload) {
    payloads.push(...preparePayloads([fallbackPayload]));
  }
  if (accounting.compactionNotice) {
    payloads.unshift(...preparePayloads([accounting.compactionNotice]));
  }
  if (accounting.diagnosticsPayload && payloads.length > 0) {
    payloads.push(...preparePayloads([accounting.diagnosticsPayload]));
  }
  const responseUsageLine = await resolveResponseUsageLine({
    preparePricing: accounting.preparePricing,
    config: turn.config,
    sessionRaw: turn.session.current()?.responseUsage,
    channel: resolveOriginMessageProvider({
      originatingChannel: turn.queued.originatingChannel,
      provider: turn.queued.run.messageProvider,
    }),
    usage: accounting.usage,
    provider: accounting.providerUsed,
    model: accounting.modelUsed,
    preserveUserFacingSessionState: accounting.preserveUserFacingSessionState,
    replyUsageState: accounting.replyUsageState,
  });
  let sourceUsageFooter: ReplyPayload | undefined;
  if (responseUsageLine) {
    if (
      sourcePolicy.sourceReplyDeliveryMode === "message_tool_only" &&
      hasCompletedSourceReplyDeliveryEvidence(result)
    ) {
      sourceUsageFooter = markReplyPayloadForSourceSuppressionDelivery({
        text: responseUsageLine,
        isStatusNotice: true,
      });
    } else {
      payloads = appendUsageLine(payloads, responseUsageLine);
    }
  }
  payloads = renderFailurePayloads(payloads);
  if (sourceUsageFooter) {
    payloads = [...payloads, sourceUsageFooter];
  }
  if (sourcePolicy.sourceReplyDeliveryMode === "message_tool_only") {
    payloads = payloads.filter(
      (payload) => getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true,
    );
    if (payloads.length === 0) {
      return { kind: "suppress" as const, reason: "message-tool-only" as const };
    }
  }
  if (execution.outcome.automation) {
    payloads = retainAutomationReasoningWithFinal(payloads);
  }
  return payloads.length > 0
    ? { kind: "deliver" as const, payloads, resolved: runtimeResolved }
    : { kind: "suppress" as const, reason: "silent" as const };
}
