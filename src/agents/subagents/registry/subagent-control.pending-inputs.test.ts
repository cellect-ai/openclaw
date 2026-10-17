// Preserve real registry lifetime setup before cancellation consumers.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "../../../auto-reply/reply/queue.js";
import {
  createQueueSettings,
  createQueueTestRun,
} from "../../../auto-reply/reply/queue.test-helpers.js";
import {
  admitFollowupRunLifecycle,
  completeFollowupRunLifecycle,
} from "../../../auto-reply/reply/queue/lifecycle.js";
import {
  clearFollowupQueue,
  getExistingFollowupQueue,
} from "../../../auto-reply/reply/queue/state.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { beginSessionWorkAdmission } from "../../../sessions/session-lifecycle-admission.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { killAllControlledSubagentRuns, killSubagentRunAdmin } from "./subagent-control.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";

const fixture = useSubagentControlFixture();

it.each(["admin", "bulk"] as const)(
  "%s exact queued execution Stop preserves unknown admissions and executable followups",
  async (boundary) => {
    const owner = "agent:main:main";
    const sessionKey = `agent:main:subagent:preserved-${boundary}`;
    const sessionId = `preserved-${boundary}-session`;
    const runId = `selected-${boundary}`;
    const cfg = getRuntimeConfig();
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey,
      defaultSessionId: sessionId,
    });
    await registerSubagentRun({
      runId,
      childSessionKey: sessionKey,
      requesterSessionKey: owner,
      requesterAgentId: "main",
      requesterDisplayKey: owner,
      task: "Selected queued execution",
      cleanup: "keep",
      collect: true,
      queued: true,
      expectsCompletionMessage: false,
    });
    const selectedStart = vi.fn(async () => {});
    const removed = vi.fn();
    enqueueSwarmRun({
      groupId: `pending-preservation-${boundary}`,
      runId,
      maxConcurrent: 1,
      activeRunIds: ["capacity-blocker"],
      start: selectedStart,
      onStartFailure: () => true,
      onRemoved: removed,
    });
    const selectedInterrupted = vi.fn(() => {
      selected.release();
      return { runId };
    });
    const selected = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, sessionId],
      executionRunId: runId,
      assertAllowed: () => {},
      onInterrupt: selectedInterrupted,
    });
    const pendingInterrupted = vi.fn(() => pending.release());
    const pending = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, sessionId],
      assertAllowed: () => {},
      onInterrupt: pendingInterrupted,
    });
    const sourceController = new AbortController();
    const settlement = createDeferred();
    const settled = vi.fn(() => settlement.resolve());
    const adopted = vi.fn();
    const source = createQueueTestRun({ prompt: "Unrelated pending input" });
    Object.assign(source.run, { agentId: "main", sessionKey, sessionId, config: cfg });
    source.abortSignal = sourceController.signal;
    source.turnAdoptionLifecycle = {
      admission: "cancel-only",
      onAdopted: adopted,
      onSettled: settled,
    };
    expect(
      enqueueFollowupRun(
        sessionKey,
        source,
        createQueueSettings({ mode: "followup" }),
        "none",
        undefined,
        false,
      ),
    ).toBe(true);
    const queue = getExistingFollowupQueue(sessionKey);
    try {
      expect(
        await killSubagentRunAdmin(
          { cfg, sessionKey, expectedRunId: "unrelated-execution" },
          { assertCurrent: () => {}, preservePendingInputs: true },
        ),
      ).toMatchObject({ found: false, killed: false });
      expect(selectedInterrupted).not.toHaveBeenCalled();
      expect(pendingInterrupted).not.toHaveBeenCalled();
      expect(removed).not.toHaveBeenCalled();
      expect(getExistingFollowupQueue(sessionKey)).toBe(queue);
      if (boundary === "admin") {
        const result = await killSubagentRunAdmin(
          { cfg, sessionKey, expectedRunId: runId },
          { assertCurrent: () => {}, preservePendingInputs: true },
        );
        expect(result).toMatchObject({ found: true, killed: true, runId });
      } else {
        const result = await killAllControlledSubagentRuns({
          cfg,
          runs: [subagentRuns.get(runId)!],
          controller: {
            controllerSessionKey: owner,
            controllerAgentId: "main",
            callerSessionKey: owner,
            callerIsSubagent: false,
            controlScope: "children",
          },
          preservePendingInputs: true,
        });
        expect(result).toMatchObject({ killed: 1 });
      }
      expect(selectedInterrupted).toHaveBeenCalledOnce();
      expect(removed).toHaveBeenCalledOnce();
      expect(selectedStart).not.toHaveBeenCalled();
      expect(pendingInterrupted).not.toHaveBeenCalled();
      expect(pending.isActive()).toBe(true);
      expect(sourceController.signal.aborted).toBe(false);
      expect(settled).not.toHaveBeenCalled();
      expect(getExistingFollowupQueue(sessionKey)).toBe(queue);
      expect(queue?.items).toEqual([source]);
      const executed = createDeferred();
      const followup = vi.fn(async (run: typeof source) => {
        await admitFollowupRunLifecycle(run);
        try {
          await pending.run(async () => executed.resolve());
        } finally {
          completeFollowupRunLifecycle(run);
        }
      });
      scheduleFollowupDrain(sessionKey, followup);
      await executed.promise;
      await settlement.promise;
      expect(settled).toHaveBeenCalledOnce();
      expect(adopted).toHaveBeenCalledOnce();
      expect(followup).toHaveBeenCalledOnce();
      expect(sourceController.signal.aborted).toBe(false);
      expect(releaseSwarmRun(runId)).toBe(false);
      expect(selectedStart).not.toHaveBeenCalled();
    } finally {
      selected.release();
      pending.release();
      clearFollowupQueue(sessionKey);
      releaseSwarmRun("capacity-blocker");
    }
  },
);
