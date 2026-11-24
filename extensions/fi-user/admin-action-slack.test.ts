import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareAdminActionOrigin, publishAdminActionCard } from "./admin-action-card.js";
import { resolveReviewAccountId } from "./admin-action-slack.js";
import {
  ADMIN_A,
  ADMIN_B,
  REQUESTER,
  cfg,
  click,
  dm,
  harness,
  origin,
  record,
  stored,
  toolContext,
} from "./admin-action-slack.test-support.js";
import {
  createRequestAdminActionTool,
  loadAdminAction,
  type AdminActionRecord,
} from "./admin-action.js";
import { resolveFiUserPluginConfig } from "./fi-delegation.js";
beforeEach(() => {
  vi.stubEnv("SLACK_APPROVAL_TEST_BROKER", "test-broker");
});
describe("Slack approval origin", () => {
  const config = resolveFiUserPluginConfig(cfg.plugins.entries["fi-user"].config);
  const api = {} as OpenClawPluginApi;
  const identity = { channel: "slack" as const, requesterSenderId: REQUESTER };

  it("binds only host-selected routing and the verified sender", () => {
    expect(prepareAdminActionOrigin(api, toolContext(), config, identity)).toEqual(origin);
  });

  it("refuses an unverified or missing sender, a mismatched route and any other channel's route", () => {
    for (const [context, who] of [
      [toolContext(), undefined],
      [toolContext(), { channel: "slack" as const, requesterSenderId: "not-a-user" }],
      [toolContext({ deliveryContext: { channel: "matrix", to: "room:!r:x" } }), identity],
      [toolContext({ deliveryContext: undefined }), identity],
      [toolContext({ nativeChannelId: undefined, sessionKey: "agent:other" }), identity],
      [
        toolContext({
          deliveryContext: { channel: "slack", to: "C0CHANNEL1", accountId: "other" },
        }),
        identity,
      ],
      [
        toolContext({
          deliveryContext: {
            channel: "slack",
            to: "C0CHANNEL1",
            accountId: "fi-user",
            threadId: "1.2",
          },
        }),
        identity,
      ],
    ] as const) {
      expect(() => prepareAdminActionOrigin(api, context, config, who)).toThrow(
        /Cannot bind this approval/,
      );
    }
    expect(() =>
      prepareAdminActionOrigin(api, toolContext(), { ...config, tenantOrgId: "" }, identity),
    ).toThrow(/Cannot bind/);
  });

  it("never takes the origin from model-supplied parameters", async () => {
    const h = harness(null);
    vi.mocked(fetch);
    const tool = createRequestAdminActionTool(h.api, toolContext());
    await tool.execute("r", {
      task: "company_wiring_share",
      companyId: "company-a",
      recipientEmail: "x@example.test",
      requesterSlackUserId: ADMIN_A,
      channelId: "C0OTHER001",
      accountId: "elsewhere",
    } as never);
    const [saved] = [...h.durable.namespaces.get("admin-actions")!.values()] as AdminActionRecord[];
    expect(saved!.origin).toEqual(origin);
  });
});

