// Slack tests cover unanswered-mention notices and the no-reply watchdog.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMonitorContext } from "./context.js";

const warn = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  const logger = { warn, info: () => {}, child: () => logger };
  return { ...actual, createSubsystemLogger: () => logger };
});

const {
  clearSlackPendingMentionsForTest,
  logSlackDroppedDirectMessage,
  noticeSlackUnansweredMention,
  noticeSlackUnreadableDirectMessage,
  resolveSlackPrincipalMention,
  trackSlackPrincipalMention,
} = await import("./unanswered-mentions.js");

function createCtx(unansweredMentions?: Record<string, unknown>) {
  const postEphemeral = vi.fn(async () => ({ ok: true }));
  const postMessage = vi.fn(async (_args: Record<string, unknown>) => ({ ok: true }));
  const ctx = {
    accountId: "fi-admin",
    teamId: "T1",
    botToken: "xoxb-test",
    botUserId: "B1",
    cfg: {
      channels: { slack: unansweredMentions ? { unansweredMentions } : {} },
    } as OpenClawConfig,
    app: { client: { chat: { postEphemeral, postMessage } } },
    runtime: { error: vi.fn() },
    resolveUserName: async () => ({ name: "cellect-fi-admin" }),
  } as unknown as SlackMonitorContext;
  return { ctx, postEphemeral, postMessage };
}

describe("noticeSlackUnansweredMention", () => {
  beforeEach(() => {
    warn.mockClear();
  });

  it("rate-limits per user and channel, and logs every unanswered mention", async () => {
    const { ctx, postEphemeral } = createCtx();
    const notice = (userId: string, channelId = "C1") =>
      noticeSlackUnansweredMention({
        ctx,
        channelId,
        userId,
        messageTs: "1.0",
        reason: "sender-not-allowed",
      });

    await expect(notice("U1")).resolves.toBe(true);
    await expect(notice("U1")).resolves.toBe(false);
    await expect(notice("U2")).resolves.toBe(true);
    await expect(notice("U1", "C2")).resolves.toBe(true);

    expect(postEphemeral).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls[0]?.[0]).toContain(
      "Unanswered mention account=fi-admin channel=C1 user=U1 ts=1.0 reason=sender-not-allowed",
    );
  });

  it("can be turned off while still logging", async () => {
    const { ctx, postEphemeral } = createCtx({ notice: false });

    await noticeSlackUnansweredMention({
      ctx,
      channelId: "C1",
      userId: "U1",
      reason: "channel-not-allowed",
    });

    expect(postEphemeral).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("retries on the next mention when Slack rejects the ephemeral message", async () => {
    const { ctx, postEphemeral } = createCtx();
    postEphemeral.mockRejectedValueOnce(new Error("channel_not_found"));
    const notice = () =>
      noticeSlackUnansweredMention({
        ctx,
        channelId: "C1",
        userId: "U1",
        reason: "not-a-request-user",
      });

    await expect(notice()).resolves.toBe(false);
    await expect(notice()).resolves.toBe(true);
    expect(postEphemeral).toHaveBeenCalledTimes(2);
  });
});

describe("dropped direct messages", () => {
  beforeEach(() => {
    warn.mockClear();
  });

  it("names the gate that ended the DM, so a lost one is greppable", () => {
    logSlackDroppedDirectMessage({
      accountId: "fi-admin",
      channelId: "D1",
      userId: "U0GC",
      messageTs: "1.0",
      reason: "empty-content",
    });

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Dropped direct message account=fi-admin channel=D1 user=U0GC ts=1.0 reason=empty-content",
    );
  });

  it("answers an unreadable DM once per sender and conversation", async () => {
    const { ctx, postMessage } = createCtx();
    const notice = (userId: string, channelId = "D1") =>
      noticeSlackUnreadableDirectMessage({ ctx, channelId, userId });

    await expect(notice("U0GC")).resolves.toBe(true);
    await expect(notice("U0GC")).resolves.toBe(false);
    await expect(notice("U0OTHER")).resolves.toBe(true);
    await expect(notice("U0GC", "D2")).resolves.toBe(true);

    expect(postMessage).toHaveBeenCalledTimes(3);
    expect(postMessage.mock.calls[0]?.[0]).toMatchObject({
      channel: "D1",
      token: "xoxb-test",
    });
  });

  it("stays quiet when notices are switched off", async () => {
    const { ctx, postMessage } = createCtx({ notice: false });

    await expect(
      noticeSlackUnreadableDirectMessage({ ctx, channelId: "D1", userId: "U0GC" }),
    ).resolves.toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("retries on the next DM when Slack rejects the reply", async () => {
    const { ctx, postMessage } = createCtx();
    postMessage.mockRejectedValueOnce(new Error("channel_not_found"));
    const notice = () => noticeSlackUnreadableDirectMessage({ ctx, channelId: "D1", userId: "U1" });

    await expect(notice()).resolves.toBe(false);
    await expect(notice()).resolves.toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(2);
  });
});

describe("unanswered principal mention watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    warn.mockClear();
  });

  afterEach(() => {
    clearSlackPendingMentionsForTest();
    vi.useRealTimers();
  });

  it("logs an admitted mention with no reply after the configured minutes", () => {
    const { ctx } = createCtx({ alertAfterMinutes: 5 });
    trackSlackPrincipalMention({ ctx, channelId: "C1", messageTs: "1.0", userId: "U_LORENZO" });

    vi.advanceTimersByTime(4 * 60_000);
    expect(warn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Unanswered mention account=fi-admin channel=C1 user=U_LORENZO ts=1.0 reason=no-reply-after-5m",
    );
  });

  it("stays quiet once a reply is delivered, or when disabled", () => {
    const answered = createCtx();
    trackSlackPrincipalMention({ ctx: answered.ctx, channelId: "C1", messageTs: "1.0" });
    resolveSlackPrincipalMention({ accountId: "fi-admin", channelId: "C1", messageTs: "1.0" });
    const disabled = createCtx({ alertAfterMinutes: 0 });
    trackSlackPrincipalMention({ ctx: disabled.ctx, channelId: "C1", messageTs: "2.0" });

    vi.advanceTimersByTime(60 * 60_000);

    expect(warn).not.toHaveBeenCalled();
  });
});
