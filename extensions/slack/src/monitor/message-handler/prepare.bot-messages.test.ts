import type { App } from "@slack/bolt";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import { prepareSlackMessage } from "./prepare.js";
import { createInboundSlackTestContext, createSlackTestAccount } from "./prepare.test-helpers.js";

vi.mock("openclaw/plugin-sdk/system-event-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/system-event-runtime")>()),
  enqueueRoutedSystemEvent: vi.fn(),
}));

function fixture(config: ResolvedSlackAccount["config"] = {}) {
  const members = vi.fn().mockResolvedValue({ members: ["UOWNER"], response_metadata: {} });
  const ctx = createInboundSlackTestContext({
    cfg: { channels: { slack: { enabled: true } } },
    defaultRequireMention: false,
    appClient: { conversations: { members } } as unknown as App["client"],
  });
  ctx.allowFrom = ["UOWNER"];
  ctx.resolveUserName = async () => ({ name: "Bot" });
  const message: SlackMessageEvent = {
    type: "message",
    channel: "C123",
    channel_type: "channel",
    bot_id: "B_OTHER",
    subtype: "bot_message",
    username: "deploy-bot",
    text: "Readiness probe failed",
    ts: "1.000",
  };
  const prepare = () =>
    prepareSlackMessage({
      ctx,
      account: createSlackTestAccount(config),
      message,
      opts: { source: "message" },
    });
  return { ctx, members, message, prepare };
}

describe("Slack bot-message admission", () => {
  it("preserves attachment-only bot DM content without treating it as commands (#27616)", async () => {
    const test = fixture({ allowBots: "mentions" });
    test.ctx.allowFrom = ["*"];
    Object.assign(test.message, {
      channel: "D123",
      channel_type: "im",
      user: "U1",
      text: "",
      attachments: [{ text: "Readiness probe failed" }],
    });
    const prepared = await test.prepare();
    expect(prepared?.ctxPayload.RawBody).toContain("Readiness probe failed");
    expect(prepared?.ctxPayload.CommandBody).toBe("");
    expect(prepared?.ctxPayload.BodyForCommands).toBe("");
    expect(prepared?.ctxPayload.BodyForAgent).toContain("Readiness probe failed");
    expect(prepared?.ctxPayload.ChannelContext).toMatchObject({
      sender: { isBot: true },
      chat: { id: "D123", eventId: "1.000" },
    });
  });

  it("carries the actual channel, sender and child event for a verified human thread reply", async () => {
    const test = fixture();
    test.ctx.allowFrom = ["*"];
    const prepared = await prepareSlackMessage({
      ctx: test.ctx,
      account: createSlackTestAccount(),
      message: {
        type: "message",
        channel: "C123",
        channel_type: "channel",
        user: "U0ADMIN001",
        text: "status update",
        ts: "1792190933.152459",
        thread_ts: "1792189039.487369",
      },
      opts: { source: "message", senderAuthentication: "verified" },
    });
    expect(prepared).toBeDefined();
    expect(prepared?.ctxPayload.SenderAuthentication).toBe("verified");
    expect(prepared?.ctxPayload.ChannelContext).toMatchObject({
      sender: { id: "U0ADMIN001" },
      chat: { id: "C123", eventId: "1792190933.152459" },
    });
    expect(prepared?.ctxPayload.ChannelContext?.sender?.isBot).not.toBe(true);
  });

  it.each(["present", "absent", "lookup failure"] as const)(
    "requires owner presence when no room users are configured: %s (#59284)",
    async (owner) => {
      const test = fixture(owner === "present" ? {} : { allowBots: true });
      if (owner === "lookup failure") {
        test.members.mockRejectedValue(new Error("missing_scope"));
      } else {
        test.members.mockResolvedValue({
          members: [owner === "present" ? "UOWNER" : "UOTHER"],
          response_metadata: {},
        });
      }
      const prepared = await test.prepare();
      if (owner === "present") {
        expect(prepared?.ctxPayload.RawBody).toBe("Readiness probe failed");
      } else {
        expect(prepared).toBeNull();
      }
      expect(test.members).toHaveBeenCalledExactlyOnceWith({
        token: "token",
        channel: "C123",
        limit: 999,
      });
    },
  );

  it.each(["room override", "self", "unmentioned", "mentioned"] as const)(
    "applies bot admission before owner lookup: %s",
    async (mode) => {
      const test = fixture({
        allowBots: mode === "room override" ? true : mode === "self" ? undefined : "mentions",
      });
      if (mode !== "self") {
        test.ctx.channelsConfig = {
          C123: mode === "room override" ? { allowBots: false } : { users: ["B_OTHER"] },
        };
        test.ctx.channelsConfigKeys = ["C123"];
      }
      test.message.bot_id = mode === "self" ? "B1" : "B_OTHER";
      test.message.text = mode === "mentioned" ? "hey <@B1> status failed" : "status failed";
      const prepared = await test.prepare();
      if (mode === "mentioned") {
        expect(prepared?.ctxPayload.RawBody).toContain("status failed");
      } else {
        expect(prepared).toBeNull();
      }
      expect(test.members).not.toHaveBeenCalled();
    },
  );
});
