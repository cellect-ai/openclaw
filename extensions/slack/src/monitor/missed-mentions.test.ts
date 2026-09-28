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
  /** The bot's open DMs, as `conversations.list` with `types=im` reports them. */
  directConversations?: { id: string; is_im?: boolean; is_user_deleted?: boolean }[];
  history?: Record<string, HistoryMessage[]>;
  replies?: Record<string, HistoryMessage[]>;
  allowChannel?: (channelId: string) => boolean;
  allowChannelType?: (channelType: string | undefined) => boolean;
}) {
  const channels = options?.channels ?? [{ id: "C1", name: "proj-82-sussex" }];
  const directConversations = options?.directConversations ?? [];
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
  // fake mirrors that shape: rooms say whether the bot is in them, while an
  // `im` carries no name and no membership flag at all — only `is_im`.
  const conversationsList = vi.fn(async ({ types }: { types?: string }) =>
    types === "im"
      ? {
          ok: true,
          channels: directConversations.map((conversation) =>
            Object.assign({ is_im: true }, conversation),
          ),
        }
      : {
          ok: true,
          channels: channels.map((channel) => Object.assign({ is_member: true }, channel)),
        },
  );
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
    isChannelAllowed: ({ channelId, channelType }: { channelId?: string; channelType?: string }) =>
      (options?.allowChannel ? options.allowChannel(channelId ?? "") : true) &&
      (options?.allowChannelType ? options.allowChannelType(channelType) : true),
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

    expect(result).toMatchObject({ channelsScanned: 1, mentionsReplayed: 1 });
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

    expect(result).toEqual({
      channelsScanned: 0,
      mentionsReplayed: 0,
      directConversationsScanned: 0,
      directMessagesReplayed: 0,
    });
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

/**
 * A DM is the case the channel sweep cannot cover. Socket Mode never
 * redelivers it either, but unlike a room mention nobody else can see that it
 * went unanswered: an external GC's DMs were dropped on 2026-09-21 and
 * 2026-09-25 and only surfaced in a manual audit weeks later.
 */
const gcDirectMessage = (
  postedMs: number,
  text = "can you send the draw package?",
): HistoryMessage => ({
  type: "message",
  user: "U0GC",
  ts: slackTs(postedMs),
  text,
});

const botReply = (postedMs: number): HistoryMessage => ({
  type: "message",
  user: BOT,
  bot_id: "B1",
  ts: slackTs(postedMs),
  text: "on it",
});

function createDirectHarness(options?: Parameters<typeof createHarness>[0]) {
  return createHarness({
    channels: [],
    directConversations: [{ id: "D1" }],
    ...options,
  });
}

describe("recoverSlackMissedMentions direct messages", () => {
  beforeEach(() => {
    warn.mockClear();
  });

  it("replays a DM that arrived while the socket was down, with no mention needed", async () => {
    const posted = minutesAgo(90);
    const { run, dispatched } = createDirectHarness({
      history: { D1: [gcDirectMessage(posted)] },
    });

    const result = await run(minutesAgo(150));

    expect(result).toMatchObject({
      directConversationsScanned: 1,
      directMessagesReplayed: 1,
      channelsScanned: 0,
      mentionsReplayed: 0,
    });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "message",
      channel: "D1",
      channel_type: "im",
      user: "U0GC",
      ts: slackTs(posted),
    });
    expect(
      warn.mock.calls.some((call) =>
        String(call[0]).includes(
          `Missed direct message recovered account=fi-admin channel=D1 user=U0GC ts=${slackTs(posted)} reason=socket-offline`,
        ),
      ),
    ).toBe(true);
  });

  it("does not replay a DM this account already answered", async () => {
    const posted = minutesAgo(90);
    const { run, dispatched } = createDirectHarness({
      history: {
        D1: [gcDirectMessage(posted), botReply(minutesAgo(89))],
      },
    });

    const result = await run(minutesAgo(150));

    expect(result.directMessagesReplayed).toBe(0);
    expect(dispatched).toHaveLength(0);
  });

  it("still replays a DM that arrived after the last reply", async () => {
    const answered = minutesAgo(120);
    const posted = minutesAgo(90);
    const { run, dispatched } = createDirectHarness({
      history: {
        D1: [
          gcDirectMessage(answered, "first"),
          botReply(minutesAgo(119)),
          gcDirectMessage(posted, "second"),
        ],
      },
    });

    await run(minutesAgo(150));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.ts).toBe(slackTs(posted));
  });

  it("never replays the bot's own DM posts or another app's", async () => {
    const { run, dispatched } = createDirectHarness({
      history: {
        D1: [
          botReply(minutesAgo(30)),
          {
            type: "message",
            bot_id: "B99",
            user: "U0APP",
            ts: slackTs(minutesAgo(29)),
            text: "deploy finished",
          },
          {
            type: "message",
            subtype: "channel_join",
            user: "U0GC",
            ts: slackTs(minutesAgo(28)),
            text: "joined",
          },
        ],
      },
    });

    await run(minutesAgo(60));

    expect(dispatched).toHaveLength(0);
  });

  it("recovers a DM posted as a thread reply", async () => {
    const posted = minutesAgo(30);
    const parentTs = slackTs(minutesAgo(600));
    const { run, dispatched } = createDirectHarness({
      history: {
        D1: [
          {
            type: "message",
            user: "U0GC",
            ts: parentTs,
            text: "draw package",
            latest_reply: slackTs(posted),
          },
        ],
      },
      replies: { [`D1:${parentTs}`]: [gcDirectMessage(posted)] },
    });

    await run(minutesAgo(60));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.ts).toBe(slackTs(posted));
    expect(dispatched[0]?.channel_type).toBe("im");
  });

  it("skips DMs when the account has direct messages switched off", async () => {
    const { run, dispatched, conversationsHistory } = createDirectHarness({
      history: { D1: [gcDirectMessage(minutesAgo(30))] },
      allowChannelType: (channelType) => channelType !== "im",
    });

    await run(minutesAgo(60));

    expect(conversationsHistory).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
  });

  it("skips a conversation whose user was deleted", async () => {
    const { run, dispatched, conversationsHistory } = createDirectHarness({
      directConversations: [{ id: "D1", is_user_deleted: true }],
      history: { D1: [gcDirectMessage(minutesAgo(30))] },
    });

    await run(minutesAgo(60));

    expect(conversationsHistory).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
  });

  it("looks back no further than the configured window", async () => {
    const { run, dispatched } = createDirectHarness({
      unansweredMentions: { recoverWithinMinutes: 60 },
      history: { D1: [gcDirectMessage(minutesAgo(180))] },
    });

    await run(minutesAgo(600));

    expect(dispatched).toHaveLength(0);
  });

  it("sweeps rooms even when the DM listing fails, and the reverse", async () => {
    const harness = createHarness({
      channels: [{ id: "C1", name: "proj" }],
      directConversations: [{ id: "D1" }],
      history: {
        C1: [lorenzoMention(minutesAgo(30))],
        D1: [gcDirectMessage(minutesAgo(30))],
      },
    });
    harness.conversationsList.mockImplementation(async ({ types }: { types?: string }) => {
      if (types === "im") {
        throw new Error("missing_scope");
      }
      return { ok: true, channels: [{ id: "C1", name: "proj", is_member: true }] };
    });

    const result = await harness.run(minutesAgo(60));

    expect(result.mentionsReplayed).toBe(1);
    expect(result.directMessagesReplayed).toBe(0);
    expect(harness.dispatched[0]?.channel).toBe("C1");
  });

  it("keeps sweeping when one DM cannot be read", async () => {
    const harness = createHarness({
      channels: [],
      directConversations: [{ id: "D1" }, { id: "D2" }],
      history: { D2: [gcDirectMessage(minutesAgo(30))] },
    });
    harness.conversationsHistory.mockImplementation(async ({ channel }: { channel: string }) => {
      if (channel === "D1") {
        throw new Error("channel_not_found");
      }
      return { ok: true, messages: [gcDirectMessage(minutesAgo(30))] };
    });

    const result = await harness.run(minutesAgo(60));

    expect(result.directMessagesReplayed).toBe(1);
    expect(harness.dispatched[0]?.channel).toBe("D2");
  });

  it("can be switched off with the same flag as room recovery", async () => {
    const { run, dispatched, conversationsList } = createDirectHarness({
      unansweredMentions: { recoverMissed: false },
      history: { D1: [gcDirectMessage(minutesAgo(30))] },
    });

    await run(minutesAgo(60));

    expect(conversationsList).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
  });
});
