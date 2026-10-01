import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { FI_CHAT_POINTER_EVENT } from "./fi-chat-pointer.js";
import { createSlackProjectionReader } from "./projection-reader.js";

const URL =
  "https://app.cellect.ai/fi/shape/chat?fiConversation=8934026f-8d33-43a9-8bde-32bb4cfcbd3c";

describe("Slack Fi chat pointer post", () => {
  it("posts into the Slack thread once and skips when the notice is already there", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true });
    const replies = vi.fn().mockResolvedValue({
      ok: true,
      messages: [{ ts: "1700000000.000001", user: "U111", text: "Question" }],
    });
    const client = {
      auth: { test: vi.fn().mockResolvedValue({ ok: true, team_id: "T123" }) },
      conversations: {
        members: vi.fn().mockResolvedValue({ ok: true, members: ["U111"] }),
        replies,
        history: vi.fn().mockResolvedValue({ ok: true, messages: [] }),
      },
      chat: { postMessage },
    };
    const reader = createSlackProjectionReader({
      client: client as unknown as WebClient,
      workspaceId: "T123",
      botUserId: "UBOT",
      socketConnectedAt: () => undefined,
    });
    await expect(
      reader.postChatPointer({
        channelId: "C123ABCDE12",
        rootMessageId: "1700000000.000001",
        chatUrl: URL,
      }),
    ).resolves.toBe("posted");
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123ABCDE12",
        thread_ts: "1700000000.000001",
        unfurl_links: false,
        metadata: { event_type: FI_CHAT_POINTER_EVENT, event_payload: { v: 1 } },
      }),
    );
    replies.mockResolvedValue({
      ok: true,
      messages: [
        { ts: "1700000000.000001", user: "U111", text: "Question" },
        {
          ts: "1700000000.000002",
          user: "UBOT",
          bot_id: "BBOT",
          text: `This conversation continues in Fi: <${URL}|Open in Fi>`,
          metadata: { event_type: FI_CHAT_POINTER_EVENT },
        },
      ],
    });
    postMessage.mockClear();
    await expect(
      reader.postChatPointer({
        channelId: "C123ABCDE12",
        rootMessageId: "1700000000.000001",
        chatUrl: URL,
      }),
    ).resolves.toBe("existing");
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("posts into a Slack DM once and skips when the notice is already there", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true });
    const history = vi.fn().mockResolvedValue({
      ok: true,
      messages: [{ ts: "1700000000.000001", user: "U111", text: "Question" }],
    });
    const client = {
      auth: { test: vi.fn().mockResolvedValue({ ok: true, team_id: "T123" }) },
      conversations: {
        members: vi.fn(),
        replies: vi.fn(),
        history,
      },
      chat: { postMessage },
    };
    const reader = createSlackProjectionReader({
      client: client as unknown as WebClient,
      workspaceId: "T123",
      botUserId: "UBOT",
      socketConnectedAt: () => undefined,
    });
    await expect(
      reader.postChatPointer({
        channelId: "D123ABCDE12",
        chatUrl: URL,
      }),
    ).resolves.toBe("posted");
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "D123ABCDE12",
        unfurl_links: false,
        metadata: { event_type: FI_CHAT_POINTER_EVENT, event_payload: { v: 1 } },
      }),
    );
    expect(postMessage.mock.calls[0][0].thread_ts).toBeUndefined();
    history.mockResolvedValue({
      ok: true,
      messages: [
        { ts: "1700000000.000001", user: "U111", text: "Question" },
        {
          ts: "1700000000.000002",
          user: "UBOT",
          bot_id: "BBOT",
          text: `This conversation continues in Fi: <${URL}|Open in Fi>`,
          metadata: { event_type: FI_CHAT_POINTER_EVENT },
        },
      ],
    });
    postMessage.mockClear();
    await expect(
      reader.postChatPointer({
        channelId: "D123ABCDE12",
        chatUrl: URL,
      }),
    ).resolves.toBe("existing");
    expect(postMessage).not.toHaveBeenCalled();
  });
});
