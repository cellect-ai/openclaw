import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebClient } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackActionContext } from "./action-runtime.js";
import { handleSlackAction, slackActionRuntime } from "./action-runtime.js";
import { sendSlackMessage as sendSlackMessageThroughPublicOwner } from "./actions.js";
import { parseSlackBlocksInput } from "./blocks-input.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";
import type { SlackSendResult } from "./send.js";
import { buildSlackThreadingToolContext } from "./threading-tool-context.js";

const originalSlackActionRuntime = { ...slackActionRuntime };
const deleteSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));
const downloadSlackFile = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
const editSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));
const getSlackMemberInfo = vi.fn(async (..._args: unknown[]) => ({}));
const isSlackConversationMember = vi.fn(async (..._args: unknown[]): Promise<boolean> => false);
const listSlackFileShareChannelIds = vi.fn(async (..._args: unknown[]): Promise<string[]> => []);
const listSlackEmojis = vi.fn(async (..._args: unknown[]) => ({}));
const listSlackPins = vi.fn(async (..._args: unknown[]) => ({}));
const listSlackReactions = vi.fn(async (..._args: unknown[]) => ({}));
const pinSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));
const reactSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));
const readSlackMessages = vi.fn(async (..._args: unknown[]) => ({}));
const removeOwnSlackReactions = vi.fn(async (..._args: unknown[]) => ["thumbsup"]);
const removeSlackReaction = vi.fn(async (..._args: unknown[]) => ({}));
const resolveSlackConversationName = vi.fn(
  async (..._args: unknown[]): Promise<string | undefined> => undefined,
);
const resolveSlackConversationInfo = vi.fn(
  async (params: {
    cfg: OpenClawConfig;
    channelId: string;
    requireFreshName?: boolean;
  }): Promise<{ type: "channel" | "group" | "dm" | "unknown"; name?: string; user?: string }> => {
    if (/^D/i.test(params.channelId)) {
      return { type: "dm", user: "U123" };
    }
    if (/^G/i.test(params.channelId)) {
      return { type: "group" };
    }
    const slackConfig = params.cfg.channels?.slack as
      | { userToken?: string; botToken?: string; channels?: Record<string, unknown> }
      | undefined;
    const token = slackConfig?.userToken ?? slackConfig?.botToken;
    const tokenOverride = token && token !== slackConfig?.botToken ? { token } : {};
    const channelName = params.requireFreshName
      ? await resolveSlackConversationName(params.channelId, {
          cfg: params.cfg,
          ...tokenOverride,
        })
      : undefined;
    return { type: "channel", ...(channelName ? { name: channelName } : {}) };
  },
);
const sendSlackMessage = vi.fn(
  async (..._args: unknown[]): Promise<Partial<SlackSendResult> & { channelId: string }> => ({
    channelId: "C123",
  }),
);
const unpinSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));

