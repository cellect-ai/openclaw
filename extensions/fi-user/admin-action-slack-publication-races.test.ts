import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSlackReviewers } from "./admin-action-slack.js";
import {
  ADMIN_A,
  ADMIN_B,
  REQUESTER,
  cfg,
  click,
  dm,
  harness,
  record,
  stored,
  toolContext,
} from "./admin-action-slack.test-support.js";
import {
  createRequestAdminActionTool,
  decideAdminApproval,
  type AdminActionRecord,
} from "./admin-action.js";
import { resolveFiUserPluginConfig } from "./fi-delegation.js";
beforeEach(() => {
  vi.stubEnv("SLACK_APPROVAL_TEST_BROKER", "test-broker");
});
describe("Slack publication races and refusals", () => {
  const wiring = {
    task: "company_wiring_share",
    companyId: "company-a",
    recipientEmail: "other@example.test",
  };

  it("stops sending and reports the real state when a reviewer decides during publication", async () => {
    const h = harness(null, { reviewers: [ADMIN_A, ADMIN_B, "UADM00003"] });
    const store = h.durable.namespaces.get("admin-actions")!;
    let sends = 0;
    h.sendPayload.mockImplementation(async (input: { to: string }) => {
      sends += 1;
      if (sends === 2) {
        const [saved] = [...store.values()] as AdminActionRecord[];
        store.set(saved!.id, {
          ...saved!,
          status: "denied",
          revision: 2,
          decidedBy: `slack:${ADMIN_A}`,
        });
      }
      return { messageId: `200.${sends}`, target: { kind: "channel", id: dm(input.to.slice(5)) } };
    });
    const tool = createRequestAdminActionTool(h.api, toolContext());
    const result = await tool.execute("r", wiring);
    expect(h.sendPayload).toHaveBeenCalledTimes(2);
    expect(result.details).toMatchObject({
      status: "declined",
      tellRequester: expect.stringContaining("decided this request while it was being sent"),
    });
    const edited = h.updates.find((update) => update.channel === dm(ADMIN_B));
    expect(edited?.ts).toBe("200.2");
    expect(JSON.stringify(edited?.blocks)).not.toContain('"actions"');
    expect(String(edited?.text)).toContain("Declined");
  });

  it("refreshes a stale click's card to its real state and words the refusal for Slack", async () => {
    const decided = harness(
      record({ status: "denied", revision: 2, decidedBy: `slack:${ADMIN_B}` }),
    );
    const stale = click(decided, ADMIN_A, "approve:ABC234:1");
    await stale.result;
    expect(stale.reply).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Check the updated card") }),
    );
    expect(JSON.stringify(stale.reply.mock.calls)).not.toContain("Refresh the conversation");
    const refreshed = stale.edit.mock.calls[0]![0] as { text: string; blocks: unknown[] };
    expect(refreshed.text).toContain("Declined");
    expect(JSON.stringify(refreshed.blocks)).not.toContain('"actions"');
    const expired = harness(record({ createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }));
    const late = click(expired, ADMIN_A, "approve:ABC234:1");
    await late.result;
    expect(String((late.edit.mock.calls[0]![0] as { text: string }).text)).toContain("Expired");
    expect(
      JSON.stringify((late.edit.mock.calls[0]![0] as { blocks: unknown[] }).blocks),
    ).not.toContain('"actions"');
  });

  it("refuses a live button whose copy could not be updated, then refreshes that card", async () => {
    const h = harness(record(), { failUpdates: [dm(ADMIN_B)] });
    await click(h, ADMIN_A, "decline:ABC234:1").result;
    expect(h.updates.some((update) => update.channel === dm(ADMIN_B))).toBe(true);
    const second = click(h, ADMIN_B, "approve:ABC234:1");
    await second.result;
    expect(second.reply).toHaveBeenCalled();
    expect((await stored(h)).status).toBe("denied");
    expect(String((second.edit.mock.calls[0]![0] as { text: string }).text)).toContain("Declined");
  });

  it("escapes requester-controlled text in the outcome posted to the requester", async () => {
    const h = harness(
      record({
        fields: { displayName: "<!channel> <https://x|y>", roomName: "Room" },
      }),
    );
    await click(h, ADMIN_A, "hold:ABC234:1").result;
    const [post] = h.sendText.mock.calls.map((call) => call[0] as unknown as { text: string });
    expect(post!.text).toContain(`<@${REQUESTER}>`);
    expect(post!.text).toContain("&lt;!channel&gt; &lt;https://x|y&gt;");
    expect(post!.text).not.toContain("<!channel>");
    expect(post!.text).not.toContain("<https://x|y>");
  });

  it("warns, without ids, when Fi's reviewer list reaches the cap", async () => {
    const reviewers = Array.from({ length: 25 }, (_, i) => `U${String(i).padStart(8, "0")}`);
    const h = harness(null, { reviewers });
    const warn = vi.fn();
    const config = resolveFiUserPluginConfig(cfg.plugins.entries["fi-user"].config);
    expect(await fetchSlackReviewers(config, warn)).toHaveLength(25);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/cap of 25/);
    expect(String(warn.mock.calls[0]![0])).not.toContain("U00000000");
    expect(h.api).toBeDefined();
  });

  it("points a typed legacy approval at the private card without public detail", async () => {
    const h = harness(
      record({
        sessionKey: toolContext().sessionKey,
        delivery: { channel: "slack", to: "C0CHANNEL1" },
      }),
    );
    const config = cfg.plugins.entries["fi-user"].config as Record<string, unknown>;
    config.adminApprovers = [ADMIN_A];
    try {
      await decideAdminApproval(
        h.api,
        {
          content: "approve ABC234",
          senderId: ADMIN_A,
          senderAuthentication: "verified",
          sessionKey: toolContext().sessionKey,
        },
        { channelId: "slack" },
      );
    } finally {
      delete config.adminApprovers;
    }
    const [note] = h.sendText.mock.calls.map((call) => call[0] as unknown as { text: string });
    expect(note!.text).toContain("private card sent to administrators in Slack");
    expect(note!.text).not.toContain("Fi conversation");
    expect((await stored(h)).status).toBe("pending");
  });
});