describe("Slack publication", () => {
  const wiring = {
    task: "company_wiring_share",
    companyId: "company-a",
    recipientEmail: "other@example.test",
  };

  it("files nothing and says so when no administrator can receive it", async () => {
    const h = harness(null, { reviewers: [] });
    const tool = createRequestAdminActionTool(h.api, toolContext());
    await expect(tool.execute("r", wiring)).rejects.toThrow(
      /No administrator can receive this request in Slack; ask them directly/,
    );
    expect([...h.durable.namespaces.get("admin-actions")!.values()]).toHaveLength(0);
    expect(h.sendPayload).not.toHaveBeenCalled();
  });

  it("sends a private card to every reviewer and records each receipt", async () => {
    const h = harness(null);
    const tool = createRequestAdminActionTool(h.api, toolContext());
    const result = await tool.execute("r", wiring);
    expect(result.details).toMatchObject({
      status: "pending_approval",
      tellRequester: expect.stringContaining("privately"),
    });
    expect(h.sendPayload).toHaveBeenCalledTimes(2);
    const first = h.sendPayload.mock.calls[0]![0] as unknown as {
      to: string;
      text: string;
      payload: { channelData: { slack: { blocks: Array<Record<string, unknown>> } } };
    };
    expect(first.to).toBe(`user:${ADMIN_A}`);
    for (const call of h.sendPayload.mock.calls) {
      expect((call[0] as unknown as { accountId: string }).accountId).toBe("fi-admin");
    }
    const actions = first.payload.channelData.slack.blocks.find(
      (block) => block.type === "actions",
    ) as {
      elements: Array<{ action_id: string; value: string }>;
    };
    const id = (result.details as { requestId: string }).requestId;
    expect(actions.elements.map((button) => [button.action_id, button.value])).toEqual([
      ["fi-admin-action:approve", `${id}:1`],
      ["fi-admin-action:hold", `${id}:1`],
      ["fi-admin-action:decline", `${id}:1`],
    ]);
    const saved = [...h.durable.namespaces.get("admin-actions")!.values()][0] as AdminActionRecord;
    expect(saved.slackPublications).toEqual([
      { slackUserId: ADMIN_A, channelId: dm(ADMIN_A), ts: "200.1" },
      { slackUserId: ADMIN_B, channelId: dm(ADMIN_B), ts: "200.2" },
    ]);
    expect(saved.origin).toEqual(origin);
    expect(saved.slackReviewAccountId).toBe("fi-admin");
  });

  it("retries without repeating a card a reviewer already has", async () => {
    const h = harness(null);
    h.sendPayload.mockRejectedValueOnce(new Error("slack down"));
    const tool = createRequestAdminActionTool(h.api, toolContext());
    const result = await tool.execute("r", wiring);
    expect(result.details).toMatchObject({ status: "pending_approval" });
    let saved = [...h.durable.namespaces.get("admin-actions")!.values()][0] as AdminActionRecord;
    expect(saved.slackPublications?.map((entry) => entry.slackUserId)).toEqual([ADMIN_B]);
    h.sendPayload.mockClear();
    await publishAdminActionCard(h.api, saved);
    saved = (await loadAdminAction(h.api, saved.id))!;
    expect(h.sendPayload).toHaveBeenCalledTimes(1);
    expect((h.sendPayload.mock.calls[0]![0] as { to: string }).to).toBe(`user:${ADMIN_A}`);
    expect(saved.slackPublications?.map((entry) => entry.slackUserId).toSorted()).toEqual([
      ADMIN_A,
      ADMIN_B,
    ]);
    expect(h.updates).toHaveLength(1);
  });

  it("keeps a request nobody could be told about retryable, and recovers it by requestId", async () => {
    const h = harness(null);
    h.sendPayload.mockRejectedValue(new Error("slack down"));
    const tool = createRequestAdminActionTool(h.api, toolContext());
    const first = await tool.execute("r", wiring);
    expect(first.details).toMatchObject({ status: "publication_pending", cardPosted: false });
    const requestId = (first.details as { requestId: string }).requestId;
    expect((await loadAdminAction(h.api, requestId))?.slackPublications).toBeUndefined();
    h.sendPayload.mockClear();
    h.sendPayload.mockImplementation(async (input: { to: string }) => ({
      messageId: "400.1",
      target: { kind: "channel", id: dm(input.to.slice(5)) },
    }));
    const again = await tool.execute("r2", { ...wiring, requestId });
    expect(again.details).toMatchObject({ requestId, status: "pending_approval" });
    expect((await loadAdminAction(h.api, requestId))?.slackPublications).toHaveLength(2);
  });
});

