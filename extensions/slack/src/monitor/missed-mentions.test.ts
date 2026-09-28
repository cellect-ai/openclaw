// A principal's mention must survive the gateway being away. Socket Mode gets
// no redelivery from Slack, so a mention posted during a restart or a broken
// deploy is only ever answered if the next connection goes and finds it: that
// is what went wrong when a mention sat unanswered for 44h across a cutover.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../types.js";
import type { SlackMonitorContext } from "./context.js";

const warn = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  const logger = { warn, info: () => {}, child: () => logger };
  return { ...actual, createSubsystemLogger: () => logger };
});

const { recoverSlackMissedMentions } = await import("./missed-mentions.js");

const BOT = "U0BOT";
const NOW = 1_790_400_000_000;
const minutesAgo = (minutes: number) => NOW - minutes * 60_000;
const slackTs = (ms: number) => (ms / 1_000).toFixed(6);

type HistoryMessage = Record<string, unknown>;

function createHarness(options?: {
  unansweredMentions?: Record<string, unknown>;
  channels?: { id: string; name?: string; is_private?: boolean }[];
  history?: Record<string, HistoryMessage[]>;
  replies?: Record<string, HistoryMessage[]>;
  allowChannel?: (channelId: string) => boolean;
}) {
  const channels = options?.channels ?? [{ id: "C1", name: "proj-82-sussex" }];
  const history = options?.history ?? {};
  const replies = options?.replies ?? {};
  const conversationsHistory = vi.fn(async ({ channel }: { channel: string }) => ({
    ok: true,
    messages: history[channel] ?? [],
  }));
  const conversationsReplies = vi.fn(async ({ channel, ts }: { channel: string; ts: string }) => ({
    ok: true,
    messages: replies[`${channel}:${ts}`] ?? [],
  }));
  // The sweep reuses the directory's conversations.list page helper, so the
  // fake mirrors that shape: every listed channel says whether the bot is in it.
  const conversationsList = vi.fn(async () => ({
    ok: true,
    channels: channels.map((channel) => ({ is_member: true, ...channel })),
  }));
  const client = {
    conversations: {
      list: conversationsList,
      history: conversationsHistory,
      replies: conversationsReplies,
    },
  };
  const ctx = {
    accountId: "fi-admin",
    teamId: "T1",
    botUserId: BOT,
    cfg: {
      channels: {
        slack: options?.unansweredMentions
          ? { unansweredMentions: options.unansweredMentions }
          : {},
      },
    } as OpenClawConfig,
    runtime: { error: vi.fn(), log: vi.fn() },
    isChannelAllowed: ({ channelId }: { channelId?: string }) =>
      options?.allowChannel ? options.allowChannel(channelId ?? "") : true,
  } as unknown as SlackMonitorContext;
  const dispatched: SlackMessageEvent[] = [];
  const run = (lastAliveAt: number | undefined) =>
    recoverSlackMissedMentions({
      ctx,
      client: client as never,
      lastAliveAt,
      now: NOW,
      dispatch: async (message) => {
        dispatched.push(message);
      },
    });
  return { run, dispatched, ctx, conversationsList, conversationsHistory, conversationsReplies };
}

/** The message Lorenzo posted while the gateway was mid-cutover. */
const lorenzoMention = (postedMs: number): HistoryMessage => ({
  type: "message",
  user: "U0ACZDSC9SA",
  ts: slackTs(postedMs),
  text: `<@${BOT}> what % membership interest for 100k each in 82 Sussex?`,
});

