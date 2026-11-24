import type { ReplyDispatchRun } from "../../auto-reply/get-reply-options.types.js";
import { isProgressCardRefreshInputProvenance } from "../../sessions/input-provenance.js";
import { getRpcSourceStartedAt } from "../../sessions/session-controller.rpc-sources.js";
import {
  scheduleWebchatCompletionFallback,
  resolveWebchatCompletionReplies,
} from "../webchat-completion-delivery-send.js";
import { formatForLog } from "../ws-log.js";
import type { StartChatDispatchParams } from "./chat-send-agent-dispatch.types.js";
import { createChatSendReplyDispatch } from "./chat-send-reply-dispatch.js";

export function createChatCompletionFallback(
  params: StartChatDispatchParams,
  replyDispatch: ReturnType<typeof createChatSendReplyDispatch>,
  getReplyDispatchRun: () => ReplyDispatchRun | undefined,
) {
  const { admission, admissionStartedAt, context, request, session, turn } = params;
  const { cfg, clientRunId, sessionKey, agentId } = session;
  const { activeRunAbort, admittedSessionId } = admission;
  const { ctx, isInternalTextSlashCommandTurn } = turn;
  const progressRefresh = isProgressCardRefreshInputProvenance(request.systemInputProvenance);
  const scheduleCompletionFallback = async (fallbackError?: string) => {
    if (
      context.chatRunState.hasAbortMarker(clientRunId) ||
      activeRunAbort.controller.signal.aborted
    )
      return;
    try {
      await scheduleWebchatCompletionFallback({
        cfg,
        state: admission.sourceRef.adapter.webchatCompletionDelivery,
        startedAtMs: getRpcSourceStartedAt(admission.sourceRef) ?? admissionStartedAt,
        runId: clientRunId,
        sessionId: admittedSessionId,
        sessionKey,
        agentId,
        ctx,
        replies: resolveWebchatCompletionReplies({
          deliveredReplies: replyDispatch.deliveredReplies,
          foldCommandBlocks: isInternalTextSlashCommandTurn || getReplyDispatchRun() !== undefined,
          suppressReplies:
            progressRefresh ||
            (!getReplyDispatchRun() && replyDispatch.hasAppendedWebchatAgentMedia()),
        }),
        fallbackError,
        ownerConnId: admission.sourceRef.adapter.requester?.connectionId,
        ownerDeviceId: admission.sourceRef.adapter.requester?.deviceId,
        log: context.logGateway,
      });
    } catch (error) {
      context.logGateway.warn(
        `webchat completion delivery scheduling failed run=${clientRunId}: ${formatForLog(error)}`,
      );
    }
  };
  return scheduleCompletionFallback;
}
