import type { WebClient, ChatPostMessageArguments, ChatUpdateArguments } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { FI_CHAT_POINTER_EVENT, fiChatPointerText } from "./fi-chat-pointer.js";
import { createSlackProjectionReader } from "./projection-reader.js";

const URL =
  "https://app.cellect.ai/fi/shape/chat?fiConversation=8934026f-8d33-43a9-8bde-32bb4cfcbd3c";
const input = {
  channelId: "C123",
  rootMessageId: "1700000000.000001",
  chatUrl: URL,
  nativeEventId: "$native1",
  nativeEventTs: 200,
  isCurrent: async () => true,
};
function setup() {
  const messages: Record<string, unknown>[] = [
    { ts: input.rootMessageId, user: "U111", text: "Question" },
  ];
  const replies = vi.fn(async () => ({ ok: true, messages }));
  const history = vi.fn(async () => ({ ok: true, messages }));
  const postMessage = vi.fn(async (args: ChatPostMessageArguments) => {
    messages.push({ ...args, user: "UBOT", bot_id: "BBOT", ts: "1700000000.000002" });
    return { ok: true, ts: "1700000000.000002" };
  });
  const update = vi.fn(async (args: ChatUpdateArguments) => {
    const existing = messages.find((message) => message.ts === args.ts);
    Object.assign(existing!, args);
    return { ok: true };
  });
  const client = {
    auth: { test: vi.fn().mockResolvedValue({ ok: true, team_id: "T123", user_id: "UBOT" }) },
    conversations: {
      members: vi.fn().mockResolvedValue({ ok: true, members: ["U111"] }),
      replies,
      history,
    },
    chat: { postMessage, update },
  };
  const create = () =>
    createSlackProjectionReader({
      client: client as unknown as WebClient,
      workspaceId: "T123",
      botUserId: "UBOT",
      socketConnectedAt: () => undefined,
    });
  return { client, create, postMessage, update, replies, history, messages };
}
describe("Slack Fi-only activity pointer", () => {
  it("creates once, survives reader restart and ignores newer Slack replies", async () => {
    const s = setup();
    expect(await s.create().postChatPointer(input)).toBe("posted");
    s.messages.push({ ts: "1700000000.000003", user: "U111", text: "Slack follow-up" });
    expect(await s.create().postChatPointer(input)).toBe("existing");
    expect(s.postMessage).toHaveBeenCalledTimes(1);
    expect(s.update).not.toHaveBeenCalled();
    expect(s.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: fiChatPointerText(URL),
        reply_broadcast: false,
        metadata: {
          event_type: FI_CHAT_POINTER_EVENT,
          event_payload: expect.objectContaining({ v: 2, nativeEventId: "$native1" }),
        },
      }),
    );
  });
  it("updates the same notice for later native activity and never regresses", async () => {
    const s = setup();
    const reader = s.create();
    await reader.postChatPointer(input);
    expect(
      await reader.postChatPointer({ ...input, nativeEventId: "$native2", nativeEventTs: 300 }),
    ).toBe("updated");
    expect(await reader.postChatPointer(input)).toBe("existing");
    expect(s.postMessage).toHaveBeenCalledTimes(1);
    expect(s.update).toHaveBeenCalledTimes(1);
    expect(s.update).toHaveBeenCalledWith(expect.objectContaining({ ts: "1700000000.000002" }));
  });
  it("adopts the oldest own legacy notice without adding to existing duplicates", async () => {
    const s = setup();
    for (const ts of ["1700000000.000002", "1700000000.000003"]) {
      s.messages.push({
        ts,
        user: "UBOT",
        bot_id: "BBOT",
        text: `This conversation continues in Fi: <${URL}|Open in Fi>`,
      });
    }
    expect(await s.create().postChatPointer(input)).toBe("updated");
    expect(s.postMessage).not.toHaveBeenCalled();
    expect(s.update).toHaveBeenCalledWith(expect.objectContaining({ ts: "1700000000.000002" }));
  });
  it("preserves a previous bot's canonical notice after source ownership changes", async () => {
    const s = setup();
    s.messages.push({
      ts: "1700000000.000002",
      user: "UOLD",
      bot_id: "BOLD",
      text: `This conversation continues in Fi: <${URL}|Open in Fi>`,
    });
    expect(await s.create().postChatPointer(input)).toBe("existing");
    expect(s.postMessage).not.toHaveBeenCalled();
    expect(s.update).not.toHaveBeenCalled();
  });
  it("prefers updating its own notice when legacy duplicates include another bot", async () => {
    const s = setup();
    await s.create().postChatPointer(input);
    s.messages.unshift({
      ts: "1700000000.000000",
      user: "UOLD",
      bot_id: "BOLD",
      text: fiChatPointerText(URL)!,
    });
    expect(
      await s.create().postChatPointer({ ...input, nativeEventId: "$newer", nativeEventTs: 300 }),
    ).toBe("updated");
    expect(s.postMessage).toHaveBeenCalledTimes(1);
    expect(s.update).toHaveBeenCalledWith(expect.objectContaining({ ts: "1700000000.000002" }));
  });
  it("does not let human metadata or a URL substring suppress the canonical notice", async () => {
    const s = setup();
    s.messages.push({
      ts: "1700000000.000002",
      user: "UHUMAN",
      text: fiChatPointerText(URL)!,
      metadata: { event_type: FI_CHAT_POINTER_EVENT },
    });
    s.messages.push({
      ts: "1700000000.000003",
      user: "UOTHER",
      bot_id: "BOTHER",
      text: `This conversation continues in Fi: <https://elsewhere.test/${URL}|Open in Fi>`,
    });
    expect(await s.create().postChatPointer(input)).toBe("posted");
    expect(s.update).not.toHaveBeenCalled();
  });
  it("does not suppress or edit a substantive bot reply containing the link", async () => {
    const s = setup();
    s.messages.push({
      ts: "1700000000.000002",
      user: "UBOT",
      bot_id: "BBOT",
      text: `Here is the answer. ${URL}`,
    });
    expect(await s.create().postChatPointer(input)).toBe("posted");
    expect(s.update).not.toHaveBeenCalled();
  });
  it("rechecks live authority after Slack reads", async () => {
    const s = setup();
    expect(await s.create().postChatPointer({ ...input, isCurrent: async () => false })).toBe(
      "skipped",
    );
    expect(s.postMessage).not.toHaveBeenCalled();
  });
  it("requires native evidence even if an old caller attempts a mirror-only post", async () => {
    const s = setup();
    // Runtime boundary rejects stale plugin callers as well as missing data.
    expect(
      await s.create().postChatPointer({ channelId: "C123", chatUrl: URL } as typeof input),
    ).toBe("skipped");
    expect(s.postMessage).not.toHaveBeenCalled();
  });
  it("serializes concurrent activity so there is one post", async () => {
    const s = setup();
    await Promise.all([
      s.create().postChatPointer(input),
      s.create().postChatPointer({ ...input, nativeEventId: "$native2", nativeEventTs: 300 }),
    ]);
    expect(s.postMessage).toHaveBeenCalledTimes(1);
    expect(s.update).toHaveBeenCalledTimes(1);
  });
  it("uses the same single-notice contract in direct messages", async () => {
    const s = setup();
    const direct = { ...input, channelId: "D123", rootMessageId: undefined };
    expect(await s.create().postChatPointer(direct)).toBe("posted");
    expect(await s.create().postChatPointer(direct)).toBe("existing");
    expect(s.postMessage.mock.calls[0]![0]).not.toHaveProperty("thread_ts");
  });
  it("supports a human source reader while the writer proves its bot identity", async () => {
    const s = setup();
    const writeClient = {
      auth: { test: vi.fn().mockResolvedValue({ ok: true, team_id: "T123", user_id: "UBOT" }) },
      chat: s.client.chat,
    };
    s.client.auth.test.mockResolvedValue({ ok: true, team_id: "T123", user_id: "UHUMAN" });
    const reader = createSlackProjectionReader({
      client: s.client as unknown as WebClient,
      writeClient: writeClient as unknown as WebClient,
      workspaceId: "T123",
      botUserId: "UBOT",
      socketConnectedAt: () => undefined,
    });
    expect(await reader.postChatPointer(input)).toBe("posted");
  });
  it("does not append another post if updating the existing notice fails", async () => {
    const s = setup();
    await s.create().postChatPointer(input);
    s.update.mockRejectedValueOnce(new Error("rate_limited"));
    await expect(
      s.create().postChatPointer({ ...input, nativeEventId: "$native2", nativeEventTs: 300 }),
    ).rejects.toThrow("rate_limited");
    expect(s.postMessage).toHaveBeenCalledTimes(1);
    expect(
      await s.create().postChatPointer({ ...input, nativeEventId: "$native2", nativeEventTs: 300 }),
    ).toBe("updated");
    expect(s.postMessage).toHaveBeenCalledTimes(1);
  });
  it("refuses mismatched workspace or bot identities", async () => {
    const s = setup();
    s.client.auth.test.mockResolvedValue({ ok: true, team_id: "TOTHER", user_id: "UBOT" });
    expect(await s.create().postChatPointer(input)).toBe("skipped");
    expect(s.postMessage).not.toHaveBeenCalled();
  });
  it("does not post from incomplete metadata history", async () => {
    const s = setup();
    s.history.mockResolvedValue({ ok: true, messages: [], has_more: true } as never);
    await expect(
      s.create().postChatPointer({ ...input, channelId: "D123", rootMessageId: undefined }),
    ).rejects.toThrow("incomplete");
    expect(s.postMessage).not.toHaveBeenCalled();
  });
});
