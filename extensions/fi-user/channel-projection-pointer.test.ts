import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectSlackChannelThread } from "./channel-projection-publisher.js";

describe("Slack-origin Fi chat pointer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never posts a pointer from Slack-only mirror creation or later source activity", async () => {
    const chatUrl =
      "https://app.cellect.ai/fi/shape/chat?fiConversation=8934026f-8d33-43a9-8bde-32bb4cfcbd3c";
    const postChatPointer = vi.fn().mockResolvedValue("posted");
    const readThread = vi.fn().mockResolvedValue({
      workspaceId: "T123",
      channelId: "C123",
      rootMessageId: "1700000000.000001",
      memberSenderIds: ["U111"],
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
          runtimeContexts: {
            get: ({ channelId }: { channelId: string }) =>
              channelId === "slack"
                ? { readThread, postChatPointer, botUserId: "U222" }
                : undefined,
          },
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
    expect(postChatPointer).not.toHaveBeenCalled();
    postChatPointer.mockClear();
    readThread.mockResolvedValue({
      workspaceId: "T123",
      channelId: "C123",
      rootMessageId: "1700000000.000001",
      memberSenderIds: ["U111"],
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
    expect(postChatPointer).not.toHaveBeenCalled();
    postChatPointer.mockClear();
    readThread.mockResolvedValue({
      workspaceId: "T123",
      channelId: "C123",
      rootMessageId: "1700000000.000001",
      memberSenderIds: ["U111"],
      messages: [
        { messageId: "1700000000.000001", senderId: "U111", content: "hi", bot: false },
        { messageId: "1700000000.000003", senderId: "U111", content: "📎 lease.pdf", bot: false },
      ],
    });
    await projectSlackChannelThread({
      api,
      sessionKey: "agent:cellect-fi-user:slack:channel:c123:thread:1700000000.000001",
      accountId: "fi-user",
      requesterSenderId: "U111",
      baseUrl: "https://fi.example",
      token: "test-token",
    });
    expect(postChatPointer).not.toHaveBeenCalled();
  });

  it.each(["skipped", "invalid", undefined])(
    "does not post a pointer for status %s",
    async (status) => {
      const postChatPointer = vi.fn();
      const readThread = vi.fn().mockResolvedValue({
        workspaceId: "T123",
        channelId: "C123",
        rootMessageId: "1700000000.000001",
        memberSenderIds: ["U111"],
        messages: [{ messageId: "1700000000.000001", senderId: "U111", content: "hi", bot: false }],
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            status,
            chatUrl: "https://app.cellect.ai/fi/shape/chat?fiConversation=conversation-123",
          }),
        }),
      );
      const api = {
        logger: { warn: vi.fn(), info: vi.fn() },
        runtime: {
          channel: {
            runtimeContexts: {
              get: ({ channelId }: { channelId: string }) =>
                channelId === "slack"
                  ? { readThread, postChatPointer, botUserId: "U222" }
                  : undefined,
            },
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
      expect(postChatPointer).not.toHaveBeenCalled();
    },
  );
});
