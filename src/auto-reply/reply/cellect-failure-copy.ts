/**
 * Cellect override: failure copy people read in Slack and Matrix.
 *
 * Upstream failure renderers (`renderAssistantRequestFailureCopy`,
 * `renderControlUiAgentFailureCopy`, the incomplete-turn fallback) address an
 * operator: Control UI, `openclaw logs`, `/new`, the AI service, a model. A
 * Cellect member in a Slack or Matrix thread can act on none of that. On those
 * channels the reply becomes one plain sentence plus the run id an operator
 * can look up. Every other channel, and every error payload that is not
 * operator copy (access refusals, tool warnings), is left as it is.
 *
 * Kept in this one function so an upstream rebase conflicts in one place.
 */
import { copyReplyPayloadMetadata, getReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";

const CELLECT_PLAIN_FAILURE_CHANNELS = new Set(["slack", "matrix"]);

/** Operator-facing failure copy from the upstream renderers. */
const OPERATOR_FAILURE_COPY =
  /Control UI|`?openclaw (?:logs|configure|update|node)\b|Settings → Logs|(?:^|\s)\/(?:new|compact)\b|\bAI service\b|Agent couldn't generate a response|OpenClaw couldn't|OpenClaw is busy|OpenClaw doesn't|Request failed after repeated internal retries|The task couldn't finish|The request took too long|This model was not found/i;
/** The failed run may already have acted: say so, so nobody repeats a write blindly. */
const SIDE_EFFECTS =
  /may have already been executed|Some actions may have completed|check (?:the conversation|their results) (?:for any completed work )?before/i;

export function cellectChannelFailureCopy(
  payload: ReplyPayload,
  params: { channel?: string; runId?: string },
): ReplyPayload {
  const text = payload.text;
  if (
    !payload.isError ||
    !text ||
    !CELLECT_PLAIN_FAILURE_CHANNELS.has(params.channel?.toLowerCase() ?? "") ||
    getReplyPayloadMetadata(payload)?.toolErrorWarning !== undefined ||
    !OPERATOR_FAILURE_COPY.test(text)
  ) {
    return payload;
  }
  const reference = params.runId?.trim() ? ` (reference: run ${params.runId.trim()})` : "";
  const sentence = SIDE_EFFECTS.test(text)
    ? `I couldn't finish this, and some steps may already have run, so please check before asking again${reference}.`
    : `I couldn't finish this; please try again${reference}.`;
  return copyReplyPayloadMetadata(payload, { ...payload, text: sentence });
}
