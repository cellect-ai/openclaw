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
  consumeSelectedSystemEventEntries,
  enqueueSystemEvent,
  peekSystemEventEntries,
  peekSystemEvents,
  resetSystemEventsForTest,
  type SystemEventOrigin,
} from "./system-events.js";

const beforeDispatch = vi.hoisted(() => vi.fn());
vi.mock("./heartbeat-typing.js", () => ({
  createHeartbeatTypingCallbacks: () => ({ onReplyStart: beforeDispatch, onCleanup: vi.fn() }),
}));

const SESSION_KEY = "agent:main:telegram:group:-1003774691294:topic:47";

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
  resetSystemEventsForTest();
  clearRunFinalDeliveriesForTest();
  beforeDispatch.mockReset();
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
  it("reviews an uncollected successful completion after a delivered reply", async () => {
    recordRunFinalDelivered({ sessionKey: SESSION_KEY, runId: "run-1" });

    const { getReplySpy, remaining } = await runExecWake({
      events: [
        {
          text: "Exec completed (abc12345, code 0) :: optional .env.local ignored",
          origin: { runId: "run-1", sessionKey: SESSION_KEY, outcome: "success" },
        },
      ],
      replyText: "The follow-up command completed successfully.",
    });

    expect(getReplySpy).toHaveBeenCalledOnce();
    expect(String(getReplySpy.mock.calls[0]?.[0]?.Body)).toContain(
      "Do not re-summarize the earlier answer",
    );
    expect(remaining).toEqual([]);
  });

  it("rechecks collection after awaited preparation before starting a follow-up", async () => {
    beforeDispatch.mockImplementationOnce(async () => {
      consumeSelectedSystemEventEntries(SESSION_KEY, peekSystemEventEntries(SESSION_KEY));
      enqueueSystemEvent("A later independent event", {
        sessionKey: SESSION_KEY,
        contextKey: "task:later",
      });
    });
    const { result, getReplySpy, sendTelegram, remaining } = await runExecWake({
      events: [
        {
          text: "Exec completed (abc12345, code 0) :: source links ready",
          origin: { runId: "run-race", sessionKey: SESSION_KEY, outcome: "success" },
        },
      ],
      replyText: "A redundant follow-up",
    });
    expect(beforeDispatch).toHaveBeenCalled();
    expect(result.status).toBe("skipped");
    expect(getReplySpy).not.toHaveBeenCalled();
    expect(sendTelegram).not.toHaveBeenCalled();
    expect(remaining).toEqual(["A later independent event"]);
  });

  it("does not suppress a mixed wake while one completion remains pending", async () => {
    beforeDispatch.mockImplementationOnce(async () => {
      consumeSelectedSystemEventEntries(
        SESSION_KEY,
        peekSystemEventEntries(SESSION_KEY).slice(0, 1),
      );
    });
    const { getReplySpy } = await runExecWake({
      events: [
        {
          text: "Exec completed (success1, code 0) :: source links ready",
          origin: { runId: "mixed-run", sessionKey: SESSION_KEY, outcome: "success" },
        },
        {
          text: "Exec failed (failure1, code 1) :: import aborted",
          origin: { runId: "mixed-run", sessionKey: SESSION_KEY, outcome: "failure" },
        },
      ],
      replyText: "NO_REPLY",
    });
    expect(getReplySpy).toHaveBeenCalledOnce();
  });

  it("preserves a failed uncollected completion despite later replies", async () => {
    recordRunFinalDelivered({ sessionKey: SESSION_KEY, runId: "run-1", at: 1_000 });
    recordRunFinalDelivered({ sessionKey: SESSION_KEY, runId: "run-2", at: 2_000 });

    const { getReplySpy, remaining } = await runExecWake({
      events: [
        {
          text: "Exec failed (abc12345, code 1) :: statement timeout",
          origin: { runId: "run-1", sessionKey: SESSION_KEY, outcome: "failure" },
        },
      ],
      replyText: "An earlier background database command failed.",
    });

    expect(getReplySpy).toHaveBeenCalledOnce();
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
    expect(body).toContain("after a reply was already delivered");
    expect(body).toContain("Continue any unfinished work that depends on this result");
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
