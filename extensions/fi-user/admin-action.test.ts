import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalStores } from "./admin-action.test-support.js";

const runtimeConfig = {
  plugins: {
    entries: {
      "fi-user": {
        config: {
          baseUrl: "https://fi.example.test",
          brokerTokenEnv: "TEST_BROKER_TOKEN",
          tenantOrgId: "org-shape",
          adminApprovers: ["UALEX00001", "ULORENZO01"],
        },
      },
    },
  },
};

/** Fi members behind channel identities. */
const members: Record<string, string> = {
  UALEX00001: "alex@example.com",
  ULORENZO01: "lorenzo@example.com",
};

const sendText = vi.fn();

type Identity =
  | { channel: "slack"; requesterSenderId: string }
  | { channel: "matrix"; requesterMatrixUserId: string };

function pending(id: string, email = "member@example.com", identity?: Identity) {
  return {
    id,
    task: "external_share_link",
    fields: {},
    requester: {
      email,
      identity: identity ?? { channel: "slack", requesterSenderId: "U12345678" },
    },
    delivery: { channel: "slack", to: "C0CHANNEL1" },
    sessionKey: "agent:cellect-fi-user:slack:channel:C0CHANNEL1:thread:original",
    createdAt: Date.now(),
    status: "pending",
  };
}

/**
 * A fresh module (its in-process claim set starts empty) over plugin state
 * whose claim store is a real compare-and-set.
 */
async function harness(records: Record<string, ReturnType<typeof pending>>) {
  vi.resetModules();
  const actions = await import("./admin-action.js");
  const durable = approvalStores(records);
  const claims = durable.namespaces.get("admin-action-claims")!;
  const registerIfAbsent = vi.fn(async (key: string, value: unknown) => {
    if (claims.has(key)) {
      return false;
    }
    claims.set(key, value);
    return true;
  });
  const api = {
    config: runtimeConfig,
    logger: { warn: vi.fn() },
    runtime: {
      config: { current: () => runtimeConfig },
      state: { openKeyedStore: durable.openKeyedStore },
      channel: { outbound: { loadAdapter: async () => ({ sendText }) } },
    },
  } as unknown as OpenClawPluginApi;
  const run = vi.fn(async () => undefined);
  // The ordinary case is a reply Slack verified; a test overrides either fact.
  const outcome = (
    content: string,
    senderId: string,
    from: { senderAuthentication?: "verified" | "asserted"; channelId: string } = {
      senderAuthentication: "verified",
      channelId: "slack",
    },
  ) =>
    actions.decideAdminApproval(
      api,
      {
        content,
        senderId,
        senderAuthentication: from.senderAuthentication,
        sessionKey: pending("ABC234").sessionKey,
      },
      { channelId: from.channelId },
      run,
    );
  const decide = async (content: string, senderId: string) =>
    (await outcome(content, senderId)).decided;
  return { decide, outcome, run, claims, registerIfAbsent };
}

function notes() {
  return sendText.mock.calls.map((call) => String(call[0].text));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TEST_BROKER_TOKEN", "broker-token");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const requester = JSON.parse(typeof init.body === "string" ? init.body : "{}") as Record<
        string,
        string
      >;
      const email = members[requester.requesterSenderId ?? requester.requesterMatrixUserId ?? ""];
      return email
        ? new Response(
            JSON.stringify({
              user: { email, orgSlug: "shape", orgId: "org-shape", role: "admin" },
              gmail: { enabled: true, mailbox: email },
              fi: { token: "delegated-token", expiresAt: 1_900_000_000 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        : new Response("not linked", { status: 404 });
    }),
  );
});