describe("recoverSlackMissedMentions", () => {
  beforeEach(() => {
    warn.mockClear();
  });

  it("replays a mention posted while the socket was down", async () => {
    const posted = minutesAgo(90);
    const { run, dispatched } = createHarness({
      history: { C1: [lorenzoMention(posted)] },
    });

    const result = await run(minutesAgo(150));

    expect(result).toEqual({ channelsScanned: 1, mentionsReplayed: 1 });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "message",
      channel: "C1",
      user: "U0ACZDSC9SA",
      ts: slackTs(posted),
    });
    expect(
      warn.mock.calls.some((call) =>
        String(call[0]).includes(
          `Missed mention recovered account=fi-admin channel=C1 user=U0ACZDSC9SA ts=${slackTs(posted)} reason=socket-offline`,
        ),
      ),
    ).toBe(true);
  });

  it("recovers a mention posted as a thread reply", async () => {
    const posted = minutesAgo(30);
    const parentTs = slackTs(minutesAgo(600));
    const { run, dispatched } = createHarness({
      history: {
        C1: [
          {
            type: "message",
            user: "U0ACZDSC9SA",
            ts: parentTs,
            text: "budget thread",
            latest_reply: slackTs(posted),
          },
        ],
      },
      replies: { [`C1:${parentTs}`]: [lorenzoMention(posted)] },
    });

    await run(minutesAgo(60));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.ts).toBe(slackTs(posted));
  });

  it("does nothing when the socket only blipped", async () => {
    const { run, dispatched, conversationsList } = createHarness({
      history: { C1: [lorenzoMention(minutesAgo(1))] },
    });

    const result = await run(NOW - 5_000);

    expect(result).toEqual({ channelsScanned: 0, mentionsReplayed: 0 });
    expect(conversationsList).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
  });

  it("does nothing on a first run, which has no outage to recover", async () => {
    const { run, dispatched, conversationsList } = createHarness({
      history: { C1: [lorenzoMention(minutesAgo(30))] },
    });

    await run(undefined);

    expect(conversationsList).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
  });

  it("ignores messages that do not name this bot", async () => {
    const { run, dispatched } = createHarness({
      history: {
        C1: [
          { type: "message", user: "U0ACZDSC9SA", ts: slackTs(minutesAgo(30)), text: "no mention" },
          {
            type: "message",
            user: "U0ACZDSC9SA",
            ts: slackTs(minutesAgo(29)),
            text: "<@U0OTHER> not us",
          },
        ],
      },
    });

    await run(minutesAgo(60));

    expect(dispatched).toHaveLength(0);
  });

  it("never replays the bot's own posts or another bot's", async () => {
    const { run, dispatched } = createHarness({
      history: {
        C1: [
          { type: "message", user: BOT, ts: slackTs(minutesAgo(30)), text: `<@${BOT}> self` },
          {
            type: "message",
            bot_id: "B99",
            user: "U0OTHER",
            ts: slackTs(minutesAgo(29)),
            text: `<@${BOT}> from a bot`,
          },
          {
            type: "message",
            subtype: "channel_join",
            user: "U0ACZDSC9SA",
            ts: slackTs(minutesAgo(28)),
            text: `<@${BOT}> joined`,
          },
        ],
      },
    });

    await run(minutesAgo(60));

    expect(dispatched).toHaveLength(0);
  });

  it("skips conversations this account is not allowed in", async () => {
    const { run, dispatched, conversationsHistory } = createHarness({
      channels: [
        { id: "C1", name: "allowed" },
        { id: "C2", name: "denied" },
      ],
      history: {
        C1: [lorenzoMention(minutesAgo(30))],
        C2: [lorenzoMention(minutesAgo(30))],
      },
      allowChannel: (channelId) => channelId === "C1",
    });

    await run(minutesAgo(60));

    expect(conversationsHistory).toHaveBeenCalledTimes(1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.channel).toBe("C1");
  });

  it("looks back no further than the configured window", async () => {
    const { run, dispatched } = createHarness({
      unansweredMentions: { recoverWithinMinutes: 60 },
      // Posted during the outage, but older than the window allows.
      history: { C1: [lorenzoMention(minutesAgo(180))] },
    });

    await run(minutesAgo(600));

    expect(dispatched).toHaveLength(0);
  });

  it("can be switched off", async () => {
    const { run, dispatched, conversationsList } = createHarness({
      unansweredMentions: { recoverMissed: false },
      history: { C1: [lorenzoMention(minutesAgo(30))] },
    });

    await run(minutesAgo(60));

    expect(conversationsList).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
  });

  it("keeps sweeping when one conversation cannot be read", async () => {
    const harness = createHarness({
      channels: [
        { id: "C1", name: "broken" },
        { id: "C2", name: "fine" },
      ],
      history: { C2: [lorenzoMention(minutesAgo(30))] },
    });
    harness.conversationsHistory.mockImplementation(async ({ channel }: { channel: string }) => {
      if (channel === "C1") {
        throw new Error("channel_not_found");
      }
      return { ok: true, messages: [lorenzoMention(minutesAgo(30))] };
    });

    const result = await harness.run(minutesAgo(60));

    expect(result.mentionsReplayed).toBe(1);
    expect(harness.dispatched[0]?.channel).toBe("C2");
  });
});
