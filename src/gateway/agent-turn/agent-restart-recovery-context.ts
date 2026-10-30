import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  bindAdmittedRunRequesterContinuation,
  type AdmittedRunContext,
  createExecutionIdentityRecoveryAdmission,
} from "../../agents/admitted-run-context.js";
import { parseExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions.js";
import { resolveRestartRecoveryChannelAuthority } from "../../config/sessions/restart-recovery-state.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";

type AgentRestartRecoveryChannelContext = {
  channel: string;
  currentChannelId: string;
  currentThreadTs?: string;
  requesterAccountId?: string;
  requesterSenderId?: string;
  requesterEventId?: string;
  requesterChatId?: string;
  sameChannelThreadRequired: boolean;
  sourceTurnId: string;
};

/** Reconstructs source policy, presentation, and delivery facts from one exact recovery claim. */
export function resolveAgentRestartRecoveryContext(params: {
  isRestartRecoveryResumeRun: boolean;
  canUseInternalRuntimeHandoff: boolean;
  expectedExistingSessionId?: string;
  resolvedSessionId?: string;
  runId: string;
  sessionEntry?: SessionEntry;
}):
  | {
      messageChannel: string;
      channel?: AgentRestartRecoveryChannelContext;
      pinnedWidgetAuthoring?: true;
    }
  | undefined {
  const expectedSessionId = normalizeOptionalString(params.expectedExistingSessionId);
  const entry = params.sessionEntry;
  if (
    !params.canUseInternalRuntimeHandoff ||
    !expectedSessionId ||
    !entry ||
    expectedSessionId !== normalizeOptionalString(params.resolvedSessionId) ||
    expectedSessionId !== normalizeOptionalString(entry.sessionId) ||
    !normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) ||
    normalizeOptionalString(entry.restartRecoveryDeliveryRunId) !== params.runId
  ) {
    return undefined;
  }
  if (params.isRestartRecoveryResumeRun && entry.restartRecoverySourceIngress === "control-ui") {
    return { messageChannel: INTERNAL_MESSAGE_CHANNEL, pinnedWidgetAuthoring: true };
  }
  const messageChannel = normalizeMessageChannel(entry.restartRecoveryDeliveryContext?.channel);
  if (
    entry.restartRecoverySourceIngress !== "channel" ||
    !messageChannel ||
    !isDeliverableMessageChannel(messageChannel)
  ) {
    return undefined;
  }
  // A missing target removes delivery authority, not the source provider's policy boundary.
  const authority = resolveRestartRecoveryChannelAuthority(entry);
  return authority
    ? {
        messageChannel,
        channel: {
          channel: authority.deliveryContext.channel,
          currentChannelId: authority.deliveryContext.to,
          currentThreadTs:
            authority.deliveryContext.threadId != null
              ? String(authority.deliveryContext.threadId)
              : undefined,
          sourceTurnId: authority.sourceTurnId,
          requesterAccountId: normalizeOptionalString(entry.restartRecoveryRequesterAccountId),
          requesterSenderId: normalizeOptionalString(entry.restartRecoveryRequesterSenderId),
          ...(entry.restartRecoveryRequesterEventId
            ? { requesterEventId: normalizeOptionalString(entry.restartRecoveryRequesterEventId) }
            : {}),
          ...(entry.restartRecoveryRequesterChatId
            ? { requesterChatId: normalizeOptionalString(entry.restartRecoveryRequesterChatId) }
            : {}),
          sameChannelThreadRequired: entry.restartRecoverySameChannelThreadRequired === true,
        },
      }
    : { messageChannel };
}

/** Project requester custody only from the same native recovery admission used for dispatch. */
export function bindAgentRestartRecoveryRequesterContext(
  context: AdmittedRunContext,
  params: Parameters<typeof resolveAgentRestartRecoveryContext>[0] & {
    agentId: string;
    sessionKey?: string;
    assertCurrent: () => void;
  },
): void {
  if (!params.isRestartRecoveryResumeRun || !params.sessionKey || !params.resolvedSessionId) {
    return;
  }
  const source = resolveAgentRestartRecoveryContext(params)?.channel;
  if (!source?.requesterSenderId) {
    return;
  }
  bindAdmittedRunRequesterContinuation(context, {
    runId: params.runId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.resolvedSessionId,
    sourceTurnId: source.sourceTurnId,
    channel: source.channel,
    senderId: source.requesterSenderId,
    accountId: source.requesterAccountId,
    chatId: source.requesterChatId,
    eventId: source.requesterEventId,
    assertCurrent: params.assertCurrent,
  });
}

/** Resolve only the private token durably owned by the admitted recovery cycle. */
export function resolveAgentRestartRecoveryExecutionIdentityAdmission(params: {
  collectionEnabled: boolean;
  isRestartRecoveryResumeRun: boolean;
  retryOnly?: boolean;
  runId: string;
  sessionEntry?: SessionEntry;
}) {
  if (!params.isRestartRecoveryResumeRun || !params.collectionEnabled) {
    return undefined;
  }
  if (params.retryOnly === undefined) {
    throw new Error("restart recovery execution identity admission mode is unavailable");
  }
  const stored = (params.sessionEntry as InternalSessionEntry | undefined)?.mainRestartRecovery
    ?.executionIdentity;
  return createExecutionIdentityRecoveryAdmission({
    ...(stored ? { token: parseExecutionIdentityAdmissionToken(stored) } : {}),
    retryOnly: params.retryOnly,
    expectedOperationalRunId: params.runId,
  });
}