describe("handleSlackAction", () => {
  let cfg: OpenClawConfig;
  const message = { channelId: "C123", messageId: "123.456" };
  const send = { action: "sendMessage", to: "channel:C123" };
  const upload = { action: "uploadFile", to: "channel:C123", filePath: "/tmp/report.png" };
  function slackConfig(overrides?: Record<string, unknown>): OpenClawConfig {
    return { channels: { slack: { botToken: "tok", ...overrides } } };
  }

  function namedPolicy(overrides?: Record<string, unknown>) {
    return slackConfig({
      groupPolicy: "allowlist",
      dangerouslyAllowNameMatching: true,
      channels: { "#allowed-channel": { enabled: true } },
      ...overrides,
    });
  }

  const trustedContext = {
    currentChannelProvider: "slack",
    currentChannelId: "team:T123:channel:C123",
    requesterAccountId: "default",
  };

  it("reads normalized pins from the trusted current workspace", async () => {
    listSlackPins.mockResolvedValueOnce([{ message: { ts: "1712345678.123456", text: "pin" } }]);
    const result = await handleSlackAction(
      { action: "listPins", channelId: "C123" },
      cfg,
      trustedContext,
    );
    expect(listSlackPins).toHaveBeenCalledWith("C123", { cfg, teamId: "T123" });
    expect(result.details).toMatchObject({
      ok: true,
      pins: [{ message: { ts: "1712345678.123456", text: "pin", timestampMs: 1712345678123 } }],
    });
  });

  it("rejects a bare detached target for an authenticated Enterprise install", async () => {
    const installationState = registerSlackInstallationState("default", "enterprise");
    try {
      await expect(
        handleSlackAction({ action: "react", ...message, emoji: "thumbsup" }, cfg),
      ).rejects.toThrow("unsupported_enterprise_slack_delivery");
      expect(reactSlackMessage).not.toHaveBeenCalled();
    } finally {
      installationState.release();
    }
  });

  it("reads the current requester from the trusted current workspace", async () => {
    const info = { ok: true, user: { id: "U123", is_bot: false } };
    getSlackMemberInfo.mockResolvedValueOnce(info);
    const result = await handleSlackAction({ action: "memberInfo", userId: "U123" }, cfg, {
      ...trustedContext,
      requesterSenderId: "U123",
    });
    expect(getSlackMemberInfo).toHaveBeenCalledWith("U123", { cfg, teamId: "T123" });
    expect(result.details).toEqual({ ok: true, info });
  });

  it.each([
    { name: "an unqualified conversation", context: { currentChannelId: "C123" } },
    {
      name: "conflicting current workspaces",
      context: {
        currentChannelId: "team:T123:channel:C123",
        currentMessagingTarget: "team:T999:channel:C123",
      },
    },
  ])("rejects Enterprise metadata reads with $name", async ({ context }) => {
    const installationState = registerSlackInstallationState("default", "enterprise");
    try {
      for (const action of ["memberInfo", "emojiList"]) {
        await expect(
          handleSlackAction({ action, userId: "U123" }, cfg, {
            ...context,
            currentChannelProvider: "slack",
            requesterAccountId: "default",
            requesterSenderId: "U123",
          }),
        ).rejects.toThrow("unsupported_enterprise_slack_delivery");
      }
      expect(getSlackMemberInfo).not.toHaveBeenCalled();
      expect(listSlackEmojis).not.toHaveBeenCalled();
    } finally {
      installationState.release();
    }
  });

  describe("requester-member permalink reads", () => {
    const requester = {
      currentChannelProvider: "slack",
      currentChannelId: "C_CURRENT",
      requesterAccountId: "default",
      requesterSenderId: "U123",
    } satisfies SlackActionContext;
    const allowlisted = () =>
      slackConfig({ groupPolicy: "allowlist", channels: { C_CURRENT: { enabled: true } } });

    it("reads a DM permalink when the requester is the DM's member", async () => {
      readSlackMessages.mockResolvedValueOnce({ messages: [{ ts: "1.000001" }], hasMore: false });

      const result = await handleSlackAction(
        { action: "readMessages", channelId: "D0DM", messageId: "1.000001" },
        allowlisted(),
        requester,
      );

      expect(requireDetails(result).ok).toBe(true);
      expect(requireMockArg(readSlackMessages, "readSlackMessages", 0, 0)).toBe("D0DM");
      expect(isSlackConversationMember).not.toHaveBeenCalled();
    });

    it("refuses a DM that belongs to someone other than the requester", async () => {
      await expect(
        handleSlackAction({ action: "readMessages", channelId: "D0DM" }, allowlisted(), {
          ...requester,
          requesterSenderId: "U999",
        }),
      ).rejects.toThrow("the requester is not a member of conversation D0DM");
      expect(readSlackMessages).not.toHaveBeenCalled();
    });

    it("reads a non-allowlisted channel the requester belongs to", async () => {
      isSlackConversationMember.mockResolvedValueOnce(true);
      readSlackMessages.mockResolvedValueOnce({ messages: [], hasMore: false });

      await handleSlackAction(
        { action: "readMessages", channelId: "C_OTHER" },
        allowlisted(),
        requester,
      );

      expect(isSlackConversationMember).toHaveBeenCalledWith(
        "C_OTHER",
        "U123",
        expect.objectContaining({ cfg: expect.anything() }),
      );
      expect(requireMockArg(readSlackMessages, "readSlackMessages", 0, 0)).toBe("C_OTHER");
    });

    it("refuses a channel the requester is not in", async () => {
      isSlackConversationMember.mockResolvedValueOnce(false);

      await expect(
        handleSlackAction(
          { action: "readMessages", channelId: "C_OTHER" },
          allowlisted(),
          requester,
        ),
      ).rejects.toThrow("the requester is not a member of conversation C_OTHER");
      expect(readSlackMessages).not.toHaveBeenCalled();
    });

    it("explains when the Slack app itself cannot see the conversation", async () => {
      isSlackConversationMember.mockRejectedValueOnce(
        Object.assign(new Error("An API error occurred: channel_not_found"), {
          data: { ok: false, error: "channel_not_found" },
        }),
      );

      await expect(
        handleSlackAction({ action: "readMessages", channelId: "G_PRIVATE" }, allowlisted(), {
          ...requester,
        }),
      ).rejects.toThrow(
        /cannot see conversation G_PRIVATE \(channel_not_found\).*forward the message/,
      );
    });

    it("never overrides an explicitly disabled channel", async () => {
      isSlackConversationMember.mockResolvedValue(true);

      await expect(
        handleSlackAction(
          { action: "readMessages", channelId: "C_DISABLED" },
          slackConfig({ groupPolicy: "allowlist", channels: { C_DISABLED: { enabled: false } } }),
          requester,
        ),
      ).rejects.toThrow("Slack read target channel is not allowed.");
      expect(isSlackConversationMember).not.toHaveBeenCalled();
      isSlackConversationMember.mockReset().mockResolvedValue(false);
    });

    it("does not extend requester membership to writes or untrusted callers", async () => {
      isSlackConversationMember.mockResolvedValue(true);

      await expect(
        handleSlackAction(
          { action: "deleteMessage", channelId: "C_OTHER", messageId: "1.000001" },
          allowlisted(),
          requester,
        ),
      ).rejects.toThrow("Slack read target channel is not allowed.");
      await expect(
        handleSlackAction({ action: "readMessages", channelId: "C_OTHER" }, allowlisted(), {
          ...requester,
          requesterAccountId: "other",
        }),
      ).rejects.toThrow("Slack read target channel is not allowed.");
      expect(isSlackConversationMember).not.toHaveBeenCalled();
      isSlackConversationMember.mockReset().mockResolvedValue(false);
    });

    it("finds a file permalink's conversation through its shares", async () => {
      listSlackFileShareChannelIds.mockResolvedValueOnce(["C_OTHER", "D0DM"]);
      isSlackConversationMember.mockResolvedValueOnce(false);
      downloadSlackFile.mockResolvedValueOnce(null);

      await handleSlackAction(
        { action: "downloadFile", fileId: "F123", fromPermalink: true },
        allowlisted(),
        requester,
      );

      expect(requireMockArg(listSlackFileShareChannelIds, "shares", 0, 0)).toBe("F123");
      expect(requireRecordArg(downloadSlackFile, "downloadSlackFile", 0, 1).channelId).toBe("D0DM");
    });

    it("refuses a file permalink shared nowhere the requester can read", async () => {
      listSlackFileShareChannelIds.mockResolvedValueOnce(["C_OTHER"]);
      isSlackConversationMember.mockResolvedValueOnce(false);

      await expect(
        handleSlackAction(
          { action: "downloadFile", fileId: "F123", fromPermalink: true },
          allowlisted(),
          requester,
        ),
      ).rejects.toThrow("Slack file F123 is not shared in any conversation");
      expect(downloadSlackFile).not.toHaveBeenCalled();
    });

    it("stages every file attached to a permalinked message with a streamed hash", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-permalink-"));
      const filePath = path.join(dir, "phase-i.pdf");
      await fs.writeFile(filePath, "%PDF-1.7 original bytes");
      readSlackMessages.mockResolvedValueOnce({
        messages: [{ ts: "1.000001", files: [{ id: "F1" }] }],
        hasMore: false,
      });
      downloadSlackFile.mockResolvedValueOnce({
        path: filePath,
        contentType: "application/pdf",
        placeholder: "[Slack file: phase-i.pdf]",
      });
      try {
        const result = await handleSlackAction(
          { action: "downloadFile", channelId: "C_CURRENT", messageId: "1.000001" },
          allowlisted(),
          requester,
        );
        expect(requireRecordArg(readSlackMessages, "readSlackMessages", 0, 1)).toMatchObject({
          messageId: "1.000001",
          limit: 1,
        });
        expect(requireDetails(result)).toMatchObject({
          ok: true,
          files: [
            {
              fileId: "F1",
              ok: true,
              size: 23,
              sha256: createHash("sha256").update("%PDF-1.7 original bytes").digest("hex"),
            },
          ],
        });
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("reports an oversized file in a batch without failing the others", async () => {
      downloadSlackFile.mockRejectedValueOnce(
        new Error("Slack file F1 is 141.0 MB, above the 100.0 MB download cap"),
      );

      const result = await handleSlackAction(
        { action: "downloadFile", channelId: "C_CURRENT", fileIds: ["F1"] },
        allowlisted(),
        requester,
      );

      expect(requireDetails(result)).toMatchObject({
        ok: false,
        files: [{ fileId: "F1", ok: false, error: expect.stringContaining("download cap") }],
      });
    });
  });

  it("limits delegated member info to the requester by default", async () => {
    await expect(
      handleSlackAction({ action: "memberInfo", userId: "U999" }, slackConfig(), {
        currentChannelProvider: "slack",
        currentChannelId: "team:T123:channel:C123",
        requesterAccountId: "default",
        requesterSenderId: "U123",
      }),
    ).rejects.toThrow("Delegated Slack member info is limited to the current requester.");
    expect(getSlackMemberInfo).not.toHaveBeenCalled();
  });

  it("resolves any workspace member when the account's memberInfoScope is workspace", async () => {
    getSlackMemberInfo.mockResolvedValueOnce({ ok: true, user: { id: "U999" } });
    const cfg = slackConfig({ memberInfoScope: "workspace" });

    const result = await handleSlackAction({ action: "memberInfo", userId: "U999" }, cfg, {
      currentChannelProvider: "slack",
      currentChannelId: "team:T123:channel:C123",
      requesterAccountId: "default",
      requesterSenderId: "U123",
    });

    expect(getSlackMemberInfo).toHaveBeenCalledWith("U999", { cfg, teamId: "T123" });
    expect(requireDetails(result)).toMatchObject({ ok: true, info: { user: { id: "U999" } } });
  });
  });

  it("scopes every message and pin write to the trusted current workspace", async () => {
    await handleSlackAction({ ...send, content: "created" }, cfg, trustedContext);
    await handleSlackAction(
      { action: "editMessage", ...message, content: "updated" },
      cfg,
      trustedContext,
    );
    for (const action of ["deleteMessage", "pinMessage", "unpinMessage"]) {
      await handleSlackAction(
        { action, channelId: "C123", messageId: "123.456" },
        cfg,
        trustedContext,
      );
    }
    expectSlackSendCall(0, "team:T123:channel:C123", "created", {
      cfg,
      mediaUrl: undefined,
      threadTs: undefined,
      blocks: undefined,
    });
    expect(editSlackMessage).toHaveBeenCalledWith("C123", "123.456", "updated", {
      cfg,
      teamId: "T123",
      blocks: undefined,
    });
    for (const operation of [deleteSlackMessage, pinSlackMessage, unpinSlackMessage]) {
      expect(operation).toHaveBeenCalledWith("C123", "123.456", { cfg, teamId: "T123" });
    }
  });

  it("scopes history, file, reaction, and emoji reads to the trusted workspace", async () => {
    readSlackMessages.mockResolvedValueOnce({
      messages: [{ ts: "1712345678.123456", text: "hi" }],
      hasMore: false,
    });
    listSlackReactions.mockResolvedValueOnce([]);
    downloadSlackFile.mockResolvedValueOnce(null);
    listSlackEmojis.mockResolvedValueOnce({ ok: true, emoji: { openai: "url" } });
    const history = await handleSlackAction(
      {
        action: "readMessages",
        channelId: "C123",
        threadId: "1712345678.123456",
        messageId: "1712345678.654321",
        limit: "20",
      },
      cfg,
      trustedContext,
    );
    await handleSlackAction(
      { action: "reactions", channelId: "C123", messageId: "123.456" },
      cfg,
      trustedContext,
    );
    await handleSlackAction(
      { action: "downloadFile", channelId: "C123", fileId: "F123" },
      cfg,
      trustedContext,
    );
    await handleSlackAction({ action: "emojiList" }, cfg, trustedContext);
    expect(readSlackMessages).toHaveBeenCalledWith("C123", {
      cfg,
      teamId: "T123",
      limit: 20,
      before: undefined,
      after: undefined,
      threadId: "1712345678.123456",
      messageId: "1712345678.654321",
    });
    expect(history.details).toMatchObject({
      ok: true,
      channelId: "C123",
      threadId: "1712345678.123456",
      hasMore: false,
      messages: [{ ts: "1712345678.123456", timestampMs: 1712345678123 }],
    });
    expect(listSlackReactions).toHaveBeenCalledWith("C123", "123.456", { cfg, teamId: "T123" });
    expect(downloadSlackFile).toHaveBeenCalledWith(
      "F123",
      expect.objectContaining({
        cfg,
        teamId: "T123",
        channelId: "C123",
      }),
    );
    expect(listSlackEmojis).toHaveBeenCalledWith({ cfg, teamId: "T123" });
  });

  function createReplyToFirstContext(
    hasRepliedRef = { value: false },
  ): SlackActionContext & { hasRepliedRef: { value: boolean } } {
    return {
      currentChannelId: "C123",
      currentThreadTs: "1111111111.111111",
      replyToMode: "first",
      hasRepliedRef,
    };
  }

  const requireRecord = createRequireRecord("object", "label-not-object");

  function expectSlackSendCall(
    index: number,
    target: string,
    content: string,
    optionFields: Record<string, unknown>,
  ) {
    const call = sendSlackMessage.mock.calls[index];
    expect(call).toEqual([target, content, expect.objectContaining(optionFields)]);
    return requireRecord(call?.[2], "Slack send options");
  }

  function expectLastSlackSend(content: string, config: OpenClawConfig, threadTs?: string) {
    expectSlackSendCall(sendSlackMessage.mock.calls.length - 1, "channel:C123", content, {
      cfg: config,
      mediaUrl: undefined,
      threadTs,
      blocks: undefined,
    });
  }

  function requireDetails(result: Awaited<ReturnType<typeof handleSlackAction>>) {
    return requireRecord(result.details, "action result details");
  }

  async function sendSecondMessageAndExpectNoThread(params: {
    cfg: OpenClawConfig;
    context: SlackActionContext;
  }) {
    await handleSlackAction({ ...send, content: "Second" }, params.cfg, params.context);
    expectLastSlackSend("Second", params.cfg);
  }

  it("fails closed for thread-required contexts without a thread timestamp", async () => {
    await expect(
      handleSlackAction({ ...send, content: "keep private" }, slackConfig(), {
        currentChannelId: "C123",
        replyToMode: "all",
        sameChannelThreadRequired: true,
      }),
    ).rejects.toThrow("Slack thread context is required");
    expect(sendSlackMessage).not.toHaveBeenCalled();
  });

  it("allows explicit top-level sends from thread-required contexts", async () => {
    await handleSlackAction({ ...send, content: "root", topLevel: true }, cfg, {
      currentChannelId: "C123",
      replyToMode: "all",
      sameChannelThreadRequired: true,
    });
    expectLastSlackSend("root", cfg);
  });

  it("forwards preformatted fallback text and trusted forced-media access for user identity", async () => {
    cfg = slackConfig({ postAs: "user", userToken: "test-user-token" });
    const mediaAccess = {
      localRoots: ["/tmp/workspace-agent"],
      readFile: vi.fn(async () => Buffer.from("image")),
      workspaceDir: "/tmp/workspace-agent",
    };
    await handleSlackAction(
      {
        ...send,
        content: "- Account: &lt;@U123&gt;",
        mediaUrl: "https://example.com/report.csv",
        textIsSlackMrkdwn: true,
        forceDocument: true,
      },
      cfg,
      { mediaAccess, mediaLocalRoots: mediaAccess.localRoots },
    );
    const options = expectSlackSendCall(0, "channel:C123", "- Account: &lt;@U123&gt;", {
      cfg,
      token: "test-user-token",
      mediaUrl: "https://example.com/report.csv",
      textIsSlackMrkdwn: true,
      forceDocument: true,
      blocks: undefined,
      mediaAccess,
      mediaLocalRoots: mediaAccess.localRoots,
      mediaReadFile: undefined,
    });
    expect(options.mediaAccess).toBe(mediaAccess);
    expect(sendSlackMessage).toHaveBeenCalledOnce();
  });

  beforeEach(() => {
    cfg = slackConfig();
    vi.clearAllMocks();
    resolveSlackConversationName.mockReset().mockResolvedValue(undefined);
    resolveSlackConversationInfo.mockClear();
    Object.assign(slackActionRuntime, originalSlackActionRuntime, {
      deleteSlackMessage,
      downloadSlackFile,
      editSlackMessage,
      getSlackMemberInfo,
      isSlackConversationMember,
      listSlackFileShareChannelIds,
      listSlackEmojis,
      listSlackPins,
      listSlackReactions,
      parseSlackBlocksInput,
      pinSlackMessage,
      reactSlackMessage,
      readSlackMessages,
      removeOwnSlackReactions,
      removeSlackReaction,
      resolveSlackConversationInfo,
      sendSlackMessage,
      unpinSlackMessage,
    });
  });

  it("qualifies a bare reaction target from the trusted current conversation", async () => {
    const installationState = registerSlackInstallationState("default", "enterprise");
    try {
      const result = await handleSlackAction(
        { action: "react", channelId: "channel:c08gqh53ejm", messageId: "123.456", emoji: "✅" },
        cfg,
        { ...trustedContext, currentChannelId: "team:T123:channel:C08GQH53EJM" },
      );

      expect(result.details).toEqual({ ok: true, added: "✅" });
      expect(reactSlackMessage).toHaveBeenCalledWith("C08GQH53EJM", "123.456", "✅", {
        cfg,
        teamId: "T123",
      });
    } finally {
      installationState.release();
    }
  });

  it.each([
    ["provider", { currentChannelProvider: "discord" }],
    ["account", { requesterAccountId: "other" }],
    ["workspace", { currentMessagingTarget: "team:T456:channel:C123" }],
  ] as const)("does not infer a workspace from conflicting %s context", async (_, patch) => {
    await handleSlackAction({ action: "react", ...message, emoji: "✅" }, cfg, {
      ...trustedContext,
      ...patch,
    });
    expect(reactSlackMessage).toHaveBeenCalledWith("C123", "123.456", "✅", { cfg });
  });

  it("removes a reaction in the explicitly selected workspace", async () => {
    await handleSlackAction(
      {
        action: "react",
        channelId: "team:T123:channel:C123",
        messageId: "123.456",
        emoji: "✅",
        remove: true,
      },
      cfg,
    );
    expect(removeSlackReaction).toHaveBeenCalledWith("C123", "123.456", "✅", {
      cfg,
      teamId: "T123",
    });
  });

  it("removes own reactions on empty emoji", async () => {
    await handleSlackAction(
      { action: "react", channelId: "C1", messageId: "123.456", emoji: "" },
      cfg,
    );
    expect(removeOwnSlackReactions).toHaveBeenCalledWith("C1", "123.456", { cfg });
  });

  it("respects reaction gating", async () => {
    await expect(
      handleSlackAction(
        { action: "react", ...message, emoji: "✅" },
        slackConfig({ actions: { reactions: false } }),
      ),
    ).rejects.toThrow(/Slack reactions are disabled/);
    expect(reactSlackMessage).not.toHaveBeenCalled();
  });

  it("passes replyBroadcast to sendSlackMessage for thread replies", async () => {
    const cfg = slackConfig();
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "Hello thread",
        threadTs: "1234567890.123456",
        replyBroadcast: true,
      },
      cfg,
    );
    expectSlackSendCall(0, "channel:C123", "Hello thread", {
      cfg,
      mediaUrl: undefined,
      threadTs: "1234567890.123456",
      replyBroadcast: true,
      blocks: undefined,
    });
  });

  it("returns a friendly error when downloadFile cannot fetch the attachment", async () => {
    downloadSlackFile.mockResolvedValueOnce(null);
    const result = await handleSlackAction(
      {
        action: "downloadFile",
        fileId: "F123",
        channelId: "C1",
      },
      slackConfig(),
    );
    expect(requireMockArg(downloadSlackFile, "downloadSlackFile", 0, 0)).toBe("F123");
    expect(requireRecordArg(downloadSlackFile, "downloadSlackFile", 0, 1).token).toBe("tok");
    expect(requireRecordArg(downloadSlackFile, "downloadSlackFile", 0, 1).maxBytes).toBe(
      200 * 1024 * 1024,
    );
    expect(requireDetails(result)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/requested Slack channel or explicit thread/i),
    });
  });

  it("fails closed for downloadFile when no channel target can be authorized", async () => {
    await expect(
      handleSlackAction({ action: "downloadFile", fileId: "F123" }, slackConfig()),
    ).rejects.toThrow(
      "Slack file download requires channelId or to so the read target can be authorized.",
    );
    expect(downloadSlackFile).not.toHaveBeenCalled();
  });

  it("authorizes a context-only download and reports unavailable attachments", async () => {
    downloadSlackFile.mockResolvedValueOnce(null);
    cfg = slackConfig({ groupPolicy: "allowlist", channels: { C_ALLOWED: { enabled: true } } });
    const result = await handleSlackAction({ action: "downloadFile", fileId: "F123" }, cfg, {
      currentChannelId: "C_ALLOWED",
    });
    expect(downloadSlackFile).toHaveBeenCalledWith(
      "F123",
      expect.objectContaining({
        channelId: "C_ALLOWED",
        token: "tok",
        maxBytes: 20 * 1024 * 1024,
      }),
    );
    expect(result.details).toMatchObject({
      ok: false,
      error: expect.stringMatching(/requested Slack channel or explicit thread/i),
    });
  });

  it("returns non-image downloadFile results as file metadata instead of image content", async () => {
    downloadSlackFile.mockResolvedValueOnce({
      path: "/tmp/openclaw-media/report.pdf",
      contentType: "application/pdf",
      placeholder: "[Slack file: report.pdf (fileId: F123)]",
    });

    const result = await handleSlackAction(
      {
        action: "downloadFile",
        fileId: "F123",
        to: "channel:C1",
        replyTo: "123.456",
      },
      slackConfig({ accounts: { default: { botToken: "xoxb-bot", userToken: "xoxp-user" } } }),
    );

    expect(downloadSlackFile).toHaveBeenCalledWith(
      "F123",
      expect.objectContaining({
        channelId: "C1",
        threadId: "123.456",
        token: "xoxp-user",
      }),
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("/tmp/openclaw-media/report.pdf"),
    });
    const details = requireDetails(result);
    expect(details).toMatchObject({
      ok: true,
      fileId: "F123",
      path: "/tmp/openclaw-media/report.pdf",
      contentType: "application/pdf",
    });
    expect(details.media).toEqual({
      mediaUrl: "/tmp/openclaw-media/report.pdf",
      outbound: false,
      contentType: "application/pdf",
    });
  });

  it("rejects invalid blocks JSON", async () => {
    await expect(
      handleSlackAction({ ...send, content: "", blocks: "{not json" }, cfg),
    ).rejects.toThrow(/blocks must be valid JSON/i);

  it("stages downloaded files into the trusted agent workspace", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-slack-download-"));
    try {
      const sourcePath = path.join(tempDir, "source.pdf");
      const workspaceDir = path.join(tempDir, "workspace");
      await fs.mkdir(workspaceDir);
      await fs.writeFile(sourcePath, "invoice evidence");
      downloadSlackFile.mockResolvedValueOnce({
        path: sourcePath,
        contentType: "application/pdf",
        placeholder: "[Slack file: source.pdf (fileId: F123)]",
      });

      const result = await handleSlackAction(
        {
          action: "downloadFile",
          fileId: "F123",
          channelId: "C1",
        },
        slackConfig(),
        { mediaWorkspaceDir: workspaceDir },
      );

      const stagedPath = "media/inbound/source.pdf";
      await expect(fs.readFile(path.join(workspaceDir, stagedPath), "utf8")).resolves.toBe(
        "invoice evidence",
      );
      expect(requireDetails(result).path).toBe(path.join(workspaceDir, stagedPath));
      expect(requireDetails(result).media).toMatchObject({
        mediaUrl: "media/inbound/source.pdf",
        outbound: false,
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns the staged original instead of a preview when original=true", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-slack-original-"));
    try {
      const imagePath = path.join(tempDir, "plan.png");
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      );
      await fs.writeFile(imagePath, png);
      const downloaded = {
        path: imagePath,
        contentType: "image/png",
        placeholder: "[Slack file: plan.png]",
      };
      downloadSlackFile.mockResolvedValueOnce(downloaded).mockResolvedValueOnce(downloaded);

      const originalResult = await handleSlackAction(
        { action: "downloadFile", fileId: "F1", channelId: "C1", original: true },
        slackConfig(),
      );
      expect(originalResult.content.some((entry) => entry.type === "image")).toBe(false);
      expect(requireDetails(originalResult)).toMatchObject({
        ok: true,
        original: true,
        path: imagePath,
        size: png.length,
        contentType: "image/png",
      });

      const previewResult = await handleSlackAction(
        { action: "downloadFile", fileId: "F1", channelId: "C1" },
        slackConfig(),
      );
      const text = previewResult.content
        .flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
        .join("\n");
      expect(text).toContain(`Original file (${png.length} bytes) saved at ${imagePath}`);
      expect(text).toContain("original=true");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("downloads, hashes, and stages a bounded attachment batch", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-slack-batch-"));
    try {
      const firstPath = path.join(tempDir, "invoice.pdf");
      const secondPath = path.join(tempDir, "receipt.png");
      const workspaceDir = path.join(tempDir, "workspace");
      await fs.mkdir(workspaceDir);
      await fs.writeFile(firstPath, "invoice evidence");
      await fs.writeFile(secondPath, "receipt evidence");
      downloadSlackFile
        .mockResolvedValueOnce({
          path: firstPath,
          contentType: "application/pdf",
          placeholder: "invoice",
        })
        .mockResolvedValueOnce({
          path: secondPath,
          contentType: "image/png",
          placeholder: "receipt",
        });

      const result = await handleSlackAction(
        {
          action: "downloadFile",
          fileIds: ["F1", "F2"],
          channelId: "C1",
          threadId: "123.456",
        },
        slackConfig(),
        { mediaWorkspaceDir: workspaceDir },
      );

      const details = requireDetails(result);
      expect(details.ok).toBe(true);
      expect(details.channelId).toBe("C1");
      expect(details.threadId).toBe("123.456");
      const files = requireArray(details.files, "batch files").map((value) =>
        requireRecord(value, "batch file"),
      );
      expect(files).toMatchObject([
        {
          fileId: "F1",
          ok: true,
          path: path.join(workspaceDir, "media/inbound/F1-invoice.pdf"),
          contentType: "application/pdf",
          size: 16,
        },
        {
          fileId: "F2",
          ok: true,
          path: path.join(workspaceDir, "media/inbound/F2-receipt.png"),
          contentType: "image/png",
          size: 16,
        },
      ]);
      expect(String(files[0]?.sha256)).toMatch(/^[a-f0-9]{64}$/u);
      await expect(
        fs.readFile(path.join(workspaceDir, "media/inbound/F1-invoice.pdf"), "utf8"),
      ).resolves.toBe("invoice evidence");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reads a thread and stages all attached files in one action", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-slack-thread-batch-"));
    try {
      const sourcePath = path.join(tempDir, "invoice.pdf");
      const workspaceDir = path.join(tempDir, "workspace");
      await fs.mkdir(workspaceDir);
      await fs.writeFile(sourcePath, "thread invoice");
      readSlackMessages.mockResolvedValueOnce({
        messages: [
          { ts: "123.456", text: "root", user: "U1", files: [{ id: "F1", name: "invoice.pdf" }] },
          { ts: "123.789", text: "reply", user: "U2" },
        ],
        hasMore: false,
      });
      downloadSlackFile.mockResolvedValueOnce({
        path: sourcePath,
        contentType: "application/pdf",
        placeholder: "invoice",
      });

      const result = await handleSlackAction(
        {
          action: "downloadFile",
          allThreadFiles: true,
          channelId: "C1",
          threadId: "123.456",
        },
        slackConfig(),
        { mediaWorkspaceDir: workspaceDir },
      );

      expect(readSlackMessages).toHaveBeenCalledWith(
        "C1",
        expect.objectContaining({
          limit: 100,
          threadId: "123.456",
        }),
      );
      const details = requireDetails(result);
      expect(requireArray(details.messages, "thread messages")).toHaveLength(2);
      expect(requireArray(details.files, "thread files")).toMatchObject([
        { fileId: "F1", ok: true, path: path.join(workspaceDir, "media/inbound/F1-invoice.pdf") },
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("forwards resolved botToken to action functions instead of relying on config re-read", async () => {
    downloadSlackFile.mockResolvedValueOnce(null);
    await handleSlackAction(
      { action: "downloadFile", fileId: "F123", channelId: "C1" },
      slackConfig(),
    );
    expect(requireRecordArg(downloadSlackFile, "downloadSlackFile", 0, 1).token).toBe("tok");
  });

  it("keeps resolved userToken for downloadFile reads when configured", async () => {
    downloadSlackFile.mockResolvedValueOnce(null);
    await handleSlackAction(
      { action: "downloadFile", fileId: "F123", channelId: "C1" },
      slackConfig({
        accounts: {
          default: {
            botToken: "xoxb-bot",
            userToken: "xoxp-user",
          },
        },
      }),
    );
    expect(requireRecordArg(downloadSlackFile, "downloadSlackFile", 0, 1).token).toBe("xoxp-user");
  });

  it("requires a send payload", async () => {
    await expect(handleSlackAction({ ...send, content: "" }, cfg)).rejects.toThrow(
      /requires content, blocks, or mediaUrl/i,
    );
  });

  it("requires edit content or blocks", async () => {
    await expect(
      handleSlackAction({ action: "editMessage", ...message, content: "" }, cfg),
    ).rejects.toThrow(/requires content or blocks/i);
  });

  it("uploads metadata and original media through the trusted workspace using a writable user token", async () => {
    cfg = {
      channels: {
        slack: {
          accounts: { default: { userToken: "xoxp-user", userTokenReadOnly: false } },
        },
      },
    };
    await handleSlackAction(
      {
        ...upload,
        initialComment: "fresh report",
        filename: "report-final.png",
        title: "Report Final",
        threadTs: "111.222",
        forceDocument: true,
      },
      cfg,
      trustedContext,
    );
    expectSlackSendCall(0, "team:T123:channel:C123", "fresh report", {
      cfg,
      token: "xoxp-user",
      mediaUrl: "/tmp/report.png",
      threadTs: "111.222",
      uploadFileName: "report-final.png",
      uploadTitle: "Report Final",
      forceDocument: true,
    });
  });

  it("rejects replyBroadcast for uploadFile", async () => {
    await expect(
      handleSlackAction({ ...upload, threadTs: "111.222", replyBroadcast: true }, slackConfig()),
    ).rejects.toThrow(/replyBroadcast is only supported for text or block thread replies/i);
  });

  it.each([false, true])("sends media before separate blocks (prepared=%s)", async (prepared) => {
    sendSlackMessage.mockResolvedValueOnce({ channelId: "C123", messageId: "F123" });
    sendSlackMessage.mockResolvedValueOnce({ channelId: "C123", messageId: "123.456" });

    const result = await handleSlackAction(
      {
        ...send,
        content: "",
        mediaUrl: "https://example.com/file.png",
        blocks: JSON.stringify([{ type: "divider" }]),
      },
      cfg,
      prepared ? { preparedMessages: [{ text: "", blocks: [{ type: "divider" }] }] } : undefined,
    );

    expect(sendSlackMessage).toHaveBeenCalledTimes(2);
    expectSlackSendCall(0, "channel:C123", "", {
      cfg,
      mediaUrl: "https://example.com/file.png",
      threadTs: undefined,
    });
    expect(requireRecord(sendSlackMessage.mock.calls[0]?.[2], "send options")).not.toHaveProperty(
      "blocks",
    );
    expectSlackSendCall(1, "channel:C123", "", {
      cfg,
      blocks: [{ type: "divider" }],
      threadTs: undefined,
    });
    expect(requireRecord(sendSlackMessage.mock.calls[1]?.[2], "send options")).not.toHaveProperty(
      "mediaUrl",
    );
    expect(result.details).toMatchObject({
      ok: true,
      result: {
        ...message,
        receipt: { platformMessageIds: ["F123", "123.456"] },
      },
    });
  });

  it("keeps oversized text and native blocks in the same resolved thread", async () => {
    cfg = slackConfig({ replyToMode: "first" });
    const hasRepliedRef = { value: false };
    const context = createReplyToFirstContext(hasRepliedRef);
    const content = "x".repeat(8001);
    const blocks = [{ type: "divider" }];
    sendSlackMessage.mockResolvedValueOnce({ channelId: "C123", messageId: "123.456" });
    sendSlackMessage.mockResolvedValueOnce({ channelId: "C123", messageId: "123.457" });

    const result = await handleSlackAction(
      { ...send, content, blocks, replyBroadcast: true },
      cfg,
      context,
    );

    expect(sendSlackMessage).toHaveBeenCalledTimes(2);
    expectSlackSendCall(0, "channel:C123", "", {
      cfg,
      blocks,
      threadTs: "1111111111.111111",
    });
    expect(requireRecord(sendSlackMessage.mock.calls[0]?.[2], "send options")).not.toHaveProperty(
      "replyBroadcast",
    );
    const textOptions = expectSlackSendCall(1, "channel:C123", content, {
      cfg,
      replyBroadcast: true,
      threadTs: "1111111111.111111",
    });
    expect(textOptions).not.toHaveProperty("blocks");
    expect(hasRepliedRef.value).toBe(true);
    expect(result.details).toMatchObject({
      ok: true,
      result: {
        channelId: "C123",
        messageId: "123.457",
        receipt: { platformMessageIds: ["123.456", "123.457"] },
      },
    });
  });

  it("keeps overlong native-data accessibility and blocks in one send", async () => {
    const content = `Pipeline summary\n\n${"x".repeat(8001)}`;
    const blocks = [
      {
        type: "data_table",
        caption: "Pipeline",
        rows: [[{ type: "raw_text", text: "Account" }], [{ type: "raw_text", text: "Acme" }]],
      },
    ];

    await handleSlackAction(
      {
        ...send,
        content,
        blocks,
        nativeDataFallbackBaseText: "Pipeline summary",
      },
      cfg,
    );

    expect(sendSlackMessage).toHaveBeenCalledOnce();
    expectSlackSendCall(0, "channel:C123", content, {
      cfg,
      blocks,
      nativeDataFallbackBaseText: "Pipeline summary",
      threadTs: undefined,
    });
  });

  it("delivers a prepared presentation plan in order on one resolved thread", async () => {
    const chartBlocks = [
      { type: "data_visualization", title: "Revenue", chart: {} },
      { type: "actions", elements: [{ type: "button", action_id: "question-choice" }] },
    ];
    const hasRepliedRef = { value: false };
    for (const [index, ids] of [["123.456"], ["123.457", "123.458"]].entries()) {
      sendSlackMessage.mockResolvedValueOnce({
        channelId: "C123",
        messageId: ids.at(-1),
        ...(index === 0 ? { meta: { slackQuestionActionIds: ["question-choice"] } } : {}),
        receipt: {
          platformMessageIds: ids,
          primaryPlatformMessageId: ids[0],
          parts: ids.map((platformMessageId, partIndex) => ({
            platformMessageId,
            kind: index === 1 ? "text" : "card",
            index: partIndex,
            threadId: "1111111111.111111",
          })),
          threadId: "1111111111.111111",
          sentAt: 123,
        },
      });
    }

    const result = await handleSlackAction(
      { ...send, content: "", blocks: chartBlocks, replyBroadcast: true },
      cfg,
      {
        ...createReplyToFirstContext(hasRepliedRef),
        preparedMessages: [
          { text: "Revenue", blocks: chartBlocks, authoredTextPlacement: "blocks" },
          { text: "Wide table fallback", textIsSlackPlainText: true },
        ],
      },
    );

    expect(sendSlackMessage).toHaveBeenCalledTimes(2);
    expectSlackSendCall(0, "channel:C123", "Revenue", {
      cfg,
      blocks: chartBlocks,
      authoredTextPlacement: "blocks",
      replyBroadcast: true,
      threadTs: "1111111111.111111",
    });
    expectSlackSendCall(1, "channel:C123", "Wide table fallback", {
      cfg,
      textIsSlackPlainText: true,
      threadTs: "1111111111.111111",
    });
    expect(hasRepliedRef.value).toBe(true);
    expect(result.details).toMatchObject({
      ok: true,
      result: {
        channelId: "C123",
        messageId: "123.458",
        meta: {
          slackQuestionActionIds: ["question-choice"],
          slackQuestionMessageId: "123.456",
        },
        receipt: {
          primaryPlatformMessageId: "123.456",
          platformMessageIds: ["123.456", "123.457", "123.458"],
          parts: [
            { platformMessageId: "123.456", kind: "card", index: 0 },
            { platformMessageId: "123.457", kind: "text", index: 1 },
            { platformMessageId: "123.458", kind: "text", index: 2 },
          ],
          threadId: "1111111111.111111",
          sentAt: 123,
        },
      },
    });
  });

  it("edits blocks without requiring text", async () => {
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "updated" } }];
    await handleSlackAction({ action: "editMessage", ...message, blocks }, cfg);
    expect(editSlackMessage).toHaveBeenCalledWith("C123", "123.456", "", { cfg, blocks });
  });

  it("keeps the batched reply thread available after a failed upload", async () => {
    cfg = slackConfig({ replyToMode: "batched" });
    const context = { ...createReplyToFirstContext(), replyToMode: "batched" as const };
    const params = {
      action: "uploadFile",
      to: "channel:C123",
      filePath: "/tmp/report.txt",
      initialComment: "First",
    };
    sendSlackMessage.mockRejectedValueOnce(new Error("Slack transport failed"));
    await expect(handleSlackAction(params, cfg, context)).rejects.toThrow("Slack transport failed");
    expect(context.hasRepliedRef.value).toBe(false);
    await handleSlackAction(params, cfg, context);
    for (const index of [0, 1]) {
      expectSlackSendCall(index, "channel:C123", "First", { cfg, threadTs: "1111111111.111111" });
    }
    expect(context.hasRepliedRef.value).toBe(true);
    await sendSecondMessageAndExpectNoThread({ cfg, context });
  });

  it("records an accepted batched Slack text chunk when the next platform post fails", async () => {
    const context = { ...createReplyToFirstContext(), replyToMode: "batched" as const };
    const client = new WebClient("xoxb-test", { retryConfig: { retries: 0 } });
    vi.spyOn(client.chat, "postMessage")
      .mockResolvedValueOnce({ ok: true, channel: "C123", ts: "1111111111.111112" })
      .mockRejectedValueOnce(new Error("Second Slack text chunk failed"));
    sendSlackMessage.mockImplementationOnce(async (...args) => {
      const [target, content, options] = args;
      if (typeof target !== "string" || typeof content !== "string") {
        throw new Error("Expected a Slack target and text");
      }
      return await sendSlackMessageThroughPublicOwner(target, content, {
        ...requireRecord(options, "Slack send options"),
        cfg,
        client,
      });
    });

    await expect(
      handleSlackAction({ ...send, content: "a".repeat(8500) }, cfg, context),
    ).rejects.toThrow("Second Slack text chunk failed");

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(context.hasRepliedRef.value).toBe(true);
  });

  it("keeps concurrent first replies threaded until a delivery succeeds", async () => {
    cfg = slackConfig({ replyToMode: "first" });
    const context = createReplyToFirstContext();
    const firstDelivery = createDeferred<{ channelId: string }>();
    const started = createDeferred<void>();
    sendSlackMessage.mockImplementationOnce(() => {
      started.resolve();
      return firstDelivery.promise;
    });
    const firstAttempt = handleSlackAction({ ...send, content: "Pending" }, cfg, context);
    await started.promise;
    expect(sendSlackMessage).toHaveBeenCalledOnce();
    await handleSlackAction({ ...send, content: "Accepted" }, cfg, context);
    expectSlackSendCall(1, "channel:C123", "Accepted", { cfg, threadTs: "1111111111.111111" });
    expect(context.hasRepliedRef.value).toBe(true);
    firstDelivery.reject(new Error("First Slack delivery failed"));
    await expect(firstAttempt).rejects.toThrow("First Slack delivery failed");
    expect(context.hasRepliedRef.value).toBe(true);
  });

  it("replyToMode=first threads standalone message-tool sends without ReplyToId", async () => {
    cfg = slackConfig({ replyToMode: "first" });
    const hasRepliedRef = { value: false };
    const context = buildSlackThreadingToolContext({
      cfg,
      accountId: null,
      hasRepliedRef,
      context: {
        ChatType: "channel",
        To: "channel:C123",
        CurrentMessageId: "1111111111.111111",
      },
    });

    await handleSlackAction({ ...send, content: "First" }, cfg, context);

    expectLastSlackSend("First", cfg, "1111111111.111111");
    await sendSecondMessageAndExpectNoThread({ cfg, context });
  });

  it("preserves a prepared channel override that disables auto-threading", async () => {
    const context = buildSlackThreadingToolContext({
      cfg: slackConfig({ replyToMode: "all", channels: { C123: { replyToMode: "off" } } }),
      context: {
        ChatType: "channel",
        To: "channel:C123",
        CurrentMessageId: "1111111111.111111",
        ReplyToId: "1111111111.111111",
        ReplyToMode: "off",
      },
    });
    await handleSlackAction({ ...send, content: "Channel root" }, cfg, context);
    expectLastSlackSend("Channel root", cfg);
  });

  it("consumes the first routable DM reply while retaining the native channel", async () => {
    const context = {
      ...createReplyToFirstContext(),
      currentChannelId: "D123",
      currentMessagingTarget: "slack:U123",
    };
    await handleSlackAction(
      { action: "sendMessage", to: "user:U123", content: "First" },
      cfg,
      context,
    );
    expectSlackSendCall(0, "user:U123", "First", { cfg, threadTs: "1111111111.111111" });
    expect(context.hasRepliedRef.value).toBe(true);
    await handleSlackAction(
      { action: "sendMessage", to: "user:U123", content: "Second" },
      cfg,
      context,
    );
    expectSlackSendCall(1, "user:U123", "Second", {
      cfg,
      mediaUrl: undefined,
      threadTs: undefined,
      blocks: undefined,
    });
  });

  it("replyToMode=first without hasRepliedRef does not thread", async () => {
    await handleSlackAction({ ...send, to: "#c123", content: "No ref" }, cfg, {
      currentChannelId: "C123",
      currentThreadTs: "1111111111.111111",
      replyToMode: "first",
    });
    expectSlackSendCall(0, "#c123", "No ref", {
      cfg,
      mediaUrl: undefined,
      threadTs: undefined,
      blocks: undefined,
    });
  });

  it("resolves name-allowlisted reads from a core-shaped Slack threading context", async () => {
    resolveSlackConversationName.mockResolvedValueOnce("allowed-channel");
    readSlackMessages.mockResolvedValueOnce({ messages: [], hasMore: false });

    cfg = namedPolicy({
      userToken: "xoxp-reader",
      channels: {
        "*": { enabled: false },
        "#allowed-channel": { enabled: true },
      },
    });
    const context = buildSlackThreadingToolContext({
      cfg,
      accountId: null,
      context: {
        ChatType: "channel",
        Channel: "slack",
        To: "channel:C0123456789",
      },
    });

    await handleSlackAction({ action: "readMessages", channelId: "C0123456789" }, cfg, context);

    expect(resolveSlackConversationName).toHaveBeenCalledWith("C0123456789", {
      cfg,
      token: "xoxp-reader",
    });
    expect(readSlackMessages.mock.calls[0]?.[0]).toBe("C0123456789");
  });

  it("does not treat the core Channel provider value as a Slack room name", async () => {
    resolveSlackConversationName.mockResolvedValueOnce("actual-room");

    cfg = namedPolicy({ channels: { "#slack": { enabled: true } } });
    const context = buildSlackThreadingToolContext({
      cfg,
      accountId: null,
      context: {
        ChatType: "channel",
        Channel: "slack",
        To: "channel:C0123456789",
      },
    });

    await expect(
      handleSlackAction({ action: "readMessages", channelId: "C0123456789" }, cfg, context),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(resolveSlackConversationName).toHaveBeenCalledWith("C0123456789", { cfg });
    expect(readSlackMessages).not.toHaveBeenCalled();
  });

  it("does not authorize different Slack targets with the current context channel ID", async () => {
    resolveSlackConversationName.mockResolvedValueOnce("other-channel");

    cfg = namedPolicy();

    await expect(
      handleSlackAction({ action: "readMessages", channelId: "C9876543210" }, cfg, {
        currentChannelId: "C0123456789",
      }),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(resolveSlackConversationName).toHaveBeenCalledWith("C9876543210", { cfg });
    expect(readSlackMessages).not.toHaveBeenCalled();
  });

  it("does not let a name match override an explicit channel-id denial", async () => {
    cfg = namedPolicy({
      groupPolicy: "open",
      channels: {
        C0123456789: { enabled: false },
        "#allowed-channel": { enabled: true },
      },
    });

    await expect(
      handleSlackAction({ action: "readMessages", channelId: "C0123456789" }, cfg),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(resolveSlackConversationName).not.toHaveBeenCalled();
    expect(readSlackMessages).not.toHaveBeenCalled();
  });

  it("fails closed before reading when Slack cannot resolve the target name", async () => {
    resolveSlackConversationName.mockRejectedValueOnce(new Error("missing_scope"));
    cfg = namedPolicy();

    await expect(
      handleSlackAction({ action: "readMessages", channelId: "C0123456789" }, cfg),
    ).rejects.toThrow("missing_scope");
    expect(readSlackMessages).not.toHaveBeenCalled();
  });

  it("fails closed for read-like Slack actions when provider config is missing", async () => {
    cfg = {};

    await expect(
      handleSlackAction({ action: "readMessages", channelId: "C1" }, cfg),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(readSlackMessages).not.toHaveBeenCalled();

    await expect(
      handleSlackAction({ action: "reactions", channelId: "C1", messageId: "123.456" }, cfg),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(listSlackReactions).not.toHaveBeenCalled();

    await expect(
      handleSlackAction({ action: "downloadFile", fileId: "F123", channelId: "C1" }, cfg),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(downloadSlackFile).not.toHaveBeenCalled();

    await expect(handleSlackAction({ action: "listPins", channelId: "C1" }, cfg)).rejects.toThrow(
      "Slack read target channel is not allowed.",
    );
    expect(listSlackPins).not.toHaveBeenCalled();
  });

  it("does not fall back to a bot token when a user identity has no user token", async () => {
    await expect(
      handleSlackAction(
        { action: "sendMessage", to: "channel:C1", content: "Hello" },
        slackConfig({ postAs: "user", botToken: "test-bot-token" }),
      ),
    ).rejects.toThrow('Slack operation token missing for account "default".');
    expect(sendSlackMessage).not.toHaveBeenCalled();
  });

  it("returns sorted usable emoji identifiers and preserves alias targets", async () => {
    listSlackEmojis.mockResolvedValueOnce({
      ok: true,
      cache_ts: "ignored-provider-metadata",
      emoji: {
        wave: "https://example.com/wave.png",
        celebrate: "alias:party",
        party: "https://example.com/party.png",
      },
    });

    const result = await handleSlackAction({ action: "emojiList", limit: 2 }, slackConfig());

    const details = requireDetails(result);
    expect(details.ok).toBe(true);
    expect(details.emojis).toEqual([
      { name: "celebrate", identifier: "celebrate", aliasOf: "party" },
      { name: "party", identifier: "party" },
    ]);
  });

  it("caps emoji-list output at 100", async () => {
    listSlackEmojis.mockResolvedValueOnce({
      ok: true,
      emoji: Object.fromEntries(
        Array.from({ length: 101 }, (_, index) => [
          `emoji${String(index).padStart(3, "0")}`,
          "https://example.com/emoji.png",
        ]),
      ),
    });
    const result = await handleSlackAction({ action: "emojiList", limit: 150 }, slackConfig());
    const emojis = requireDetails(result).emojis;
    if (!Array.isArray(emojis)) {
      throw new Error("Expected an emoji array");
    }
    expect(emojis).toHaveLength(100);
    expect(emojis.at(-1)).toEqual({ name: "emoji099", identifier: "emoji099" });
  });
});
