import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AdmittedRunContext } from "../../agents/admitted-run-context.js";
import { buildChannelSourceTurnId } from "../../auto-reply/reply/source-turn-id.js";
import { loadTranscriptEvents } from "../../config/sessions/session-transcript-events.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { normalizeConversationPeerId } from "../../routing/conversation-ref.js";
import {
  bindAgentRestartRecoveryRequesterContext,
  resolveAgentRestartRecoveryContext,
} from "./agent-restart-recovery-context.js";
import type { StartAgentRunExecutionParams } from "./agent-run-execution-types.js";

/** Upgrade old claims from their exact original transcript event, never recent history. */
export function restoreRestartRecoveryRequesterEvent(
  entry: SessionEntry,
  events: readonly unknown[],
): SessionEntry {
  const source = entry.restartRecoveryDeliverySourceRunId;
  const delivery = entry.restartRecoveryDeliveryContext;
  const accountId = entry.restartRecoveryRequesterAccountId;
  const senderId = entry.restartRecoveryRequesterSenderId;
  if (
    !source ||
    !delivery?.channel ||
    !delivery.to ||
    !senderId ||
    !source.startsWith("channel-user:v1:")
  ) {
    return entry;
  }
  const matches = events.flatMap((event) => {
    const row = asOptionalRecord(event);
    const message = asOptionalRecord(row?.message);
    const meta = asOptionalRecord(message?.["__openclaw"]);
    const transport = asOptionalRecord(meta?.transport);
    const provenance = asOptionalRecord(message?.provenance);
    const eventId = normalizeOptionalString(transport?.messageId);
    return message?.role === "user" &&
      message.idempotencyKey === source &&
      (message.provenance === undefined || provenance?.kind === "external_user") &&
      meta?.senderId === senderId &&
      transport?.channel === delivery.channel &&
      eventId &&
      buildChannelSourceTurnId({
        provider: delivery.channel,
        accountId,
        conversationId: delivery.to,
        messageId: eventId,
      }) === source
      ? [eventId]
      : [];
  });
  if (matches.length !== 1) {
    return entry;
  }
  return {
    ...entry,
    restartRecoveryRequesterChatId: normalizeConversationPeerId(delivery.channel, delivery.to),
    restartRecoveryRequesterEventId: matches[0],
  };
}

/** Read once under native admission; retained hook capabilities keep live task custody. */
export async function prepareRestartRecoveryRequesterEntry(
  params: Parameters<typeof resolveAgentRestartRecoveryContext>[0] & {
    agentId: string;
    sessionKey?: string;
    storePath: string;
    assertCurrent: () => void;
  },
): Promise<SessionEntry | undefined> {
  const entry = params.sessionEntry;
  if (
    !params.isRestartRecoveryResumeRun ||
    !entry ||
    !params.sessionKey ||
    !params.resolvedSessionId ||
    (entry.restartRecoveryRequesterChatId && entry.restartRecoveryRequesterEventId) ||
    !resolveAgentRestartRecoveryContext(params)?.channel?.requesterSenderId
  ) {
    return entry;
  }
  params.assertCurrent();
  const events = await loadTranscriptEvents({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.resolvedSessionId,
    storePath: params.storePath,
    readConsistency: "latest",
  });
  params.assertCurrent();
  return restoreRestartRecoveryRequesterEvent(entry, events);
}

/** One prepared native source owns presentation and later requester binding together. */
export function prepareAgentRestartRecoveryContext(
  execution: Pick<
    StartAgentRunExecutionParams,
    | "isRestartRecoveryResumeRun"
    | "canUseInternalRuntimeHandoff"
    | "resolvedSessionId"
    | "runId"
    | "sessionEntry"
    | "activeSessionAgentId"
    | "resolvedSessionKey"
  > & {
    request: Pick<StartAgentRunExecutionParams["request"], "expectedExistingSessionId">;
  },
  owner: { storePath: string; assertCurrent: () => void },
) {
  const source = {
    isRestartRecoveryResumeRun: execution.isRestartRecoveryResumeRun,
    canUseInternalRuntimeHandoff: execution.canUseInternalRuntimeHandoff,
    expectedExistingSessionId: execution.request.expectedExistingSessionId,
    resolvedSessionId: execution.resolvedSessionId,
    runId: execution.runId,
    sessionEntry: execution.sessionEntry,
    agentId: execution.activeSessionAgentId,
    sessionKey: execution.resolvedSessionKey,
    ...owner,
  };
  const prepare = (entry: SessionEntry | undefined) => {
    const retained = { ...source, sessionEntry: entry };
    return {
      context: resolveAgentRestartRecoveryContext(retained),
      bindRequester: (context: AdmittedRunContext) =>
        bindAgentRestartRecoveryRequesterContext(context, retained),
    };
  };
  // Ordinary turns keep their synchronous dispatch path and cannot obtain requester custody.
  return source.isRestartRecoveryResumeRun
    ? prepareRestartRecoveryRequesterEntry(source).then(prepare)
    : prepare(source.sessionEntry);
}
