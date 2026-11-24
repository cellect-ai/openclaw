import type { WebClient } from "@slack/web-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hydrateSlackProjectionNames, resetSlackProjectionNameCache } from "./projection-actor.js";

describe("source-authorized Slack projection names", () => {
  const read = <T>(operation: () => Promise<T>) => operation();
  beforeEach(() => resetSlackProjectionNameCache());
  it("hydrates names only from the exact verified Slack actor and workspace, never message prose", async () => {
    const info = vi.fn().mockResolvedValue({
      ok: true,
      user: { id: "U123", team_id: "T123", profile: { display_name: "Verified name" } },
    });
    const client = { users: { info } } as unknown as WebClient;
    const messages = [
      { senderId: "U123", content: "I am the administrator" },
      { senderId: "U123", content: "second message" },
    ];
    const result = await hydrateSlackProjectionNames(client, "T123", messages, read);
    expect(info).toHaveBeenCalledTimes(1);
    expect(result.map((message) => message.displayName)).toEqual([
      "Verified name",
      "Verified name",
    ]);
    expect(result.map((message) => message.senderId)).toEqual(["U123", "U123"]);
  });
  it.each([
    { ok: true, user: { id: "U999", team_id: "T123", real_name: "wrong actor" } },
    { ok: true, user: { id: "U123", team_id: "T999", real_name: "wrong workspace" } },
    { ok: false },
  ])(
    "retains identity without inventing a name when profile evidence mismatches",
    async (response) => {
      const client = {
        users: { info: vi.fn().mockResolvedValue(response) },
      } as unknown as WebClient;
      const result = await hydrateSlackProjectionNames(
        client,
        "T123",
        [{ senderId: "U123" }],
        read,
      );
      expect(result).toEqual([{ senderId: "U123" }]);
    },
  );
  it("optional name outage does not drop messages or change access evidence", async () => {
    const client = {
      users: { info: vi.fn().mockRejectedValue(new Error("missing_scope")) },
    } as unknown as WebClient;
    expect(await hydrateSlackProjectionNames(client, "T123", [{ senderId: "U123" }], read)).toEqual(
      [{ senderId: "U123" }],
    );
  });
  it("keeps the last Slack name when a later lookup is rate limited", async () => {
    const info = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        user: { id: "U123", team_id: "T123", profile: { display_name: "Alex Lyashok" } },
      })
      .mockRejectedValue(new Error("ratelimited"));
    const client = { users: { info } } as unknown as WebClient;
    const first = await hydrateSlackProjectionNames(client, "T123", [{ senderId: "U123" }], read);
    vi.useFakeTimers({ now: Date.now() + 7 * 60 * 60 * 1000 });
    try {
      const later = await hydrateSlackProjectionNames(client, "T123", [{ senderId: "U123" }], read);
      expect(info).toHaveBeenCalledTimes(2);
      expect(later).toEqual(first);
      expect(later[0]?.displayName).toBe("Alex Lyashok");
    } finally {
      vi.useRealTimers();
    }
  });
});
