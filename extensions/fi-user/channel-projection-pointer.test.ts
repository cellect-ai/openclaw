import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectSlackChannelThread } from "./channel-projection.js";

describe("Slack-origin Fi chat pointer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts one Fi chat pointer into a Slack-origin thread and does not post again when it is already there", async () => {
    const chatUrl =
      "https://app.cellect.ai/fi/shape/chat?fiConversation=8934026f-8d33-43a9-8bde-32bb4cfcbd3c";
    const postChatPointer = vi.fn().mockResolvedValue("posted");
    const readThread = vi.fn().mockResolvedValue({
      workspaceId: "T123",
      channelId: "C123",
      rootMessageId: "1700000000.000001",
      memberSenderIds: ["U111"],
      sourcePointerPresent: false,
      messages: [{ messageId: "1700000000.000001", senderId: "U111", content: "hi", bot: false }],
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "created", chatUrl }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = {
      logger: { warn: vi.fn(), info: vi.fn() },
      runtime: {
        channel: {
          runtimeContexts: { get: () => ({ readThread, postChatPointer, botUserId: "U222" }) },
        },
      },
    } as unknown as OpenClawPluginApi;
    await projectSlackChannelThread({
      api,
      sessionKey: "agent:cellect-fi-user:slack:channel:c123:thread:1700000000.000001",
      accountId: "fi-user",
      requesterSenderId: "U111",
      baseUrl: "https://fi.example",
      token: "test-token",
    });
    expect(postChatPointer).toHaveBeenCalledWith({
      channelId: "C123",
      rootMessageId: "1700000000.000001",
      chatUrl,
      alreadyPresent: false,
    });
    postChatPointer.mockClear();
    readThread.mockResolvedValue({
      workspaceId: "T123",
      channelId: "C123",
      rootMessageId: "1700000000.000001",
      memberSenderIds: ["U111"],
      sourcePointerPresent: true,
      messages: [{ messageId: "1700000000.000001", senderId: "U111", content: "hi", bot: false }],
    });
    await projectSlackChannelThread({
      api,
      sessionKey: "agent:cellect-fi-user:slack:channel:c123:thread:1700000000.000001",
      accountId: "fi-user",
      requesterSenderId: "U111",
      baseUrl: "https://fi.example",
      token: "test-token",
    });
    expect(postChatPointer).toHaveBeenCalledWith(expect.objectContaining({ alreadyPresent: true }));
  });
});
