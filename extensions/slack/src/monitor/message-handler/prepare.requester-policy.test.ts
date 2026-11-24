import fs from "node:fs/promises";
import type { App } from "@slack/bolt";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSlackAccount } from "../../accounts.js";
import {
  clearSlackThreadParticipationCache,
  recordSlackThreadParticipation,
} from "../../sent-thread-cache.js";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackMonitorContext } from "../context.js";
import { prepareSlackMessage } from "./prepare.js";
import {
  createInboundSlackTestContext,
  createSlackSessionStoreFixture,
  createSlackTestAccount as createSlackAccount,
} from "./prepare.test-helpers.js";

async function prepareMessageWith(
  ctx: SlackMonitorContext,
  account: ResolvedSlackAccount,
  message: SlackMessageEvent,
  opts: Parameters<typeof prepareSlackMessage>[0]["opts"] = { source: "message" },
) {
  return prepareSlackMessage({ ctx, account, message, opts });
}

function assertPrepared(
  prepared: Awaited<ReturnType<typeof prepareSlackMessage>>,
  label = "Slack message",
): asserts prepared is NonNullable<Awaited<ReturnType<typeof prepareSlackMessage>>> {
  if (!prepared) {
    throw new Error(`Expected ${label} to be prepared`);
  }
}

const {
  enqueueSystemEventMock,
  logVerboseMock,
  sendTranscriptEchoMock,
  shouldLogVerboseMock,
  transcribeFirstAudioMock,
  upsertChannelPairingRequestMock,
} = vi.hoisted(() => ({
  enqueueSystemEventMock: vi.fn(),
  logVerboseMock: vi.fn(),
  sendTranscriptEchoMock: vi.fn(),
  shouldLogVerboseMock: vi.fn(() => false),
  transcribeFirstAudioMock: vi.fn(),
  upsertChannelPairingRequestMock: vi.fn(),
}));

const mediaFetchMock = vi.hoisted(() =>
  vi.fn<typeof import("../media.runtime.js").fetchWithRuntimeDispatcher>(),
);

vi.mock("../media.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../media.runtime.js")>()),
  fetchWithRuntimeDispatcher: mediaFetchMock,
}));

beforeEach(() => {
  mediaFetchMock.mockReset().mockRejectedValue(new Error("Unexpected Slack media test request"));
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return { ...actual, upsertChannelPairingRequest: upsertChannelPairingRequestMock };
});

vi.mock("openclaw/plugin-sdk/media-understanding-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/media-understanding-runtime")>();
  return {
    ...actual,
    createChannelPreflightAudio: (
      params: Parameters<typeof actual.createChannelPreflightAudio>[0],
    ) =>
      actual.createChannelPreflightAudio({
        ...params,
        sendTranscriptEcho: sendTranscriptEchoMock,
        transcribeFirstAudio: transcribeFirstAudioMock,
      }),
  };
});

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    logVerbose: (...args: unknown[]) => logVerboseMock(...args),
    shouldLogVerbose: () => shouldLogVerboseMock(),
  };
});

vi.mock("openclaw/plugin-sdk/system-event-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/system-event-runtime")>();
  return {
    ...actual,
    enqueueRoutedSystemEvent: (
      text: unknown,
      route: { sessionKey: unknown },
      options: Record<string, unknown>,
    ) => enqueueSystemEventMock(text, { ...options, sessionKey: route.sessionKey }),
  };
});

const mediaPaths = new Set<string>();

afterEach(async () => {
  await Promise.all([...mediaPaths].map((path) => fs.rm(path, { force: true })));
  mediaPaths.clear();
});

function slackConfig(
  slack: ResolvedSlackAccount["config"] = {},
  extra: OpenClawConfig = {},
): OpenClawConfig {
  return { ...extra, channels: { slack: { enabled: true, ...slack } } };
}

function createSlackMessage(overrides: Partial<SlackMessageEvent>): SlackMessageEvent {
  return {
    type: "message",
    channel: "D123",
    channel_type: "im",
    user: "U1",
    text: "hi",
    ts: "1.000",
    ...overrides,
  };
}