describe("Slack publication supersession", () => {
  it("edits a just-sent card to a neutral state when it cannot be recorded", async () => {
    const h = harness(null, { reviewers: [ADMIN_A, ADMIN_B] });
    const store = h.durable.namespaces.get("admin-actions")!;
    const realGet = store.get.bind(store);
    let sends = 0;
    let gets = -1;
    // The reload after a failed record update reads twice per observe, once per lookup.
    store.get = (key: string) => {
      const value = realGet(key) as AdminActionRecord | undefined;
      if (gets >= 0 && value) {
        gets += 1;
        if (gets === 6) {
          return { ...value, revision: (value.revision ?? 1) + 5 };
        }
      }
      return value;
    };
    h.sendPayload.mockImplementation(async (input: { to: string }) => {
      sends += 1;
      if (sends === 2) {
        const [saved] = [...store.values()] as AdminActionRecord[];
        store.set(saved!.id, { ...saved!, status: "held", revision: 2 });
        gets = 0;
      }
      return { messageId: `200.${sends}`, target: { kind: "channel", id: dm(input.to.slice(5)) } };
    });
    const tool = createRequestAdminActionTool(h.api, toolContext());
    await tool.execute("r", {
      task: "company_wiring_share",
      companyId: "company-a",
      recipientEmail: "other@example.test",
    });
    const edited = h.updates.find(
      (update) => update.channel === dm(ADMIN_B) && update.ts === "200.2",
    );
    expect(String(edited?.text)).toContain("out of date");
    expect(JSON.stringify(edited?.blocks)).not.toContain('"actions"');
  });
});
