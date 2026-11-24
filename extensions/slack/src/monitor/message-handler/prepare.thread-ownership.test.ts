import fs from "node:fs/promises";
import type { App } from "@slack/bolt";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SessionBindingAdapter } from "openclaw/plugin-sdk/conversation-runtime";
import type { SessionBindingRecord } from "openclaw/plugin-sdk/conversation-runtime";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
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

function trackMedia(media: ReadonlyArray<{ path?: string }>) {
  for (const item of media) {
    if (item.path) {
      mediaPaths.add(item.path);
    }
  }
}

afterEach(async () => {
  await Promise.all([...mediaPaths].map((path) => fs.rm(path, { force: true })));
  mediaPaths.clear();
});

function slackReply<T>(messages: T[]) {
  return { messages, response_metadata: { next_cursor: "" } };
}

function slackConfig(
  slack: ResolvedSlackAccount["config"] = {},
  extra: OpenClawConfig = {},
): OpenClawConfig {
  return { ...extra, channels: { slack: { enabled: true, ...slack } } };
}

async function prepareInbound(
  ctx: SlackMonitorContext,
  message: Partial<SlackMessageEvent>,
  account: ResolvedSlackAccount = createSlackAccount(),
  opts: Parameters<typeof prepareSlackMessage>[0]["opts"] = { source: "message" },
) {
  const prepared = await prepareSlackMessage({
    ctx,
    account,
    message: createSlackMessage(message),
    opts,
  });
  trackMedia(prepared?.ctxPayload.media ?? []);
  return prepared;
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

describe("slack durable thread ownership", () => {
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

  async function seedSessionEntries(
    storePath: string,
    entries: Record<string, SessionEntry>,
  ): Promise<void> {
    await Promise.all(
      Object.entries(entries).map(([sessionKey, entry]) =>
        upsertSessionEntry({ storePath, sessionKey, entry }),
      ),
    );
  }

  const defaultAccount = createSlackAccount();

  function createThreadSlackCtx(params: {
    cfg?: OpenClawConfig;
    replies: unknown;
    named?: boolean;
  }) {
    const cfg =
      params.cfg ??
      (slackConfig(
        { replyToMode: "all", groupPolicy: "open" },
        { session: { store: storeFixture.makeTmpStorePath().storePath } },
      ) satisfies OpenClawConfig);
    const ctx = createInboundSlackCtx({
      cfg,
      appClient: { conversations: { replies: params.replies } } as App["client"],
      defaultRequireMention: false,
      replyToMode: "all",
    });
    if (params.named) {
      nameContext(ctx);
    }
    return ctx;
  }

  function createThreadAccount(): ResolvedSlackAccount {
    return createSlackAccount({ replyToMode: "all", thread: { initialHistoryLimit: 20 } });
  }

  function createThreadReplyMessage(overrides: Partial<SlackMessageEvent>): SlackMessageEvent {
    return createSlackMessage({
      channel: "C123",
      channel_type: "channel",
      thread_ts: "100.000",
      ...overrides,
    });
  }

  function prepareThreadMessage(ctx: SlackMonitorContext, overrides: Partial<SlackMessageEvent>) {
    return prepareInbound(ctx, createThreadReplyMessage(overrides), createThreadAccount());
  }

  function createReplyToAllSlackCtx(): SlackMonitorContext {
    const ctx = createInboundSlackCtx({
      cfg: slackConfig({ replyToMode: "all" }),
      replyToMode: "all",
    });
    ctx.resolveUserName = async () => ({ name: "Alice" });
    return ctx;
  }

  const fullRichText = `First paragraph ${"keeps going ".repeat(14)}
Second paragraph should still reach the agent after Slack's preview cutoff.`;

  const pastedTable = [
    "ID\tName\tStatus",
    "12345\tExample A\tenabled",
    "12346\tExample B\tenabled",
  ].join("\n");

  it.each(["without runtime", "stale"] as const)(
    "recovers thread history according to %s session freshness",
    async (state) => {
      const { storePath } = storeFixture.makeTmpStorePath();
      const now = Date.now();
      const old = now - 2 * 24 * 60 * 60 * 1000;
      const cfg: OpenClawConfig = slackConfig(
        { replyToMode: "all", groupPolicy: "open" },
        {
          session: {
            store: storePath,
            resetByType:
              state === "stale" ? { thread: { mode: "idle", idleMinutes: 60 } } : undefined,
          },
        },
      );
      const threadTs = { "without runtime": "250.000", stale: "300.000" }[state];
      const sessionKey = `agent:main:slack:channel:c123:thread:${threadTs}`;
      await seedSessionEntries(storePath, {
        [sessionKey]: {
          sessionId: "existing-thread",
          displayName: "Renamed in Slack",
          updatedAt: state === "without runtime" ? old : now,
          sessionStartedAt: old,
          lastInteractionAt: old,
        },
      });
      const starter = { text: "starter", user: "U2", ts: threadTs };
      const replies = vi.fn().mockResolvedValueOnce({ messages: [starter] });
      if (state === "stale") {
        replies.mockResolvedValueOnce(
          slackReply([
            starter,
            { text: "assistant prior output", bot_id: "B1", ts: "300.500" },
            { text: "prior human context", user: "U1", ts: "300.800" },
            { text: "current post-reset message", user: "U1", ts: "301.000" },
          ]),
        );
      }
      const ctx = createThreadSlackCtx({ cfg, replies });
      if (state === "without runtime") {
        ctx.channelRuntime = undefined;
      }
      if (state === "stale") {
        ctx.historyLimit = 50;
        ctx.threadInheritParent = true;
      }
      ctx.resolveUserName = async (id) => ({ name: id === "U1" ? "Alice" : "Bob" });
      ctx.resolveChannelName = async () => ({ name: "general", type: "channel" });
      const prepared = await prepareInbound(
        ctx,
        createThreadReplyMessage({
          text: "current post-reset message",
          ts: "301.000",
          thread_ts: threadTs,
        }),
        createSlackAccount({
          replyToMode: "all",
          thread: { initialHistoryLimit: 10, inheritParent: state === "stale" },
        }),
      );
      assert(prepared);
      expect(prepared.ctxPayload.SessionKey).toBe(sessionKey);
      if (state === "stale") {
        expect(prepared.ctxPayload).toMatchObject({
          IsFirstThreadTurn: true,
          ThreadStarterBody: "starter",
        });
        expect(prepared.ctxPayload.ThreadHistoryBody).toContain("prior human context");
        expect(prepared.ctxPayload.ThreadHistoryBody).not.toContain("assistant prior output");
        expect(prepared.ctxPayload.ThreadHistoryBody).not.toContain("current post-reset message");
        expect(prepared.ctxPayload.ParentSessionKey).toBe("agent:main:slack:channel:c123");
        expect(replies).toHaveBeenCalledTimes(2);
        expect(replies).toHaveBeenLastCalledWith({
          channel: "C123",
          ts: "300.000",
          limit: 200,
          inclusive: false,
          latest: "301.000",
        });
      } else {
        expect(prepared.ctxPayload.IsFirstThreadTurn).toBeUndefined();
        expect(prepared.ctxPayload.ThreadHistoryBody).toBeUndefined();
        expect(prepared.ctxPayload.ThreadStarterBody).toBe("starter");
        expect(prepared.ctxPayload.ThreadLabel).toContain("Slack thread");
        expect(prepared.sessionDisplayName).toBe("Renamed in Slack");
        expect(replies).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("drops ambiguous thread replies instead of treating them as root messages", async () => {
    const replies = vi.fn();
    const slackCtx = createThreadSlackCtx({ replies, named: true });

    const prepared = await prepareInbound(
      slackCtx,
      {
        ...createSlackMessage({
          channel: "C123",
          channel_type: "channel",
          text: "<@B1> can you follow up?",
          ts: "201.000",
          parent_user_id: "U2",
        }),
        _ambiguousThreadReply: true,
      },
      createThreadAccount(),
    );

    expect(prepared).toBeNull();
    expect(replies).not.toHaveBeenCalled();
  });

  it("keeps a self-thread DM reply on its ordinary session after metadata lookup fails", async () => {
    const prepared = await prepareInbound(
      createReplyToAllSlackCtx(),
      { ts: "701.000", thread_ts: "701.000", parent_user_id: "B1" },
      createSlackAccount({ replyToMode: "all" }),
    );
    assert(prepared);
    expect(prepared.ctxPayload).toMatchObject({
      SessionKey: "agent:main:main",
      MessageThreadId: undefined,
      ReplyToId: "701.000",
      TransportThreadId: "701.000",
    });
  });

  it("rejects a participant-only mention when the thread is owned by ACP", async () => {
    const targetSessionKey = "agent:review:acp:session-67739";
    const binding: SessionBindingRecord = {
      bindingId: "test-binding",
      targetSessionKey,
      targetKind: "session",
      conversation: {
        channel: "slack",
        accountId: "default",
        conversationId: "100.000",
        parentConversationId: "C123",
      },
      status: "active",
      boundAt: Date.now(),
      metadata: {},
    };
    const resolveByConversation: SessionBindingAdapter["resolveByConversation"] = vi.fn((ref) =>
      ref.channel === "slack" &&
      ref.accountId === "default" &&
      ref.conversationId === "100.000" &&
      ref.parentConversationId === "C123"
        ? binding
        : null,
    );
    const touch: NonNullable<SessionBindingAdapter["touch"]> = vi.fn();
    const adapter: SessionBindingAdapter = {
      channel: "slack",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation,
      touch,
    };
    registerSessionBindingAdapter(adapter);
    try {
      const replies = vi
        .fn()
        .mockResolvedValue(slackReply([{ text: "starter", user: "U2", ts: "100.000" }]));
      const slackCtx = createThreadSlackCtx({
        cfg: slackConfig(
          { replyToMode: "all", groupPolicy: "open" },
          {
            agents: {
              entries: { main: {}, review: {}, analyst: { identity: { name: "Analyst" } } },
            },
            bindings: [{ agentId: "main", match: { channel: "slack" } }],
            broadcast: { "slack:C123": ["main", "analyst"] },
          },
        ),
        replies,
      });
      slackCtx.defaultRequireMention = true;
      nameContext(slackCtx);

      const prepared = await prepareThreadMessage(slackCtx, {
        text: "@Analyst please review",
        ts: "100.000",
      });

      expect(resolveByConversation).toHaveBeenCalledWith(binding.conversation);
      expect(prepared).toBeNull();
    } finally {
      unregisterSessionBindingAdapter({ channel: "slack", accountId: "default", adapter });
    }
  });

  let rootSequence = 0;

  it.each([
    { owner: "enterprise", text: "<@B1> review this", mode: "all" },
    { owner: "implicit", text: "review this", mode: "first" },
    { owner: "plugin", text: "Bill review this", mode: "all" },
  ] as const)("keeps $owner roots and follow-ups on one session", async ({ owner, text, mode }) => {
    const { storePath } = storeFixture.makeTmpStorePath();
    const channel = "C123";
    const rootTs = `1777244692.${++rootSequence}00000`;
    const teamId = owner === "enterprise" ? "T123ENTERPRISE" : undefined;
    const channels = owner === "implicit" ? { C123: { requireMention: false } } : undefined;
    const cfg: OpenClawConfig = slackConfig(
      { replyToMode: mode, groupPolicy: "open", channels },
      {
        session: { store: storePath },
        messages:
          owner === "plugin" ? { groupChat: { mentionPatterns: ["\\bbill\\b"] } } : undefined,
      },
    );
    const replies = vi.fn().mockResolvedValue(slackReply([{ text, user: "U1", ts: rootTs }]));
    const ctx = createInboundSlackCtx({
      cfg,
      replyToMode: mode,
      channelsConfig: channels,
      appClient: { conversations: { replies } } as unknown as App["client"],
    });
    nameContext(ctx);
    if (teamId) {
      ctx.botUserId = "";
    }
    const eventScope = teamId ? { teamId, client: ctx.app.client } : undefined;
    const binding: SessionBindingRecord = {
      bindingId: "root-binding",
      targetSessionKey: "agent:plugin:slack:channel:c123",
      targetKind: "session",
      status: "active",
      boundAt: 1,
      conversation: { channel: "slack", accountId: "default", conversationId: channel },
      metadata:
        owner === "plugin"
          ? {
              pluginBindingOwner: "plugin",
              pluginId: "demo-plugin",
              pluginRoot: "/tmp/demo-plugin",
            }
          : {},
    };
    const adapter: SessionBindingAdapter = {
      channel: "slack",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (ref) => (ref.conversationId === channel ? binding : null),
    };
    const bound = owner === "plugin";
    if (bound) {
      registerSessionBindingAdapter(adapter);
    }
    const rootMessage = createSlackMessage({ channel, channel_type: "channel", text, ts: rootTs });
    const prepare = (message: SlackMessageEvent, source: "message" | "app_mention") =>
      prepareInbound(ctx, message, createSlackAccount({ replyToMode: mode }), {
        source,
        wasMentioned: source === "app_mention" || undefined,
        eventScope,
      });
    try {
      const root = await prepare(rootMessage, teamId ? "app_mention" : "message");
      recordSlackThreadParticipation("default", channel, rootTs, { teamId });
      const followUp = await prepare(
        {
          ...rootMessage,
          text: owner === "plugin" ? "<@B1> ?" : "https://example.test/issue",
          ts: "1777244714.000100",
          thread_ts: rootTs,
          parent_user_id: "U1",
        },
        "message",
      );
      assert(root);
      assert(followUp);
      const expectedKey = `agent:main:slack:channel:${teamId ? "team:t123enterprise:channel:" : ""}c123:thread:${rootTs}`;
      expect(root.ctxPayload.SessionKey).toBe(expectedKey);
      expect(followUp.ctxPayload).toMatchObject({
        SessionKey: expectedKey,
        MessageThreadId: rootTs,
        ReplyToId: rootTs,
        MessageSid: "1777244714.000100",
      });
      expect(root.route.agentId).toBe("main");
      expect(root.ctxPayload).not.toHaveProperty("SystemEventSessionKey");
      expect(followUp.ctxPayload).not.toHaveProperty("SystemEventSessionKey");
      if (teamId) {
        expect(followUp.ctxPayload.WasMentioned).toBe(true);
      }
      if (mode === "first") {
        expect(root.ctxPayload.MessageThreadId).toBeUndefined();
        expect(root.ctxPayload.ReplyToId).toBeUndefined();
      }
    } finally {
      if (bound) {
        unregisterSessionBindingAdapter({ channel: "slack", accountId: "default", adapter });
      }
    }
  });
});