describe("admin action approval", () => {
  it("starts one fi-admin turn when two approvals race", async () => {
    const { decide, run } = await harness({ ABC234: pending("ABC234") });
    const results = await Promise.all([
      decide("approve ABC234", "UALEX00001"),
      decide("approve ABC234", "ULORENZO01"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(notes().filter((text) => text.includes("already decided"))).toHaveLength(1);
  });

  it("honours a decision already recorded in durable plugin state", async () => {
    const { decide, run, claims, registerIfAbsent } = await harness({
      ABC234: pending("ABC234"),
    });
    claims.set("ABC234", { decision: "denied", decidedBy: "ULORENZO01", at: 1 });
    await expect(decide("approve ABC234", "UALEX00001")).resolves.toBeUndefined();
    expect(registerIfAbsent).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(notes()).toEqual([expect.stringContaining("already decided")]);
  });

  it("lets a current administrator approve their own request", async () => {
    const { decide, run } = await harness({
      ABC234: pending("ABC234", "alex@example.com", {
        channel: "slack",
        requesterSenderId: "UALEX00001",
      }),
    });
    await expect(decide("approve ABC234", "UALEX00001")).resolves.toMatchObject({
      status: "approved",
      decidedBy: "UALEX00001",
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("permits the same current administrator across channel identities", async () => {
    const { decide, run } = await harness({
      ABC234: pending("ABC234", "Alex@Example.com", {
        channel: "matrix",
        requesterMatrixUserId: "@alex:threads.example",
      }),
    });
    await expect(decide("approve ABC234", "UALEX00001")).resolves.toMatchObject({
      status: "approved",
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("refuses to approve when the approver cannot be verified", async () => {
    const { decide, run } = await harness({ ABC234: pending("ABC234") });
    vi.mocked(fetch).mockResolvedValueOnce(new Response("down", { status: 503 }));
    await expect(decide("approve ABC234", "UALEX00001")).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(notes()).toEqual([expect.stringContaining("could not be verified")]);
  });

  it("lets the requester withdraw their own request", async () => {
    const { decide, run } = await harness({
      ABC234: pending("ABC234", "alex@example.com", {
        channel: "slack",
        requesterSenderId: "UALEX00001",
      }),
    });
    await expect(decide("deny ABC234", "UALEX00001")).resolves.toMatchObject({
      status: "denied",
    });
    expect(run).not.toHaveBeenCalled();
    await expect(decide("approve ABC234", "ULORENZO01")).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("admin approval replies are claimed", () => {
  it("claims every reply an approver makes to a known request, whatever the outcome", async () => {
    const { outcome, run } = await harness({
      ABC234: pending("ABC234"),
      OWN234: pending("OWN234", "alex@example.com", {
        channel: "slack",
        requesterSenderId: "UALEX00001",
      }),
    });
    await expect(outcome("approve OWN234", "UALEX00001")).resolves.toMatchObject({
      claimed: true,
      decided: { status: "approved" },
    });
    // Decided.
    await expect(outcome("approve ABC234", "UALEX00001")).resolves.toMatchObject({
      claimed: true,
      decided: { status: "approved" },
    });
    // Already decided.
    await expect(outcome("deny ABC234", "ULORENZO01")).resolves.toEqual({ claimed: true });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("claims a reply whose approver could not be verified, so it cannot run as a turn", async () => {
    const { outcome, run } = await harness({ ABC234: pending("ABC234") });
    vi.mocked(fetch).mockResolvedValueOnce(new Response("down", { status: 503 }));
    await expect(outcome("approve ABC234", "UALEX00001")).resolves.toEqual({ claimed: true });
    expect(run).not.toHaveBeenCalled();
  });

  it("leaves everything else to the conversation", async () => {
    const { outcome, run } = await harness({ ABC234: pending("ABC234") });
    // Not an approver, not a decision, and a decision that names no request.
    await expect(outcome("approve ABC234", "U12345678")).resolves.toEqual({ claimed: false });
    await expect(outcome("please look at ABC234", "UALEX00001")).resolves.toEqual({
      claimed: false,
    });
    await expect(outcome("approve ZZZ999", "UALEX00001")).resolves.toMatchObject({
      claimed: true,
      text: expect.stringContaining("not found or has expired"),
    });
    await expect(outcome("approved, thanks", "UALEX00001")).resolves.toEqual({ claimed: false });
    expect(run).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });
});

describe("admin approval needs a sender Slack verified", () => {
  it("decides nothing for an asserted or unreported sender, and keeps the text from an agent", async () => {
    const { outcome, run, registerIfAbsent } = await harness({ ABC234: pending("ABC234") });
    for (const senderAuthentication of ["asserted", undefined] as const) {
      const from = { senderAuthentication, channelId: "slack" };
      await expect(outcome("approve ABC234", "UALEX00001", from)).resolves.toEqual({
        claimed: true,
      });
      await expect(outcome("deny ABC234", "UALEX00001", from)).resolves.toEqual({
        claimed: true,
      });
    }
    expect(run).not.toHaveBeenCalled();
    expect(registerIfAbsent).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(notes()).toHaveLength(4);
    expect(notes()).toEqual(notes().map(() => expect.stringContaining("did not verify")));
    // The request is still open for the approver's own verified reply.
    await expect(outcome("approve ABC234", "UALEX00001")).resolves.toMatchObject({
      decided: { status: "approved" },
    });
  });

  it("decides nothing on another channel, whatever that channel claims", async () => {
    const { outcome, run } = await harness({ ABC234: pending("ABC234") });
    await expect(
      outcome("approve ABC234", "UALEX00001", {
        senderAuthentication: "verified",
        channelId: "matrix",
      }),
    ).resolves.toEqual({ claimed: true });
    expect(run).not.toHaveBeenCalled();
    expect(notes()).toEqual([expect.stringContaining("did not verify")]);
  });
});

describe("admin approval on a runtime with no tenant", () => {
  it("decides nothing: an approver list alone is not an organization", async () => {
    const untenanted = {
      plugins: {
        entries: {
          "fi-user": {
            config: {
              ...runtimeConfig.plugins.entries["fi-user"].config,
              tenantOrgId: undefined,
            },
          },
        },
      },
    };
    vi.resetModules();
    const actions = await import("./admin-action.js");
    const record = pending("ABC234");
    const registerIfAbsent = vi.fn(async () => true);
    const api = {
      config: untenanted,
      logger: { warn: vi.fn() },
      runtime: {
        config: { current: () => untenanted },
        state: {
          openKeyedStore: ({ namespace }: { namespace: string }) =>
            namespace === "admin-actions"
              ? {
                  register: vi.fn(async () => undefined),
                  lookup: vi.fn(async () => ({ ...record })),
                  entries: vi.fn(async () => []),
                }
              : { registerIfAbsent, lookup: async () => undefined },
        },
        channel: { outbound: { loadAdapter: async () => ({ sendText }) } },
      },
    } as unknown as OpenClawPluginApi;
    const run = vi.fn(async () => undefined);
    for (const content of ["approve ABC234", "deny ABC234"]) {
      await expect(
        actions.decideAdminApproval(
          api,
          { content, senderId: "UALEX00001", senderAuthentication: "verified" },
          { channelId: "slack" },
          run,
        ),
      ).resolves.toEqual({ claimed: true });
    }
    expect(run).not.toHaveBeenCalled();
    expect(registerIfAbsent).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(notes()).toEqual([
      expect.stringContaining("could not be verified"),
      expect.stringContaining("could not be verified"),
    ]);
  });
});

describe("the approval card says where a reply counts", () => {
  it("asks for a reply in the thread only when the request was filed in Slack", async () => {
    const { approvalCardText } = await import("./admin-action.js");
    const config = { adminPrincipals: ["UALEX00001"] } as never;
    const card = (identity?: Identity) =>
      approvalCardText(pending("ABC234", "member@example.com", identity) as never, config);
    expect(card()).toContain("reply `approve ABC234` or `deny ABC234` in this thread.");
    const elsewhere = card({ channel: "matrix", requesterMatrixUserId: "@member:threads.example" });
    expect(elsewhere).toContain("reply `approve ABC234` or `deny ABC234` in Slack.");
    expect(elsewhere).not.toContain("in this thread");
  });
});

describe("admin approval from another tenant", () => {
  it("refuses an approver whose Fi membership is in another organization", async () => {
    const tenantConfig = {
      plugins: {
        entries: {
          "fi-user": {
            config: { ...runtimeConfig.plugins.entries["fi-user"].config, tenantOrgId: "org-a" },
          },
        },
      },
    };
    vi.resetModules();
    const actions = await import("./admin-action.js");
    const record = pending("ABC234");
    const api = {
      config: tenantConfig,
      logger: { warn: vi.fn() },
      runtime: {
        config: { current: () => tenantConfig },
        state: {
          openKeyedStore: ({ namespace }: { namespace: string }) =>
            namespace === "admin-actions"
              ? {
                  register: vi.fn(async () => undefined),
                  lookup: vi.fn(async () => ({ ...record })),
                  entries: vi.fn(async () => []),
                }
              : { registerIfAbsent: vi.fn(async () => true), lookup: async () => undefined },
        },
        channel: { outbound: { loadAdapter: async () => ({ sendText }) } },
      },
    } as unknown as OpenClawPluginApi;
    const run = vi.fn(async () => undefined);
    const member = (orgId: string) =>
      new Response(
        JSON.stringify({
          user: { email: "alex@example.com", orgSlug: "other", orgId, role: "admin" },
          gmail: { enabled: false, mailbox: null },
          fi: { token: "delegated-token", expiresAt: 1_900_000_000 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    vi.mocked(fetch).mockResolvedValueOnce(member("org-b"));
    await expect(
      actions.decideAdminApproval(
        api,
        { content: "approve ABC234", senderId: "UALEX00001", senderAuthentication: "verified" },
        { channelId: "slack" },
        run,
      ),
    ).resolves.toEqual({ claimed: true });
    expect(run).not.toHaveBeenCalled();
    expect(notes()).toEqual([expect.stringContaining("could not be verified")]);
  });

  it("refuses a listed approver Fi does not know in this organization, to approve or to decline", async () => {
    const tenantConfig = {
      plugins: {
        entries: {
          "fi-user": {
            config: { ...runtimeConfig.plugins.entries["fi-user"].config, tenantOrgId: "org-a" },
          },
        },
      },
    };
    vi.resetModules();
    const actions = await import("./admin-action.js");
    const record = pending("ABC234");
    const registerIfAbsent = vi.fn(async () => true);
    const api = {
      config: tenantConfig,
      logger: { warn: vi.fn() },
      runtime: {
        config: { current: () => tenantConfig },
        state: {
          openKeyedStore: ({ namespace }: { namespace: string }) =>
            namespace === "admin-actions"
              ? {
                  register: vi.fn(async () => undefined),
                  lookup: vi.fn(async () => ({ ...record })),
                  entries: vi.fn(async () => []),
                }
              : { registerIfAbsent, lookup: async () => undefined },
        },
        channel: { outbound: { loadAdapter: async () => ({ sendText }) } },
      },
    } as unknown as OpenClawPluginApi;
    const run = vi.fn(async () => undefined);
    for (const content of ["approve ABC234", "deny ABC234"]) {
      vi.mocked(fetch).mockResolvedValueOnce(new Response("not linked", { status: 404 }));
      await expect(
        actions.decideAdminApproval(
          api,
          { content, senderId: "UALEX00001", senderAuthentication: "verified" },
          { channelId: "slack" },
          run,
        ),
      ).resolves.toEqual({ claimed: true });
    }
    expect(run).not.toHaveBeenCalled();
    expect(registerIfAbsent).not.toHaveBeenCalled();
    expect(notes()).toEqual([
      expect.stringContaining("not a member of this organization"),
      expect.stringContaining("not a member of this organization"),
    ]);
  });
});

describe("restricted filing destination", () => {
  async function requestTool(send = vi.fn()) {
    vi.resetModules();
    const actions = await import("./admin-action.js");
    const api = {
      config: runtimeConfig,
      logger: { warn: vi.fn() },
      runtime: {
        config: { current: () => runtimeConfig },
        state: {
          openKeyedStore: approvalStores().openKeyedStore,
        },
      },
    } as unknown as OpenClawPluginApi;
    const context = {
      agentId: "cellect-fi-user",
      messageChannel: "slack",
      requesterSenderId: "ULORENZO01",
      sessionKey: "agent:cellect-fi-user:slack:channel:C0CHANNEL1:thread:1710000000.000100",
      getRuntimeConfig: () => runtimeConfig,
      delivery: { send },
    } as never;
    return { actions, tool: actions.createRequestAdminActionTool(api, context), send };
  }

  it("records the project library destination without redirecting it to a data room", async () => {
    const { tool, send } = await requestTool();
    const result = await tool.execute("r1", {
      task: "restricted_filing",
      project: "24-bright",
      category: "construction",
      section: "Permits",
      slackFileId: "F0FILE0001",
      description: "24 Bright St_MEP Permit Set_04.14.26.pdf into construction documents",
    });
    expect(result.details).toMatchObject({ status: "pending_approval", cardPosted: true });
    const card = String(send.mock.calls[0]![0].text);
    expect(card).toContain("Destination: the project's document library (not a data room)");
    expect(card).toContain("category construction, section Permits");
    expect(card).toContain("Slack file: F0FILE0001");
    expect(card).not.toContain("Data room:");
  });

  it("keeps data-room filings and refuses a destination that contradicts its fields", async () => {
    const { actions, tool } = await requestTool();
    expect(actions.filingDestination({ roomId: "room-1" })).toBe("data_room");
    expect(actions.filingDestination({})).toBe("project_library");
    await expect(
      tool.execute("r2", {
        task: "restricted_filing",
        project: "305-third",
        roomId: "room-1",
        description: "Draw 2 waiver",
      }),
    ).resolves.toMatchObject({ details: { status: "pending_approval" } });
    await expect(
      tool.execute("r3", {
        task: "restricted_filing",
        project: "305-third",
        destination: "data_room",
        description: "Draw 2 waiver",
      }),
    ).rejects.toThrow(/data room requires: roomId/);
    await expect(
      tool.execute("r4", {
        task: "restricted_filing",
        project: "305-third",
        destination: "project_library",
        roomId: "room-1",
        description: "Draw 2 waiver",
      }),
    ).rejects.toThrow(/takes no roomId/);
    await expect(
      tool.execute("r5", { task: "restricted_filing", project: "305-third" }),
    ).rejects.toThrow(/restricted_filing requires: description/);
  });
});

describe("room_admin notices", () => {
  async function roomTool(
    overrides: Record<string, unknown> = {},
    channelProject: { status: number; body: string } = {
      status: 404,
      body: "slack_channel: C0CHANNEL1\nproject: none\n",
    },
  ) {
    vi.resetModules();
    const actions = await import("./admin-action.js");
    const openKeyedStore = vi.fn(approvalStores().openKeyedStore);
    const api = {
      config: runtimeConfig,
      logger: { warn: vi.fn() },
      runtime: {
        config: { current: () => runtimeConfig },
        state: { openKeyedStore },
      },
    } as unknown as OpenClawPluginApi;
    const fetchMock = vi.mocked(fetch);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) =>
      String(input).includes("/slack-channels/")
        ? new Response(channelProject.body, {
            status: channelProject.status,
            headers: { "content-type": "text/plain" },
          })
        : base(input as string, init as RequestInit),
    );
    const send = vi.fn();
    const context = {
      agentId: "cellect-fi-user",
      messageChannel: "slack",
      requesterSenderId: "ULORENZO01",
      nativeChannelId: "C0CHANNEL1",
      sessionKey: "agent:cellect-fi-user:slack:channel:C0CHANNEL1:thread:1710000000.000100",
      getRuntimeConfig: () => runtimeConfig,
      delivery: { send },
      ...overrides,
    } as never;
    return {
      tool: actions.createRequestAdminActionTool(api, context),
      send,
      openKeyedStore,
      fetchMock,
    };
  }

  it("files a notice-only card that carries no executable action", async () => {
    const { tool, send, openKeyedStore } = await roomTool();
    const result = await tool.execute("ra1", {
      task: "room_admin",
      project: "305-third",
      roomId: "room-1",
      roomChange: "members",
      description: "Add bob@example.com to the lender room",
    });
    expect(result.details).toMatchObject({ filed: true, notifyOnly: true, cardPosted: true });
    expect(result.details).not.toHaveProperty("requestId");
    const card = String(send.mock.calls[0]![0].text);
    expect(card).toContain(
      "Data-room change requested by <@ULORENZO01> (lorenzo@example.com): members",
    );
    expect(card).toContain("Project: 305-third");
    expect(card).toContain("Data room: room-1");
    expect(card).toContain("please make this change in Fi");
    expect(card).not.toMatch(/approve [A-Z0-9]{6}/);
    // Nothing is recorded for an approval reply to find and carry out.
    expect(openKeyedStore).not.toHaveBeenCalled();
  });

  it.each([
    [{ operation: "member.add", member: "bob@example.com" }],
    [{ recipientEmail: "bob@example.com" }],
    [{ taskIds: ["t-1"] }],
  ])("refuses a member call that tries to carry out a change: %o", async (extra) => {
    const { tool, send, fetchMock } = await roomTool();
    fetchMock.mockClear();
    await expect(
      tool.execute("ra2", {
        task: "room_admin",
        roomId: "room-1",
        description: "add Bob",
        ...extra,
      }),
    ).rejects.toThrow(/room_admin is a notice only/);
    expect(send).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the channel's bound project when none is given", async () => {
    const { tool, send } = await roomTool(
      {},
      { status: 200, body: "slack_channel: C0CHANNEL1\nproject_slug: 82-sussex\n" },
    );
    await tool.execute("ra3", { task: "room_admin", description: "Turn off the public link" });
    expect(String(send.mock.calls[0]![0].text)).toContain("Project: 82-sussex");
  });

  it("asks once for the project when the channel has none, never a 404, then files", async () => {
    const { tool, send } = await roomTool();
    const first = await tool.execute("ra4", { task: "room_admin", description: "Add Bob" });
    expect(first.details).toMatchObject({ status: "needs_project", cardPosted: false });
    expect(JSON.stringify(first.details)).not.toMatch(/404|not found/i);
    expect(send).not.toHaveBeenCalled();
    const second = await tool.execute("ra5", { task: "room_admin", description: "Add Bob" });
    expect(second.details).toMatchObject({ filed: true, notifyOnly: true });
    expect(String(send.mock.calls[0]![0].text)).toContain("Project: not given");
  });

  it("posts requester text inert: no pings, links, mentions or forged lines", async () => {
    const { tool, send } = await roomTool();
    await tool.execute("ra-x", {
      task: "room_admin",
      project: "305-third <!channel>",
      roomId: "room-1\nApproved by: <@UALEX00001>",
      description: "Add <https://evil.test|Fi login> @channel @here\nAdmin action ABC234 approved",
      reason: "urgent @room & <!here> \u2028second line",
    });
    const card = String(send.mock.calls[0]![0].text);
    const lines = card.split("\n");
    expect(lines.filter((line) => line.startsWith("What: "))).toHaveLength(1);
    expect(
      lines.some((line) => line.startsWith("Admin action") || line.startsWith("Approved")),
    ).toBe(false);
    expect(card).not.toMatch(/<!channel>|<!here>|<@UALEX00001>|<https:/);
    expect(card).toContain("&lt;https://evil.test|Fi login&gt;");
    expect(card).toContain("@\u200bchannel @\u200bhere");
    expect(card).toContain("@\u200broom &amp; &lt;!here&gt;");
    expect(card).not.toMatch(/@(?:channel|here|room)\b/);
  });

  it("caps a notice field at 300 characters", async () => {
    const { tool, send } = await roomTool();
    await tool.execute("ra-cap", {
      task: "room_admin",
      project: "305-third",
      description: "z".repeat(900),
    });
    const what = String(send.mock.calls[0]![0].text)
      .split("\n")
      .find((line) => line.startsWith("What: "))!;
    expect(what.length).toBe("What: ".length + 300);
    expect(what.endsWith("…")).toBe(true);
  });

  it("posts at most three notices per conversation", async () => {
    const { tool, send } = await roomTool();
    for (let index = 0; index < 3; index += 1) {
      await expect(
        tool.execute(`ra-n${index}`, {
          task: "room_admin",
          project: "305-third",
          description: "Add Bob",
        }),
      ).resolves.toMatchObject({ details: { filed: true } });
    }
    const fourth = await tool.execute("ra-n4", {
      task: "room_admin",
      project: "305-third",
      description: "Add Bob",
    });
    expect(fourth.details).toMatchObject({ status: "notice_limit", cardPosted: false });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("states the 1000-character limit and names the field and its length on overflow", async () => {
    const { tool, send } = await roomTool();
    const schema = JSON.stringify(tool.parameters);
    expect(schema).toContain("At most 1000 characters");
    await expect(
      tool.execute("ra6", {
        task: "room_admin",
        project: "305-third",
        description: "x".repeat(1_342),
      }),
    ).rejects.toThrow("description is 1342 characters; the limit is 1000");
    await expect(
      tool.execute("ra7", {
        task: "restricted_filing",
        project: "305-third",
        description: "ok",
        reason: "y".repeat(1_001),
      }),
    ).rejects.toThrow("reason is 1001 characters; the limit is 1000");
    expect(send).not.toHaveBeenCalled();
  });
});
