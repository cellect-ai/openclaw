import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe } from "vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SlackActionContext } from "./action-runtime.js";
import { handleSlackAction, slackActionRuntime } from "./action-runtime.js";
import { parseSlackBlocksInput } from "./blocks-input.js";
import type { registerSlackInstallationState } from "./installation-identity-state.js";
import type { SlackSendResult } from "./send.js";
import { buildSlackThreadingToolContext } from "./threading-tool-context.js";

function requireMockCall(
  source: { mock: { calls: unknown[][] } },
  label: string,
  index = 0,
): unknown[] {
  const call = source.mock.calls[index];
  if (!call) {
    throw new Error(`missing ${label} call ${index + 1}`);
  }
  return call;
}

const listSlackFileShareChannelIds = vi.fn(async (..._args: unknown[]): Promise<string[]> => []);

const isSlackConversationMember = vi.fn(async (..._args: unknown[]): Promise<boolean> => false);

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

function requireMockArg(
  source: { mock: { calls: unknown[][] } },
  label: string,
  callIndex: number,
  argIndex: number,
): unknown {
  return requireMockCall(source, label, callIndex)[argIndex];
}

function requireArray(value: unknown, label: string): unknown[] {
  expect(Array.isArray(value)).toBe(true);
  if (!Array.isArray(value)) {
    throw new Error(`${label} was not an array`);
  }
  return value;
}

function requireRecordArg(
  source: { mock: { calls: unknown[][] } },
  label: string,
  callIndex: number,
  argIndex: number,
): Record<string, unknown> {
  return requireRecord(
    requireMockArg(source, label, callIndex, argIndex),
    `${label} call ${callIndex + 1} argument ${argIndex + 1}`,
  );
}

const originalSlackActionRuntime = { ...slackActionRuntime };

const deleteSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));

const downloadSlackFile = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);

const editSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));

const getSlackMemberInfo = vi.fn(async (..._args: unknown[]) => ({}));

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
    const accountConfig = params.cfg.channels?.slack as
      | { userToken?: string; botToken?: string; channels?: Record<string, unknown> }
      | undefined;
    const token = accountConfig?.userToken ?? accountConfig?.botToken;
    const tokenOverride = token && token !== accountConfig?.botToken ? { token } : {};
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

let cfg: OpenClawConfig;

const threadTs = "1111111111.111111";

const send = { action: "sendMessage", to: "channel:C123" };

function act(params: Record<string, unknown>, context?: SlackActionContext) {
  return handleSlackAction(params, cfg, context);
}

function sendText(
  content: string,
  params: Record<string, unknown> = {},
  context?: SlackActionContext,
) {
  return act({ ...send, ...params, content }, context);
}

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

const installations: Array<ReturnType<typeof registerSlackInstallationState>> = [];

afterEach(() => {
  for (const installation of installations.splice(0)) {
    installation.release();
  }
});

const requireRecord = createRequireRecord("object", "label-not-object");

function expectSend(
  index: number,
  content: string,
  optionFields: Record<string, unknown>,
  target = "channel:C123",
) {
  const call = sendSlackMessage.mock.calls[index];
  expect(call).toEqual([target, content, expect.objectContaining({ cfg, ...optionFields })]);
  return requireRecord(call?.[2], "Slack send options");
}

function requireDetails(result: Awaited<ReturnType<typeof handleSlackAction>>) {
  return requireRecord(result.details, "action result details");
}

