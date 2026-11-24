import type { ReplyPayload } from "../types.js";
import { resolveSourceReplyPolicy } from "./agent-runner-core.js";
import type { AccountedAgentTurn } from "./agent-runner-result-accounting.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import { resolveStrandedReplyRecovery } from "./stranded-reply-recovery.js";

export function buildStrandedRetryDiagnostic(state: {
  context: FinalizeReplyAgentRunInput;
  activeSessionEntry: Parameters<typeof resolveSourceReplyPolicy>[0]["sessionEntry"];
  missingReplyNoticeAllowed: boolean;
  authoredSilence: boolean;
  automationNoChange: boolean;
  completedSourceReplyDelivery: boolean;
  runResult: AccountedAgentTurn["runResult"];
}): ReplyPayload | undefined {
  const { cfg, sessionCtx, sessionKey, runtimePolicySessionKey, opts, storePath, followupRun } =
    state.context;

  if (
    !state.missingReplyNoticeAllowed ||
    state.authoredSilence ||
    state.automationNoChange ||
    !sessionKey ||
    !storePath ||
    followupRun.strandedReplyRetry !== true ||
    sessionCtx.InboundEventKind === "room_event" ||
    state.completedSourceReplyDelivery
  ) {
    return undefined;
  }
  const sourceReplyPolicy = resolveSourceReplyPolicy({
    cfg,
    sessionCtx,
    sessionEntry: state.activeSessionEntry,
    sessionKey,
    runtimePolicySessionKey,
    opts,
  });
  // The guard above limits this to a one-shot recovery turn. A second miss
  // always gets a diagnostic, even when the retry produced no final text.
  const recovery = resolveStrandedReplyRecovery({
    base: followupRun,
    payloads: [],
    finalText: "",
    terminalReply: state.runResult.meta?.terminalReply,
    sourceReplyDeliveryMode: sourceReplyPolicy.sourceReplyDeliveryMode,
    sendPolicyDenied: sourceReplyPolicy.sendPolicyDenied,
    successfulSourceReplyDelivery: state.completedSourceReplyDelivery,
    isRoomEvent: false,
  });
  return recovery.kind === "diagnostic" ? recovery.payload : undefined;
}
