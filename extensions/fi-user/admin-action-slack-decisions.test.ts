import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackAdminOrigin } from "./admin-action-origin.js";
import { parseSlackActionPayload } from "./admin-action-slack.js";
import {
  ADMIN_A,
  ADMIN_B,
  ORG,
  REQUESTER,
  THREAD,
  click,
  dm,
  harness,
  origin,
  record,
  stored,
  toolContext,
} from "./admin-action-slack.test-support.js";
import { createRequestAdminActionTool } from "./admin-action.js";
beforeEach(() => {
  vi.stubEnv("SLACK_APPROVAL_TEST_BROKER", "test-broker");
});
describe("Slack decision handler", () => {
  it("parses only the exact payload", () => {
    expect(parseSlackActionPayload("approve:ABC234:3")).toEqual({
      decision: "approve",
      requestId: "ABC234",
      revision: 3,
    });
    for (const bad of [
      "approve:abc234:3",
      "approve:ABC234:0",
      "delete:ABC234:1",
      "approve:ABC234",
      7,
    ]) {
      expect(parseSlackActionPayload(bad)).toBeUndefined();
    }
  });

  it("applies an approval for a verified administrator and updates every copy and the requester", async () => {
    const h = harness();
    const c = click(h, ADMIN_A, "approve:ABC234:1");
    await expect(c.result).resolves.toEqual({ handled: true });
    const after = await stored(h);
    expect(after).toMatchObject({
      status: "approved",
      revision: 2,
      decidedBy: `slack:${ADMIN_A}`,
      execution: { state: "not_executed" },
    });
    expect(h.authorizeBodies[0]).toEqual({
      channel: "slack",
      tenantOrgId: ORG,
      requestId: "ABC234",
      revision: 1,
      reviewerSlackUserId: ADMIN_A,
      requesterSlackUserId: REQUESTER,
    });
    expect(h.updates.map((update) => [update.channel, update.ts])).toEqual([
      [dm(ADMIN_A), "100.1"],
      [dm(ADMIN_B), "100.2"],
    ]);
    for (const update of h.updates) {
      expect(JSON.stringify(update.blocks)).not.toContain('"actions"');
      expect(String(update.text)).toContain(`Approved by <@${ADMIN_A}>`);
    }
    expect(h.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "channel:C0CHANNEL1",
        threadId: THREAD,
        text: expect.stringContaining("Approved"),
      }),
    );
    expect(c.reply).not.toHaveBeenCalled();
    expect(c.edit).toHaveBeenCalledTimes(1);
  });

  it("is refused when Fi does not name the clicker an administrator", async () => {
    const h = harness(record(), { admins: {} });
    const c = click(h, ADMIN_A, "approve:ABC234:1");
    await c.result;
    expect(c.reply).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("could not be verified") }),
    );
    expect((await stored(h)).status).toBe("pending");
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it("is refused when Fi names someone other than the clicker", async () => {
    const h = harness();
    vi.mocked(fetch).mockImplementationOnce(async () =>
      Response.json({ ok: true, orgId: ORG, slackUserId: ADMIN_B, role: "admin" }),
    );
    const c = click(h, ADMIN_A, "approve:ABC234:1");
    await c.result;
    expect(c.reply).toHaveBeenCalled();
    expect((await stored(h)).status).toBe("pending");
  });

  it("ignores a click that did not come from a card this request sent", async () => {
    const h = harness();
    const wrongMessage = click(h, ADMIN_A, "approve:ABC234:1", "999.9");
    await wrongMessage.result;
    const stranger = click(h, "UOTHER001", "approve:ABC234:1", "100.1");
    await stranger.result;
    for (const c of [wrongMessage, stranger]) {
      expect(c.reply).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("unavailable") }),
      );
    }
    expect((await stored(h)).status).toBe("pending");
    expect(h.authorizeBodies).toHaveLength(0);
  });

  it("refuses a stale revision and an expired request", async () => {
    const h = harness(record({ revision: 3 }));
    const stale = click(h, ADMIN_A, "approve:ABC234:1");
    await stale.result;
    expect(stale.reply).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("changed or expired") }),
    );
    const expired = harness(record({ createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }));
    const late = click(expired, ADMIN_A, "approve:ABC234:1");
    await late.result;
    expect(late.reply).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("changed or expired") }),
    );
    expect((await stored(expired)).status).toBe("pending");
  });

  it("lets the first decision win; a second reviewer's click changes nothing", async () => {
    const h = harness();
    await click(h, ADMIN_A, "decline:ABC234:1").result;
    expect((await stored(h)).status).toBe("denied");
    h.sendText.mockClear();
    const second = click(h, ADMIN_B, "approve:ABC234:1");
    await second.result;
    expect(second.reply).toHaveBeenCalled();
    const after = await stored(h);
    expect(after.status).toBe("denied");
    expect(after.decidedBy).toBe(`slack:${ADMIN_A}`);
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it("holds, resumes and approves, with a fresh revision each time", async () => {
    const h = harness();
    await click(h, ADMIN_A, "hold:ABC234:1").result;
    expect(await stored(h)).toMatchObject({ status: "held", revision: 2 });
    const held = h.updates.at(-1)!;
    expect(JSON.stringify(held.blocks)).toContain("fi-admin-action:resume");
    expect(JSON.stringify(held.blocks)).not.toContain("fi-admin-action:approve");
    expect(h.sendText).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: expect.stringContaining("On hold") }),
    );
    // A held request cannot be approved directly.
    const direct = click(h, ADMIN_B, "approve:ABC234:2");
    await direct.result;
    expect(direct.reply).toHaveBeenCalled();
    expect((await stored(h)).status).toBe("held");
    await click(h, ADMIN_B, "resume:ABC234:2").result;
    expect(await stored(h)).toMatchObject({ status: "pending", revision: 3 });
    await click(h, ADMIN_A, "approve:ABC234:3").result;
    expect(await stored(h)).toMatchObject({
      status: "approved",
      revision: 4,
      decidedBy: `slack:${ADMIN_A}`,
    });
  });

  const preparedWiring = {
    companyId: "company-a",
    companyName: "Company A",
    recipientEmail: "other@example.test",
  };
  /** Fi's wire-instruction routes, layered over the harness's. */
  function wiringFi(
    h: ReturnType<typeof harness>,
    delegationBodies: Array<Record<string, unknown>> = [],
  ) {
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/openclaw-user-delegation") && typeof init?.body === "string") {
        delegationBodies.push(JSON.parse(init.body));
      }
      if (url.includes("book.payment-instruction.show")) {
        return Response.json({
          ok: true,
          result: {
            ownerKind: "company",
            ownerId: "company-a",
            defaults: [
              {
                purpose: "investment_funding",
                instructionId: "instruction-a",
                verificationStatus: "verified",
                effectiveTo: null,
              },
            ],
          },
        });
      }
      if (url.includes("book.payment-instruction.share")) {
        return Response.json({
          ok: true,
          result: {
            applied: true,
            companyId: "company-a",
            recipientEmail: preparedWiring.recipientEmail,
            instruction: { instructionVersionId: "instruction-a" },
            url: "https://fi.example.test/fi/s/code",
            expiresAt: "2099-12-01T00:00:00Z",
          },
        });
      }
      return base(input, init);
    });
    return h;
  }
  const textsTo = (h: ReturnType<typeof harness>, to: string) =>
    h.sendText.mock.calls
      .map((call) => call[0] as unknown as { to: string; text: string })
      .filter((input) => input.to === to);

  it("sends an approved wire link only to the requester's own DM, with a bare note in a channel thread", async () => {
    const delegationBodies: Array<Record<string, unknown>> = [];
    const h = wiringFi(
      harness(record({ task: "company_wiring_share", preparedWiring })),
      delegationBodies,
    );
    await click(h, ADMIN_A, "approve:ABC234:1").result;
    expect(delegationBodies[0]).toMatchObject({
      requesterSenderId: ADMIN_A,
      agentId: "cellect-fi-admin",
    });
    expect((await stored(h)).execution).toMatchObject({ state: "done", wiringDelivered: true });
    const [privately] = textsTo(h, `user:${REQUESTER}`);
    expect(privately!.text).toContain("https://fi.example.test/fi/s/code");
    expect(privately!.text).toContain("other@example.test");
    // Requester-facing messages stay on the requester's own bot; cards edit with the admin bot.
    for (const call of h.sendText.mock.calls) {
      expect((call[0] as unknown as { accountId: string }).accountId).toBe("fi-user");
    }
    expect(h.updates.every((update) => update.token === "Bearer xoxb-admin")).toBe(true);
    const [thread] = textsTo(h, "channel:C0CHANNEL1");
    expect(thread!.text).toContain("I sent the details to");
    for (const hidden of ["fi/s/code", "other@example.test", "Company A"]) {
      expect(thread!.text).not.toContain(hidden);
    }
    expect(JSON.stringify(h.updates)).not.toContain("fi/s/code");
  });

  it("still sends the details through the private DM when the request came from that DM", async () => {
    const dmOrigin = { ...origin, channelId: dm(REQUESTER) } as SlackAdminOrigin;
    delete (dmOrigin as { threadTs?: string }).threadTs;
    const h = wiringFi(
      harness(record({ task: "company_wiring_share", preparedWiring, origin: dmOrigin })),
    );
    await click(h, ADMIN_A, "approve:ABC234:1").result;
    const [privately] = textsTo(h, `user:${REQUESTER}`);
    expect(privately!.text).toContain("https://fi.example.test/fi/s/code");
    expect(JSON.stringify(textsTo(h, `channel:${dm(REQUESTER)}`))).not.toContain("fi/s/code");
  });

  it("names neither company nor recipient in a channel thread when a wiring request is held or declined", async () => {
    const h = harness(record({ task: "company_wiring_share", preparedWiring }));
    await click(h, ADMIN_A, "hold:ABC234:1").result;
    await click(h, ADMIN_B, "decline:ABC234:2").result;
    const posts = textsTo(h, "channel:C0CHANNEL1");
    expect(posts).toHaveLength(2);
    expect(posts[0]!.text).toContain("On hold");
    expect(posts[1]!.text).toContain("Declined");
    for (const post of posts) {
      for (const hidden of ["Company A", "other@example.test", "company-a"]) {
        expect(post.text).not.toContain(hidden);
      }
    }
  });

  it("does not mark the link delivered when the private DM fails, and retries it by requestId", async () => {
    const h = wiringFi(harness(record({ task: "company_wiring_share", preparedWiring })));
    const normal = h.sendText.getMockImplementation()!;
    h.sendText.mockImplementation(async (input: { to: string }) => {
      if (input.to.startsWith("user:")) {
        throw new Error("slack down");
      }
      return normal(input);
    });
    await click(h, ADMIN_A, "approve:ABC234:1").result;
    const failed = await stored(h);
    expect(failed.status).toBe("approved");
    expect(failed.execution?.wiringDelivered).toBeFalsy();
    expect(JSON.stringify(textsTo(h, "channel:C0CHANNEL1"))).not.toContain("fi/s/code");
    h.sendText.mockImplementation(normal);
    const tool = createRequestAdminActionTool(h.api, toolContext());
    const again = await tool.execute("recover", {
      task: "company_wiring_share",
      companyId: "company-a",
      recipientEmail: "other@example.test",
      requestId: "ABC234",
    });
    expect(again.details).toMatchObject({ status: "done" });
    expect((await stored(h)).execution?.wiringDelivered).toBe(true);
    expect(textsTo(h, `user:${REQUESTER}`)[0]!.text).toContain("fi/s/code");
  });
});