beforeEach(() => {
  cfg = slackConfig();
  vi.clearAllMocks();
  resolveSlackConversationName.mockReset().mockResolvedValue(undefined);
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

it.each([
  {
    name: "a prepared channel override disables auto-threading",
    to: "channel:C123",
    context: () =>
      buildSlackThreadingToolContext({
        cfg: slackConfig({ replyToMode: "all", channels: { C123: { replyToMode: "off" } } }),
        context: {
          ChatType: "channel",
          To: "channel:C123",
          CurrentMessageId: threadTs,
          ReplyToId: threadTs,
          ReplyToMode: "off",
        },
      }),
  },
  {
    name: "replyToMode=first has no hasRepliedRef",
    to: "#c123",
    context: (): SlackActionContext => ({
      currentChannelId: "C123",
      currentThreadTs: threadTs,
      replyToMode: "first",
    }),
  },
])("does not thread when $name", async ({ to, context }) => {
  await sendText("Channel root", { to }, context());
  expectSend(
    0,
    "Channel root",
    { mediaUrl: undefined, threadTs: undefined, blocks: undefined },
    to,
  );
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

  await act({ action: "readMessages", channelId: "C0123456789" }, context);

  expect(resolveSlackConversationName).toHaveBeenCalledWith("C0123456789", {
    cfg,
    token: "xoxp-reader",
  });
  expect(readSlackMessages.mock.calls[0]?.[0]).toBe("C0123456789");
});

it.each([
  {
    name: "the core Channel provider is not a room name",
    channelId: "C0123456789",
    overrides: { channels: { "#slack": { enabled: true } } },
    coreContext: true,
    lookup: "actual-room",
  },
  {
    name: "the current channel cannot authorize a different target",
    channelId: "C9876543210",
    context: { currentChannelId: "C0123456789" },
    lookup: "other-channel",
  },
  {
    name: "an explicit channel-id denial outranks a name match",
    channelId: "C0123456789",
    overrides: {
      groupPolicy: "open",
      channels: { C0123456789: { enabled: false }, "#allowed-channel": { enabled: true } },
    },
  },
  {
    name: "a failed name lookup cannot authorize a read",
    channelId: "C0123456789",
    lookup: new Error("missing_scope"),
  },
])("fails closed when $name", async ({ channelId, overrides, coreContext, context, lookup }) => {
  cfg = namedPolicy(overrides);
  if (lookup instanceof Error) {
    resolveSlackConversationName.mockRejectedValueOnce(lookup);
  } else if (lookup) {
    resolveSlackConversationName.mockResolvedValueOnce(lookup);
  }
  const readContext = coreContext
    ? buildSlackThreadingToolContext({
        cfg,
        accountId: null,
        context: { ChatType: "channel", Channel: "slack", To: "channel:C0123456789" },
      })
    : context;
  await expect(act({ action: "readMessages", channelId }, readContext)).rejects.toThrow(
    lookup instanceof Error ? "missing_scope" : "Slack read target channel is not allowed.",
  );
  if (lookup !== undefined) {
    expect(resolveSlackConversationName).toHaveBeenCalledWith(channelId, { cfg });
  } else {
    expect(resolveSlackConversationName).not.toHaveBeenCalled();
  }
  expect(readSlackMessages).not.toHaveBeenCalled();
});

it("fails closed for read-like Slack actions when provider config is missing", async () => {
  cfg = {};
  for (const [params, operation] of [
    [{ action: "readMessages" }, readSlackMessages],
    [{ action: "reactions", messageId: "123.456" }, listSlackReactions],
    [{ action: "downloadFile", fileId: "F123" }, downloadSlackFile],
    [{ action: "listPins" }, listSlackPins],
  ] as const) {
    await expect(act({ ...params, channelId: "C1" })).rejects.toThrow(
      "Slack read target channel is not allowed.",
    );
    expect(operation).not.toHaveBeenCalled();
  }
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

it("forwards resolved botToken to action functions instead of relying on config re-read", async () => {
  downloadSlackFile.mockResolvedValueOnce(null);
  await handleSlackAction(
    { action: "downloadFile", fileId: "F123", channelId: "C1" },
    slackConfig(),
  );
  expect(requireRecordArg(downloadSlackFile, "downloadSlackFile", 0, 1).token).toBe("tok");
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
      handleSlackAction({ action: "readMessages", channelId: "C_OTHER" }, allowlisted(), requester),
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
