import type { AgentEvent } from "openclaw/plugin-sdk/agent-core";
import { onTestFinished } from "vitest";
import { handleToolExecutionUpdate } from "./embedded-agent-subscribe.handlers.tools.progress.js";
import { handleToolExecutionStart } from "./embedded-agent-subscribe.handlers.tools.start.js";
import {
  endTool,
  type ToolExecutionEndEvent,
} from "./embedded-agent-subscribe.handlers.tools.test-support.js";
import type { ToolHandlerContext } from "./embedded-agent-subscribe.handlers.types.js";
import { cancelAskUserPromptDelivery } from "./tools/ask-user-tool.js";

export type ToolExecutionStartEvent = Omit<
  Extract<AgentEvent, { type: "tool_execution_start" }>,
  "type"
>;

export type ToolExecutionUpdateEvent = {
  toolName: string;
  toolCallId: string;
  args?: unknown;
  partialResult?: unknown;
  hideFromChannelProgress?: boolean;
};

export function startTool(ctx: ToolHandlerContext, event: ToolExecutionStartEvent) {
  if (event.toolName === "ask_user" || event.toolName === "secrets") {
    const { sessionKey, runId, agentId } = ctx.params;
    onTestFinished(() => cancelAskUserPromptDelivery(event.toolCallId, sessionKey, runId, agentId));
  }
  return handleToolExecutionStart(ctx, { type: "tool_execution_start", ...event });
}

export async function executeTool(
  ctx: ToolHandlerContext,
  event: ToolExecutionStartEvent & Omit<ToolExecutionEndEvent, "toolName" | "toolCallId">,
) {
  const { toolName, toolCallId, args, ...completion } = event;
  await startTool(ctx, { toolName, toolCallId, args });
  await endTool(ctx, { toolName, toolCallId, ...completion });
}

export function updateTool(ctx: ToolHandlerContext, event: ToolExecutionUpdateEvent) {
  return handleToolExecutionUpdate(ctx, {
    type: "tool_execution_update",
    args: event.args ?? {},
    partialResult: event.partialResult,
    ...event,
  });
}