describe("Slack reviewer account", () => {
  it("accepts a click that arrives on the admin account and refuses the same click on the user account", async () => {
    const h = harness();
    const wrong = click(h, ADMIN_A, "approve:ABC234:1", "100.1", "fi-user");
    await wrong.result;
    expect(wrong.reply).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("unavailable") }),
    );
    expect((await stored(h)).status).toBe("pending");
    expect(h.authorizeBodies).toHaveLength(0);
    await click(h, ADMIN_A, "approve:ABC234:1").result;
    expect(await stored(h)).toMatchObject({ status: "approved", decidedBy: `slack:${ADMIN_A}` });
  });

  it("treats a record stored without a reviewer account as the origin's", async () => {
    const legacy = record();
    delete legacy.slackReviewAccountId;
    const h = harness(legacy);
    await click(h, ADMIN_A, "approve:ABC234:1", "100.1", "fi-user").result;
    expect((await stored(h)).status).toBe("approved");
  });

  it("fails closed, sending nothing, without a usable admin Slack account", async () => {
    const slack = cfg.channels.slack as {
      accounts: Record<string, { botToken?: string; enabled?: boolean }>;
    };
    const admin = slack.accounts["fi-admin"]!;
    const bindings = cfg.bindings.slice();
    const wiring = {
      task: "company_wiring_share",
      companyId: "company-a",
      recipientEmail: "other@example.test",
    };
    const broken: Array<[string, () => void]> = [
      ["unbound", () => cfg.bindings.splice(1, 1)],
      ["tokenless", () => delete admin.botToken],
      ["disabled", () => (admin.enabled = false)],
    ];
    for (const [, breakIt] of broken) {
      const h = harness(null);
      breakIt();
      try {
        const tool = createRequestAdminActionTool(h.api, toolContext());
        await expect(tool.execute("r", wiring)).rejects.toThrow(/administrators' Slack account/);
        await expect(
          tool.execute("n", { task: "document_outside_grants", project: "p", description: "d" }),
        ).rejects.toThrow(/administrators' Slack account/);
        expect(h.sendPayload).not.toHaveBeenCalled();
        expect(h.sendText).not.toHaveBeenCalled();
        expect([...h.durable.namespaces.get("admin-actions")!.values()]).toHaveLength(0);
      } finally {
        cfg.bindings.splice(0, cfg.bindings.length, ...bindings);
        admin.botToken = "xoxb-admin";
        delete admin.enabled;
      }
    }
  });
});

describe("Slack reviewer account by workspace", () => {
  const team = "T09JRQ3FS91";
  const account = { botToken: "xoxb-x" };
  const prodBindings = [
    { agentId: "cellect-fi-user", match: { channel: "slack", accountId: "fi-user", teamId: team } },
    {
      agentId: "cellect-fi-admin",
      match: { channel: "slack", accountId: "fi-admin", teamId: team },
    },
    { agentId: "cellect-fi-user", match: { channel: "slack", accountId: "*" } },
  ];
  it("matches a lower-cased team id", () => {
    expect(resolveReviewAccountId(apiFor(prodBindings), team.toLowerCase())).toBe("fi-admin");
    expect(() => resolveReviewAccountId(apiFor(prodBindings), "tother0001")).toThrow();
  });

  const apiFor = (bindings: unknown[]) => {
    const config = {
      bindings,
      plugins: { entries: { "fi-user": { config: { adminAgentId: "cellect-fi-admin" } } } },
      channels: {
        slack: {
          accounts: {
            "fi-user": account,
            "fi-admin": account,
            "fi-admin-2": account,
            "cellect-main": { ...account, enabled: false },
            default: {},
          },
        },
      },
    };
    return {
      runtime: { config: { current: () => config } },
      config,
    } as unknown as OpenClawPluginApi;
  };

  it("accepts the production shape: team-scoped entries with no type field", () => {
    const api = apiFor(prodBindings);
    expect(resolveReviewAccountId(api, team)).toBe("fi-admin");
    expect(resolveReviewAccountId(api)).toBe("fi-admin");
  });

  it("picks the binding for the request's own workspace among several", () => {
    const api = apiFor([
      ...prodBindings,
      {
        agentId: "cellect-fi-admin",
        match: { channel: "slack", accountId: "fi-admin-2", teamId: "T2SECOND01" },
      },
    ]);
    expect(resolveReviewAccountId(api, team)).toBe("fi-admin");
    expect(resolveReviewAccountId(api, "T2SECOND01")).toBe("fi-admin-2");
    expect(() => resolveReviewAccountId(api)).toThrow(/administrators' Slack account/);
  });

  it("fails closed when no admin binding belongs to the request's workspace", () => {
    expect(() => resolveReviewAccountId(apiFor(prodBindings), "TOTHER0001")).toThrow(
      /administrators' Slack account/,
    );
  });

  it("still ignores a peer- or guild-scoped admin binding", () => {
    const api = apiFor([
      {
        agentId: "cellect-fi-admin",
        match: { channel: "slack", accountId: "fi-admin", peer: { kind: "direct", id: "U1" } },
      },
    ]);
    expect(() => resolveReviewAccountId(api, team)).toThrow(/administrators' Slack account/);
  });
});
