import { describe, expect, it, vi } from "vitest";
import { notifyPreparedAgentRunStart } from "../agent-run-start.js";
import { createDispatchAgentRunObserver } from "./dispatch-from-config.run-observer.js";

describe("dispatch run observation", () => {
  it("carries the prepared run into finalization without discarding start completion ownership", async () => {
    const completion = Promise.withResolvers<void>();
    const onPreparedAgentRunStart = vi.fn(() => completion.promise);
    const observer = createDispatchAgentRunObserver({
      replyOptions: { onPreparedAgentRunStart },
    });
    expect(observer.getAgentRunId()).toBeUndefined();
    expect(observer.getAgentRunTerminalOutcome()).toBeUndefined();
    const start = { runId: "prepared-run", transcriptStart: null };
    const receipt = notifyPreparedAgentRunStart(observer.getReplyOptions(), start);
    expect(receipt).toBe(completion.promise);
    expect(onPreparedAgentRunStart).toHaveBeenCalledWith(start);
    expect(observer.getAgentRunId()).toBe(start.runId);
    expect(observer.getAgentRunTerminalOutcome()).toBe("completed");
    completion.resolve();
    await receipt;
  });

  it("retains a failed run outcome when a later completion observer fires", () => {
    const onAgentRunTerminalOutcome = vi.fn();
    const observer = createDispatchAgentRunObserver({
      replyOptions: { onAgentRunTerminalOutcome },
    });
    const options = observer.getReplyOptions();
    notifyPreparedAgentRunStart(options, { runId: "failed-run", transcriptStart: null });
    options.onAgentRunTerminalOutcome("failed");
    options.onAgentRunTerminalOutcome("completed");
    expect(observer.getAgentRunId()).toBe("failed-run");
    expect(observer.getAgentRunTerminalOutcome()).toBe("failed");
    expect(onAgentRunTerminalOutcome.mock.calls).toEqual([["failed"], ["completed"]]);
  });
});
