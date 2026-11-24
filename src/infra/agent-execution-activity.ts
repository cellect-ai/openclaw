import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AgentEventPayload } from "./agent-events.types.js";
import type { AgentRunContext } from "./agent-run-registry.types.js";

// Preserve the former activity window and the native worker identifier bound.
const MAX_EXECUTION_ACTIVITY_ITEMS = 64;

const MAX_EXECUTION_ACTIVITY_ID_LENGTH = 256;

const MAX_EXECUTION_TOOL_NAME_LENGTH = 120;

function activityId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const id = value.trim();
  return id && id.length <= MAX_EXECUTION_ACTIVITY_ID_LENGTH ? id : undefined;
}

export function recordExecutionActivity(
  context: AgentRunContext,
  event: Omit<AgentEventPayload, "seq" | "ts">,
): void {
  if (
    (event.sessionKey && context.sessionKey && event.sessionKey !== context.sessionKey) ||
    (event.sessionId && context.sessionId && event.sessionId !== context.sessionId)
  ) {
    return;
  }
  const { stream, data } = event;
  if (stream === "lifecycle" && (data.phase === "end" || data.phase === "error")) {
    context.executionActivity = undefined;
    return;
  }
  const approval = stream === "execution" && isRecord(data.approval) ? data.approval : undefined;
  const approvalId = activityId(
    approval?.id ?? (stream === "lifecycle" ? data.approvalId : undefined),
  );
  const approvalState =
    approval?.state ??
    (data.phase === "waiting-approval"
      ? "pending"
      : data.phase === "approval-resolved"
        ? "resolved"
        : undefined);
  if (approvalId && (approvalState === "pending" || approvalState === "resolved")) {
    const activity = (context.executionActivity ??= { tools: [], pendingApprovalIds: [] });
    if (approvalState === "pending" && !activity.pendingApprovalIds.includes(approvalId)) {
      if (activity.pendingApprovalIds.length < MAX_EXECUTION_ACTIVITY_ITEMS) {
        activity.pendingApprovalIds.push(approvalId);
      } else {
        // Unrepresented approvals cannot be mistaken for a fully resumed run.
        activity.approvalOverflow = true;
      }
    } else if (approvalState === "resolved") {
      activity.pendingApprovalIds = activity.pendingApprovalIds.filter((id) => id !== approvalId);
    }
    return;
  }
  if (
    stream === "execution" &&
    (data.state === "running" || data.state === "waiting" || data.state === "unknown")
  ) {
    const sourceId = activityId(data.sourceId);
    const previous = context.executionActivity?.execution;
    if (data.invalidate === true && (!sourceId || previous?.sourceId !== sourceId)) {
      return;
    }
    const activity = (context.executionActivity ??= { tools: [], pendingApprovalIds: [] });
    const id = activityId(data.executionId);
    if (
      data.state === "unknown" ||
      (sourceId && previous?.sourceId !== sourceId) ||
      (id && previous?.id !== id)
    ) {
      activity.tools = [];
    }
    const kind = isRecord(data.wait) ? data.wait.kind : undefined;
    const wait =
      kind === "approval" ||
      kind === "user_input" ||
      kind === "agent_messages" ||
      kind === "children"
        ? kind
        : "external";
    activity.execution = {
      state: data.state,
      sourceId: sourceId ?? previous?.sourceId,
      id: id ?? previous?.id,
      ...(data.state === "waiting" ? { wait } : {}),
    };
    return;
  }
  if (stream !== "tool") {
    return;
  }
  const toolCallId = activityId(data.toolCallId);
  if (!toolCallId) {
    return;
  }
  const existing = context.executionActivity;
  if (data.phase === "result" || data.phase === "end") {
    if (existing) {
      existing.tools = existing.tools.filter((tool) => tool.id !== toolCallId);
    }
    return;
  }
  if (data.phase !== "start" || typeof data.name !== "string" || !data.name.trim()) {
    return;
  }
  const activity = (context.executionActivity ??= { tools: [], pendingApprovalIds: [] });
  const tool = {
    id: toolCallId,
    name: truncateUtf16Safe(data.name.trim(), MAX_EXECUTION_TOOL_NAME_LENGTH),
  };
  const index = activity.tools.findIndex((current) => current.id === toolCallId);
  if (index >= 0) {
    activity.tools[index] = tool;
  } else if (activity.tools.length < MAX_EXECUTION_ACTIVITY_ITEMS) {
    activity.tools.push(tool);
  }
}
