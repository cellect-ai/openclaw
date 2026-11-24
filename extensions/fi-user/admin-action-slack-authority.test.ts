import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSlackAdminActionClick } from "./admin-action-slack-handler.js";
import { ADMIN_A, dm, harness, origin, record, stored } from "./admin-action-slack.test-support.js";

beforeEach(() => vi.stubEnv("SLACK_APPROVAL_TEST_BROKER", "test-broker"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Slack approval admitted policy", () => {
  it.each([
    ["policy", "/admin-action-authorize"],
    ["policy", "/openclaw-user-delegation"],
    ["plugin", "/admin-action-authorize"],
    ["plugin", "/openclaw-user-delegation"],
  ])(
    "does not decide or execute after %s retirement while awaiting %s",
    async (owner, endpoint) => {
      const h = harness(
        record({
          task: "company_wiring_share",
          preparedWiring: {
            companyId: "company-a",
            companyName: "Company A",
            recipientEmail: "recipient@example.test",
          },
        }),
      );
      const base = vi.mocked(fetch).getMockImplementation()!;
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (String(input).endsWith(endpoint)) {
          entered.resolve();
          await release.promise;
        }
        return base(input, init);
      });
      let current = true;
      const assertCurrent = () => {
        if (!current) throw new Error("retired policy");
      };
      const reply = vi.fn(async () => {});
      const editMessage = vi.fn(async () => {});
      const result = handleSlackAdminActionClick(h.api, {
        authority: { assertCurrent },
        accountId: "fi-admin",
        senderId: ADMIN_A,
        conversationId: dm(ADMIN_A),
        interaction: { kind: "button", payload: "approve:ABC234:1", messageTs: "100.1" },
        respond: { reply, editMessage },
      });
      await entered.promise;
      if (owner === "plugin") h.lifecycle.abort();
      else current = false;
      release.resolve();
      await result;
      expect(await stored(h)).toMatchObject({ status: "pending", revision: 1 });
      expect((await stored(h)).execution).toBeUndefined();
      expect(h.sendText).not.toHaveBeenCalled();
      expect(h.sendPayload).not.toHaveBeenCalled();
      expect(reply).not.toHaveBeenCalled();
      expect(editMessage).not.toHaveBeenCalled();
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([url]) => String(url).includes("book.payment-instruction")),
      ).toBe(false);
    },
  );

  it("accepts the published card in its verified workspace", async () => {
    const h = harness(record({ origin: { ...origin, teamId: "TWORK001" } }));
    await handleSlackAdminActionClick(h.api, {
      authority: { assertCurrent: () => {} },
      teamId: "TWORK001",
      accountId: "fi-admin",
      senderId: ADMIN_A,
      conversationId: dm(ADMIN_A),
      interaction: { kind: "button", payload: "approve:ABC234:1", messageTs: "100.1" },
      respond: { reply: async () => {}, editMessage: async () => {} },
    });
    expect(await stored(h)).toMatchObject({ status: "approved", revision: 2 });
    expect(h.updates).toHaveLength(2);
    expect(h.updates.every((update) => update.team_id === "TWORK001")).toBe(true);
    expect(h.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "team:TWORK001:channel:C0CHANNEL1",
        accountId: "fi-user",
      }),
    );
  });

  it.each([undefined, "TOTHER001"])("refuses a card click from workspace %s", async (teamId) => {
    const h = harness(record({ origin: { ...origin, teamId: "TWORK001" } }));
    await handleSlackAdminActionClick(h.api, {
      authority: { assertCurrent: () => {} },
      teamId,
      accountId: "fi-admin",
      senderId: ADMIN_A,
      conversationId: dm(ADMIN_A),
      interaction: { kind: "button", payload: "approve:ABC234:1", messageTs: "100.1" },
      respond: { reply: async () => {}, editMessage: async () => {} },
    });
    expect(h.authorizeBodies).toHaveLength(0);
    expect(await stored(h)).toMatchObject({ status: "pending", revision: 1 });
  });
});
