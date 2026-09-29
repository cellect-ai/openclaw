import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { readSlackDirectSnapshot } from "./direct-snapshot.js";
function client() {
  return {
    auth: { test: vi.fn().mockResolvedValue({ ok: true, team_id: "T123" }) },
    conversations: {
      info: vi.fn().mockResolvedValue({ ok: true, channel: { is_im: true, user: "U111" } }),
      history: vi.fn().mockResolvedValue({
        ok: true,
        messages: [{ ts: "1700000000.000001", user: "U111", text: "Question", reply_count: 1 }],
      }),
      replies: vi.fn().mockResolvedValue({
        ok: true,
        messages: [
          { ts: "1700000000.000001", user: "U111", text: "Question" },
          { ts: "1700000000.000002", user: "U222", bot_id: "B222", text: "Answer" },
        ],
      }),
    },
  };
}
describe("Slack direct source history", () => {
  it("verifies exact DM peer and merges reply history by native message identity", async () => {
    const slack = client();
    const result = await readSlackDirectSnapshot(
      slack as unknown as WebClient,
      "T123",
      "D123",
      "U111",
    );
    expect(result.directSource).toEqual({
      workspaceId: "T123",
      channelId: "D123",
      peerSenderId: "U111",
    });
    expect(result.messages.map((message) => message.messageId)).toEqual([
      "1700000000.000001",
      "1700000000.000002",
    ]);
    expect(result.messages[1]?.bot).toBe(true);
  });
  it("rejects a different peer before reading private history", async () => {
    const slack = client();
    await expect(
      readSlackDirectSnapshot(slack as unknown as WebClient, "T123", "D123", "U999"),
    ).rejects.toThrow("peer mismatch");
    expect(slack.conversations.history).not.toHaveBeenCalled();
  });
  it("refuses incomplete history instead of publishing a deletion snapshot", async () => {
    const slack = client();
    slack.conversations.history.mockResolvedValue({ ok: true, messages: [], has_more: true });
    await expect(
      readSlackDirectSnapshot(slack as unknown as WebClient, "T123", "D123", "U111"),
    ).rejects.toThrow("Incomplete Slack DM pagination");
  });
});
