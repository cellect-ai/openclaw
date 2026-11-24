import { observeAgentRunStart } from "../agent-run-start.js";
import type { DispatchReplyOperationCoordinatorParams } from "./dispatch-from-config.types.js";

/** Retain the exact admitted run and sticky terminal failure for dispatch finalization. */
export function createDispatchAgentRunObserver(
  params: Pick<DispatchReplyOperationCoordinatorParams, "replyOptions" | "messageAuditTerminal">,
) {
  let agentRunId: string | undefined;
  let agentRunTerminalOutcome: "completed" | "failed" | undefined;
  return {
    getAgentRunId: () => agentRunId,
    getAgentRunTerminalOutcome: () => agentRunTerminalOutcome,
    getReplyOptions: () => ({
      ...observeAgentRunStart(params.replyOptions, (start) => {
        agentRunId = start.runId;
        agentRunTerminalOutcome = "completed";
        params.messageAuditTerminal?.observeRunId(start.runId);
      }),
      onAgentRunTerminalOutcome: (outcome: "completed" | "failed") => {
        if (outcome === "failed" || agentRunTerminalOutcome === undefined) {
          agentRunTerminalOutcome = outcome;
        }
        params.replyOptions?.onAgentRunTerminalOutcome?.(outcome);
      },
    }),
  };
}
