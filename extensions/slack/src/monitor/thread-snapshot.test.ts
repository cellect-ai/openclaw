import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { readSlackThreadSnapshot, readSlackProjectionChannel } from "./thread-snapshot.js";

describe("Slack projection source snapshot", () => {
  function client() {
    return {
      auth: { test: vi.fn().mockResolvedValue({ ok: true, team_id: "T123" }) },
      conversations: {
        history: vi.fn().mockResolvedValue({ ok: true, messages: [] }),
        members: vi
          .fn()
          .mockResolvedValueOnce({
            ok: true,
            members: ["U111"],
            response_metadata: { next_cursor: "more" },
          })
          .mockResolvedValueOnce({
            ok: true,
            members: ["U222"],
            response_metadata: { next_cursor: "" },
          }),
        replies: vi.fn().mockResolvedValue({
          ok: true,
          messages: [
            { ts: "1700000000.000001", user: "U111", text: "Question" },
            { ts: "1700000000.000002", user: "U333", text: "Answer", bot_id: "B333" },
          ],
        }),
      },
    };
  }
  it("collects all members and preserves string message identities and bot attribution", async () => {
    const slack = client();
    const result = await readSlackThreadSnapshot(
      slack as unknown as WebClient,
      "T123",
      "C123",
      "1700000000.000001",
    );
    expect(result.memberSenderIds).toEqual(["U111", "U222"]);
    expect(result.messages[1]).toEqual({
      messageId: "1700000000.000002",
      senderId: "U333",
      content: "Answer",
      bot: true,
    });
    expect(slack.conversations.members).toHaveBeenLastCalledWith({
      channel: "C123",
      limit: 200,
      cursor: "more",
    });
  });
  it("shares one verified roster across thread reads in a bounded channel scope", async () => {
    const slack = client();
    const scope = await readSlackProjectionChannel(slack as unknown as WebClient, "T123", "C123");
    await scope.readThread("1700000000.000001");
    await scope.readThread("1700000000.000002");
    expect(slack.auth.test).toHaveBeenCalledTimes(1);
    expect(slack.conversations.members).toHaveBeenCalledTimes(2);
    expect(slack.conversations.replies).toHaveBeenCalledTimes(2);
  });
  it("discovers only conversations this bot is part of, not its unanswered posts", async () => {
    const slack = client();
    slack.auth.test.mockResolvedValue({
      ok: true,
      team_id: "T123",
      user_id: "UBOT",
      bot_id: "BBOT",
    });
    slack.conversations.history.mockResolvedValueOnce({
      ok: true,
      messages: [
        { ts: "1.000001", user: "U111", reply_count: 2, reply_users: ["U222"] },
        { ts: "1.000002", bot_id: "BOTHER", text: "another app's post" },
        { ts: "1.000003", user: "U111", text: "hi <@U222>" },
        { ts: "1.000004", user: "U111", text: "not a bot conversation" },
        { ts: "1.000005", user: "U111", text: "<@UBOT> can you check this?" },
        {
          ts: "1.000006",
          user: "UBOT",
          bot_id: "BBOT",
          text: "Report ready",
          reply_count: 2,
          reply_users: ["U111"],
        },
        { ts: "1.000007", user: "U111", reply_count: 3, reply_users: ["U222", "UBOT"] },
        { ts: "1.000008", user: "UBOT", bot_id: "BBOT", text: "KYC approved (notification)" },
      ],
      response_metadata: { next_cursor: "older" },
    });
    const scope = await readSlackProjectionChannel(slack as unknown as WebClient, "T123", "C123");
    expect(await scope.readHistoryPage()).toEqual({
      roots: ["1.000005", "1.000006", "1.000007"],
      nextCursor: "older",
    });
    slack.conversations.history.mockResolvedValueOnce({ ok: true, messages: [], has_more: true });
    await expect(scope.readHistoryPage("older")).rejects.toThrow("Incomplete");
  });
  it("counts every Claw bot in the workspace, not only the reading one", async () => {
    const slack = client();
    slack.auth.test.mockResolvedValue({
      ok: true,
      team_id: "T123",
      user_id: "UBOT",
      bot_id: "BBOT",
    });
    slack.conversations.history.mockResolvedValueOnce({
      ok: true,
      messages: [
        { ts: "2.000001", user: "U111", text: "<@UADMIN> please file this" },
        { ts: "2.000002", user: "U111", text: "<@UADMIN|fi-admin> named mention" },
        { ts: "2.000003", user: "U111", reply_count: 2, reply_users: ["UADMIN"] },
        { ts: "2.000004", user: "UADMIN", bot_id: "BADMIN", text: "Done", reply_count: 1 },
        { ts: "2.000005", user: "U111", thread_ts: "2.000001", text: "<@UBOT> broadcast reply" },
        { ts: "2.000006", user: "U111", text: "<@UOTHER> not a Claw bot" },
      ],
    });
    const scope = await readSlackProjectionChannel(slack as unknown as WebClient, "T123", "C123", [
      "UADMIN",
    ]);
    expect((await scope.readHistoryPage()).roots).toEqual([
      "2.000001",
      "2.000002",
      "2.000003",
      "2.000004",
    ]);
  });
  it("rejects a mismatched workspace before reading private channel data", async () => {
    const slack = client();
    slack.auth.test.mockResolvedValue({ ok: true, team_id: "T999" });
    await expect(
      readSlackThreadSnapshot(slack as unknown as WebClient, "T123", "C123", "1700000000.000001"),
    ).rejects.toThrow("workspace mismatch");
    expect(slack.conversations.members).not.toHaveBeenCalled();
  });
  it("never returns a partial membership snapshot when pagination fails", async () => {
    const slack = client();
    slack.conversations.members
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        members: ["U111"],
        response_metadata: { next_cursor: "more" },
      })
      .mockRejectedValueOnce(new Error("rate_limited"));
    await expect(
      readSlackThreadSnapshot(slack as unknown as WebClient, "T123", "C123", "1700000000.000001"),
    ).rejects.toThrow("rate_limited");
    expect(slack.conversations.replies).not.toHaveBeenCalled();
  });
});
