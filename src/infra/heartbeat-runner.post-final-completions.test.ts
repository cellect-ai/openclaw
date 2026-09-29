// Covers async exec completions that arrive after their run already delivered a final reply.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  seedSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { clearRunFinalDeliveriesForTest, recordRunFinalDelivered } from "./run-final-deliveries.js";
import {
  enqueueSystemEvent,
  peekSystemEvents,
  resetSystemEventsForTest,
  type SystemEventOrigin,
} from "./system-events.js";

const SESSION_KEY = "agent:main:telegram:group:-1003774691294:topic:47";

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
  resetSystemEventsForTest();
  clearRunFinalDeliveriesForTest();
});

afterEach(() => {
  resetSystemEventsForTest();
  clearRunFinalDeliveriesForTest();
  vi.restoreAllMocks();
});

async function runExecWake(params: {
  events: Array<{ text: string; origin?: SystemEventOrigin }>;
  replyText: string;
}) {
  return await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tmpDir, heartbeat: { every: "5m", target: "last" } } },
      channels: { telegram: { allowFrom: ["*"] } },
      session: { store: storePath },
    };
    await seedSessionStore(storePath, SESSION_KEY, {
      sessionId: "sid",
      updatedAt: Date.now(),
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: "telegram:-1003774691294:topic:47",
      lastThreadId: 47,
    });
    for (const event of params.events) {
      enqueueSystemEvent(event.text, {
        sessionKey: SESSION_KEY,
        deliveryContext: {
          channel: "telegram",
          to: "telegram:-1003774691294:topic:47",
          threadId: 47,
        },
        ...(event.origin ? { origin: event.origin } : {}),
      });
    }
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "-1003774691294" });
    const getReplySpy = vi.fn().mockResolvedValue({ text: params.replyText });
    const result = await runHeartbeatOnce({
      cfg,
      agentId: "main",
      sessionKey: SESSION_KEY,
      reason: "exec-event",
      source: "exec-event",
      intent: "event",
      deps: { getReplyFromConfig: getReplySpy, telegram: sendTelegram },
    });
    return {
      result,
      sendTelegram,
      getReplySpy,
      remaining: peekSystemEvents(SESSION_KEY),
    };
  });
}

describe("async completions after a delivered final reply", () => {
  it("drops a successful completion of a run that already answered, without a model turn", async () => {
    recordRunFinalDelivered({ sessionKey: SESSION_KEY, runId: "run-1" });

    const { result, sendTelegram, getReplySpy, remaining } = await runExecWake({
      events: [
        {
          text: "Exec completed (abc12345, code 0) :: optional .env.local ignored",
          origin: { runId: "run-1", sessionKey: SESSION_KEY, outcome: "success" },
        },
      ],
      replyText: "The follow-up command completed successfully.",
    });

    expect(result.status).toBe("skipped");
    expect(getReplySpy).not.toHaveBeenCalled();
    expect(sendTelegram).not.toHaveBeenCalled();
    expect(remaining).toEqual([]);
  });

  it("drops even a failed completion once a later run has answered in the session", async () => {
    recordRunFinalDelivered({ sessionKey: SESSION_KEY, runId: "run-1", at: 1_000 });
    recordRunFinalDelivered({ sessionKey: SESSION_KEY, runId: "run-2", at: 2_000 });

    const { getReplySpy, sendTelegram, remaining } = await runExecWake({
      events: [
        {
          text: "Exec failed (abc12345, code 1) :: statement timeout",
          origin: { runId: "run-1", sessionKey: SESSION_KEY, outcome: "failure" },
        },
      ],
      replyText: "An earlier background database command failed.",
    });

    expect(getReplySpy).not.toHaveBeenCalled();
    expect(sendTelegram).not.toHaveBeenCalled();
    expect(remaining).toEqual([]);
  });

  it("lets a failure after its own final through, but only to report a changed result", async () => {
    recordRunFinalDelivered({ sessionKey: SESSION_KEY, runId: "run-1" });

    const { getReplySpy } = await runExecWake({
      events: [
        {
          text: "Exec failed (abc12345, code 1) :: import aborted",
          origin: { runId: "run-1", sessionKey: SESSION_KEY, outcome: "failure" },
        },
      ],
      replyText: "NO_REPLY",
    });

    const body = String(getReplySpy.mock.calls[0]?.[0]?.Body);
    expect(body).toContain("after you already gave the user your final answer");
    expect(body).toContain("Post only if this result changes the answer you gave");
    expect(body).toContain("Do not re-summarize the earlier answer");
  });

  it("still relays a completion whose run has not delivered its final reply yet", async () => {
    const { sendTelegram } = await runExecWake({
      events: [
        {
          text: "Exec completed (abc12345, code 0) :: 12 invoices found",
          origin: { runId: "run-3", sessionKey: SESSION_KEY, outcome: "success" },
        },
      ],
      replyText: "Found 12 invoices.",
    });

    expect(sendTelegram).toHaveBeenCalledOnce();
  });
});