describe("slack requester and collaborator ingress policy", () => {
  const storeFixture = createSlackSessionStoreFixture("openclaw-slack-thread-");

  beforeEach(() => {
    clearSlackThreadParticipationCache();
    enqueueSystemEventMock.mockClear();
    logVerboseMock.mockClear();
    sendTranscriptEchoMock.mockReset().mockResolvedValue(undefined);
    shouldLogVerboseMock.mockReset().mockReturnValue(false);
    transcribeFirstAudioMock.mockReset();
    upsertChannelPairingRequestMock
      .mockReset()
      .mockResolvedValue({ code: "PAIRCODE", created: true });
  });

  function createInboundSlackCtx(
    params: Partial<Parameters<typeof createInboundSlackTestContext>[0]> = {},
  ) {
    return createInboundSlackTestContext({ cfg: slackConfig(), ...params });
  }

  function nameContext(ctx: SlackMonitorContext) {
    ctx.resolveUserName = async () => ({ name: "Alice" });
    ctx.resolveChannelName = async () => ({ name: "general", type: "channel" });
    return ctx;
  }

  const defaultAccount = createSlackAccount();

  function createAllowlistDeniedRoomCtx(postEphemeral: ReturnType<typeof vi.fn>) {
    const ctx = createInboundSlackCtx({
      cfg: slackConfig({ groupPolicy: "allowlist", channels: { C_ALLOWED: { enabled: true } } }),
      appClient: { chat: { postEphemeral } } as unknown as App["client"],
      channelsConfig: { C_ALLOWED: { enabled: true } },
      groupPolicy: "allowlist",
    });
    ctx.resolveChannelName = async () => ({ name: "blocked-room", type: "channel" });
    ctx.resolveUserName = async (userId) => ({
      name: userId === ctx.botUserId ? "Personal Claw" : "Alice",
    });
    return ctx;
  }

  function createAckRoomContext(
    messages: OpenClawConfig["messages"],
    options: Pick<
      NonNullable<Parameters<typeof createInboundSlackCtx>[0]>,
      "appClient" | "replyToMode" | "defaultRequireMention"
    > = {},
  ) {
    const ctx = createInboundSlackCtx({
      cfg: slackConfig(
        {
          groupPolicy: "open",
          ...(options.replyToMode ? { replyToMode: options.replyToMode } : {}),
        },
        { messages },
      ),
      ...options,
    });
    return nameContext(ctx);
  }

  const fullRichText = `First paragraph ${"keeps going ".repeat(14)}
Second paragraph should still reach the agent after Slack's preview cutoff.`;

  const pastedTable = [
    "ID\tName\tStatus",
    "12345\tExample A\tenabled",
    "12346\tExample B\tenabled",
  ].join("\n");

  it("keeps an authorized requester's mention as a user request", async () => {
    const channelConfig = {
      enabled: true,
      requireMention: false,
      users: ["U_OWNER", "U_CONTEXT"],
      requestUsers: ["U_OWNER"],
    };
    const slackCtx = createInboundSlackCtx({
      cfg: {
        channels: {
          slack: {
            enabled: true,
            groupPolicy: "allowlist",
            channels: { C123: channelConfig },
          },
        },
      } as OpenClawConfig,
      channelsConfig: { C123: channelConfig },
      defaultRequireMention: false,
      groupPolicy: "allowlist",
    });
    slackCtx.allowFrom = ["U_OWNER"];
    slackCtx.resolveUserName = async () => ({ name: "Alex" });
    slackCtx.resolveChannelName = async () => ({ name: "shape-tech", type: "channel" });

    const prepared = await prepareMessageWith(slackCtx, defaultAccount, {
      channel: "C123",
      channel_type: "channel",
      user: "U_OWNER",
      text: "<@B1> please summarize",
      ts: "1.000",
    } as SlackMessageEvent);

    assertPrepared(prepared);
    expect(prepared.ctxPayload.InboundEventKind).toBe("user_request");
    expect(prepared.ctxPayload.CommandAuthorized).toBe(true);
    expect(prepared.ackReactionValue).not.toBe("blue_book");
  });

  it("dispatches delegated control text for a visible refusal without interpreting it", async () => {
    const threadTs = "1789142253.692359";
    const replies = vi.fn().mockResolvedValue({
      messages: [{ user: "U_OWNER", text: "Review this package", ts: threadTs }],
    });
    const channelConfig = {
      enabled: true,
      requireMention: false,
      users: ["U_OWNER", "U_CONTEXT"],
      requestUsers: ["U_OWNER"],
    };
    const slackCtx = createInboundSlackCtx({
      cfg: {
        messages: { groupChat: { unmentionedInbound: "room_event" } },
        channels: {
          slack: {
            enabled: true,
            groupPolicy: "allowlist",
            channels: { C123: channelConfig },
          },
        },
      } as OpenClawConfig,
      channelsConfig: { C123: channelConfig },
      defaultRequireMention: false,
      groupPolicy: "allowlist",
      appClient: { conversations: { replies } } as unknown as App["client"],
    });
    slackCtx.allowFrom = ["U_OWNER"];
    slackCtx.resolveUserName = async () => ({ name: "Nicholas" });
    slackCtx.resolveChannelName = async () => ({ name: "shape-tech", type: "channel" });

    const prepared = await prepareMessageWith(slackCtx, defaultAccount, {
      channel: "C123",
      channel_type: "channel",
      user: "U_CONTEXT",
      text: "/new",
      ts: "1789142536.963139",
      thread_ts: threadTs,
    } as SlackMessageEvent);

    assertPrepared(prepared);
    expect(prepared.ctxPayload.InboundEventKind).toBe("user_request");
    expect(prepared.ctxPayload.CommandAuthorized).toBe(false);
    expect(prepared.ctxPayload.CommandInterpretationSuppressed).toBe(true);
    expect(prepared.ctxPayload.GroupSystemPrompt).toContain("never accept session-control");
    expect(prepared.ackReactionValue).not.toBe("blue_book");
  });

  it("dispatches a context-only participant after a request user joins a bot-started thread", async () => {
    const threadTs = "1789142253.692359";
    const replies = vi.fn().mockResolvedValue({
      messages: [
        { user: "B1", bot_id: "B1", text: "Please clarify the recipients", ts: threadTs },
        { user: "U_OWNER", text: "Send it to the listed recipients", ts: "1789142388.168949" },
        { user: "U_CONTEXT", text: "Use tomorrow's date", ts: "1789142536.963139" },
      ],
    });
    const channelConfig = {
      enabled: true,
      requireMention: true,
      users: ["U_OWNER", "U_CONTEXT"],
      requestUsers: ["U_OWNER"],
    };
    recordSlackThreadParticipation("default", "C123", threadTs);
    const slackCtx = createInboundSlackCtx({
      cfg: {
        messages: { groupChat: { unmentionedInbound: "room_event" } },
        channels: {
          slack: {
            enabled: true,
            groupPolicy: "allowlist",
            channels: { C123: channelConfig },
          },
        },
      } as OpenClawConfig,
      channelsConfig: { C123: channelConfig },
      defaultRequireMention: true,
      groupPolicy: "allowlist",
      appClient: { conversations: { replies } } as unknown as App["client"],
    });
    slackCtx.allowFrom = ["U_OWNER"];
    slackCtx.resolveUserName = async (userId) => ({
      name: userId === "U_OWNER" ? "Alex" : "Zahra",
    });
    slackCtx.resolveChannelName = async () => ({ name: "esign", type: "channel" });

    const prepared = await prepareMessageWith(slackCtx, defaultAccount, {
      channel: "C123",
      channel_type: "channel",
      user: "U_CONTEXT",
      text: "Use tomorrow's date",
      ts: "1789142536.963139",
      thread_ts: threadTs,
    } as SlackMessageEvent);

    assertPrepared(prepared);
    expect(prepared.ctxPayload.InboundEventKind).toBe("user_request");
    expect(prepared.ctxPayload.CommandAuthorized).toBe(false);
    expect(prepared.ctxPayload.GroupSystemPrompt).toContain("outside the delegated thread scope");
  });

  it("dispatches a context-only participant in a thread started by a request user", async () => {
    const threadTs = "1789141187.426359";
    const replies = vi.fn().mockResolvedValue({
      messages: [
        { user: "U_OWNER", text: "Please find the title documents", ts: threadTs },
        { user: "U_CONTEXT", text: "Please upload them to the project", ts: "1789143892.594259" },
      ],
    });
    const channelConfig = {
      enabled: true,
      requireMention: true,
      users: ["U_OWNER", "U_CONTEXT"],
      requestUsers: ["U_OWNER"],
    };
    recordSlackThreadParticipation("default", "C123", threadTs);
    const slackCtx = createInboundSlackCtx({
      cfg: {
        messages: { groupChat: { unmentionedInbound: "room_event" } },
        channels: {
          slack: {
            enabled: true,
            groupPolicy: "allowlist",
            channels: { C123: channelConfig },
          },
        },
      } as OpenClawConfig,
      channelsConfig: { C123: channelConfig },
      defaultRequireMention: true,
      groupPolicy: "allowlist",
      appClient: { conversations: { replies } } as unknown as App["client"],
    });
    slackCtx.allowFrom = ["U_OWNER"];
    slackCtx.resolveUserName = async (userId) => ({
      name: userId === "U_OWNER" ? "Alex" : "Nicholas",
    });
    slackCtx.resolveChannelName = async () => ({ name: "shape-tech", type: "channel" });

    const prepared = await prepareMessageWith(slackCtx, defaultAccount, {
      channel: "C123",
      channel_type: "channel",
      user: "U_CONTEXT",
      text: "Please upload them to the project",
      ts: "1789143892.594259",
      thread_ts: threadTs,
    } as SlackMessageEvent);

    assertPrepared(prepared);
    expect(prepared.ctxPayload.InboundEventKind).toBe("user_request");
    expect(prepared.ctxPayload.CommandAuthorized).toBe(false);
    expect(prepared.ctxPayload.GroupSystemPrompt).toContain("delegated thread scope");
    expect(prepared.ackReactionValue).not.toBe("blue_book");
  });

  it("admits and acknowledges an unmentioned context-only reply in a joined thread", async () => {
    const threadTs = "1788215309.876779";
    const reactionAdd = vi.fn().mockResolvedValue({ ok: true });
    const channelConfig = {
      enabled: true,
      requireMention: true,
      users: ["U_OWNER", "U_CONTEXT"],
      requestUsers: ["U_OWNER"],
    };
    recordSlackThreadParticipation("default", "C123", threadTs);
    const slackCtx = createInboundSlackCtx({
      cfg: {
        messages: { groupChat: { unmentionedInbound: "room_event" } },
        channels: {
          slack: {
            enabled: true,
            groupPolicy: "allowlist",
            channels: { C123: channelConfig },
          },
        },
      } as OpenClawConfig,
      channelsConfig: { C123: channelConfig },
      defaultRequireMention: true,
      groupPolicy: "allowlist",
      appClient: { reactions: { add: reactionAdd } } as unknown as App["client"],
    });
    slackCtx.allowFrom = ["U_OWNER"];
    slackCtx.resolveUserName = async () => ({ name: "Nicholas" });
    slackCtx.resolveChannelName = async () => ({ name: "shape-tech", type: "channel" });

    const prepared = await prepareMessageWith(slackCtx, defaultAccount, {
      channel: "C123",
      channel_type: "channel",
      user: "U_CONTEXT",
      text: "7 is accounted for",
      ts: "1788224029.666049",
      thread_ts: threadTs,
    } as SlackMessageEvent);

    assertPrepared(prepared);
    expect(prepared.ctxPayload.MentionSource).toBe("implicit_thread");
    expect(prepared.ctxPayload.InboundEventKind).toBe("room_event");
    expect(prepared.ctxPayload.CommandAuthorized).toBe(false);
    expect(prepared.ackReactionValue).toBe("blue_book");
    expect(await prepared.ackReactionPromise).toBe(true);
  });

  it.each([
    ["an explicit bot mention", "<@B1> please summarize"],
    ["a control command", "<@B1> /new"],
    ["an abort request", "<@B1> please stop"],
  ])("keeps a context-only collaborator's %s as a room event", async (_label, text) => {
    const reactionAdd = vi.fn().mockResolvedValue({ ok: true });
    const channelConfig = {
      enabled: true,
      requireMention: false,
      users: ["U_OWNER", "U_CONTEXT"],
      requestUsers: ["U_OWNER"],
    };
    const slackCtx = createInboundSlackCtx({
      cfg: {
        messages: { groupChat: { unmentionedInbound: "room_event" } },
        channels: {
          slack: {
            enabled: true,
            groupPolicy: "allowlist",
            channels: { C123: channelConfig },
          },
        },
      } as OpenClawConfig,
      channelsConfig: { C123: channelConfig },
      defaultRequireMention: false,
      groupPolicy: "allowlist",
      appClient: { reactions: { add: reactionAdd } } as unknown as App["client"],
    });
    slackCtx.allowFrom = ["U_OWNER"];
    slackCtx.resolveUserName = async () => ({ name: "Nicholas" });
    slackCtx.resolveChannelName = async () => ({ name: "shape-tech", type: "channel" });

    const prepared = await prepareMessageWith(slackCtx, defaultAccount, {
      channel: "C123",
      channel_type: "channel",
      user: "U_CONTEXT",
      text,
      ts: "1.000",
    } as SlackMessageEvent);

    assertPrepared(prepared);
    expect(prepared.ctxPayload.InboundEventKind).toBe("room_event");
    expect(prepared.ctxPayload.CommandAuthorized).toBe(false);
    expect(prepared.ackReactionValue).toBe("blue_book");
    expect(await prepared.ackReactionPromise).toBe(true);
    expect(reactionAdd).toHaveBeenCalledWith({
      channel: "C123",
      name: "blue_book",
      timestamp: "1.000",
    });
  });

  it("keeps unmentioned abort requests as user requests when room events are enabled", async () => {
    const slackCtx = createAckRoomContext(
      { groupChat: { unmentionedInbound: "room_event" } },
      { defaultRequireMention: false },
    );

    const prepared = await prepareMessageWith(slackCtx, defaultAccount, {
      channel: "C123",
      channel_type: "channel",
      user: "U1",
      text: "please stop",
      ts: "1.000",
    } as SlackMessageEvent);

    assertPrepared(prepared);
    expect(prepared.ctxPayload.InboundEventKind).toBe("user_request");
    expect(prepared.ctxPayload.CommandBody).toBe("please stop");
  });

  it("keeps the original deny behavior when the ephemeral notice fails", async () => {
    const postEphemeral = vi.fn().mockRejectedValue(new Error("invalid_auth xoxb-secret-value"));
    const ctx = createAllowlistDeniedRoomCtx({ postEphemeral });
    const error = vi.fn();
    ctx.runtime.error = error;

    await expect(
      prepareSlackMessage({
        ctx,
        account: defaultAccount,
        message: createSlackMessage({
          channel: "C_DENIED",
          channel_type: "group",
          user: "U1",
          text: "<@B1> hello",
        }),
        opts: { source: "app_mention", wasMentioned: true },
      }),
    ).resolves.toBeNull();

    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toContain("slack allowlist denial notice failed");
    expect(error.mock.calls[0]?.[0]).not.toContain("xoxb-secret-value");
  });

  it("tells a context-only collaborator who mentions the bot that it takes requests from requesters", async () => {
    const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
    const ctx = createRestrictedRoomCtx({
      postEphemeral,
      channel: { requestUsers: ["U_OWNER"] },
    });

    await prepareSlackMessage({
      ctx,
      account: defaultAccount,
      message: createSlackMessage({
        channel: "C_ROOM",
        channel_type: "channel",
        user: "U1",
        text: "<@B1> please adjust the budget",
      }),
      opts: { source: "message" },
    });
    await vi.waitFor(() => expect(postEphemeral).toHaveBeenCalledTimes(1));

    expect(postEphemeral.mock.calls[0]?.[0]).toMatchObject({
      channel: "C_ROOM",
      user: "U1",
      text: expect.stringContaining("only takes requests in this channel from approved requesters"),
    });
  });

  it("does not notify an unmentioned message from a sender outside the channel's users", async () => {
    const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
    const ctx = createRestrictedRoomCtx({ postEphemeral, channel: { users: ["U_OWNER"] } });

    await prepareSlackMessage({
      ctx,
      account: defaultAccount,
      message: createSlackMessage({ channel: "C_ROOM", channel_type: "channel", user: "U1" }),
      opts: { source: "message" },
    });

    expect(postEphemeral).not.toHaveBeenCalled();
  });

  it("tells a sender outside the channel's users why a mention is not answered, once", async () => {
    const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
    const ctx = createRestrictedRoomCtx({
      postEphemeral,
      channel: { users: ["U_OWNER"] },
      contact: "Ask Alex (@alex) for access.",
    });
    const mention = (ts: string) =>
      prepareSlackMessage({
        ctx,
        account: defaultAccount,
        message: createSlackMessage({
          channel: "C_ROOM",
          channel_type: "channel",
          user: "U1",
          text: "<@B1> find the EIN",
          ts,
        }),
        opts: { source: "message" },
      });

    await expect(mention("1.000")).resolves.toBeNull();
    await expect(mention("2.000")).resolves.toBeNull();

    expect(postEphemeral).toHaveBeenCalledExactlyOnceWith({
      token: "token",
      channel: "C_ROOM",
      user: "U1",
      text: "Personal Claw can’t act on your request here because you aren’t on its list of allowed users for this channel. Ask Alex (@alex) for access.",
    });
  });

  it("uses generic copy when the bot display-name lookup fails", async () => {
    const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
    const ctx = createAllowlistDeniedRoomCtx({ postEphemeral });
    ctx.resolveUserName = vi.fn().mockRejectedValue(new Error("users.info failed"));

    await expect(
      prepareSlackMessage({
        ctx,
        account: defaultAccount,
        message: createSlackMessage({
          channel: "C_DENIED",
          channel_type: "channel",
          user: "U1",
          text: "<@B1> hello",
        }),
        opts: { source: "app_mention", wasMentioned: true },
      }),
    ).resolves.toBeNull();

    expect(postEphemeral).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        text: expect.stringMatching(/^This OpenClaw bot can’t reply here/),
      }),
    );
  });

  it("does not send an allowlist notice for an unmentioned denied room message", async () => {
    const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
    const ctx = createAllowlistDeniedRoomCtx({ postEphemeral });

    const prepared = await prepareSlackMessage({
      ctx,
      account: defaultAccount,
      message: createSlackMessage({
        channel: "C_DENIED",
        channel_type: "channel",
        user: "U1",
        text: "hello",
      }),
      opts: { source: "message" },
    });

    expect(prepared).toBeNull();
    expect(postEphemeral).not.toHaveBeenCalled();
  });

  function createRestrictedRoomCtx(params: {
    postEphemeral: ReturnType<typeof vi.fn>;
    channel: { users?: string[]; requestUsers?: string[] };
    contact?: string;
  }): SlackMonitorContext {
    const channelsConfig = { C_ROOM: { enabled: true, ...params.channel } };
    const ctx = createInboundSlackCtx({
      cfg: {
        channels: {
          slack: {
            enabled: true,
            channels: channelsConfig,
            ...(params.contact ? { unansweredMentions: { contact: params.contact } } : {}),
          },
        },
      } as OpenClawConfig,
      appClient: {
        chat: { postEphemeral: params.postEphemeral },
      } as unknown as App["client"],
      channelsConfig,
    });
    ctx.resolveChannelName = async () => ({ name: "project-room", type: "channel" });
    ctx.resolveUserName = async (userId) => ({
      name: userId === ctx.botUserId ? "Personal Claw" : "Alice",
    });
    return ctx;
  }
});
