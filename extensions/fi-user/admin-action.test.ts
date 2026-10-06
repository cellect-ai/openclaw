import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeConfig = {
  plugins: {
    entries: {
      "fi-user": {
        config: {
          baseUrl: "https://fi.example.test",
          brokerTokenEnv: "TEST_BROKER_TOKEN",
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
  const claims = new Map<string, unknown>();
  const registerIfAbsent = vi.fn(async (key: string, value: unknown) => {
    if (claims.has(key)) {
      return false;
    }
    claims.set(key, value);
    return true;
  });
  const stores: Record<string, unknown> = {
    "admin-actions": {
      register: vi.fn(async () => undefined),
      // A new object per lookup, as a persisted store returns.
      lookup: vi.fn(async (key: string) => (records[key] ? { ...records[key] } : undefined)),
      entries: vi.fn(async () => []),
    },
    "admin-action-claims": { registerIfAbsent },
  };
  const api = {
    config: runtimeConfig,
    logger: { warn: vi.fn() },
    runtime: {
      config: { current: () => runtimeConfig },
      state: { openKeyedStore: ({ namespace }: { namespace: string }) => stores[namespace] },
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
      { content, senderId, senderAuthentication: from.senderAuthentication },
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
              user: { email, orgSlug: "shape", role: "admin" },
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
    expect(registerIfAbsent).toHaveBeenCalledWith(
      "ABC234",
      expect.objectContaining({ decision: "approved", decidedBy: "UALEX00001" }),
      expect.anything(),
    );
    expect(run).not.toHaveBeenCalled();
    expect(notes()).toEqual([expect.stringContaining("already decided")]);
  });

  it("never lets an approver approve their own request", async () => {
    const { decide, run } = await harness({
      ABC234: pending("ABC234", "alex@example.com", {
        channel: "slack",
        requesterSenderId: "UALEX00001",
      }),
    });
    await expect(decide("approve ABC234", "UALEX00001")).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(notes()).toEqual([expect.stringContaining("cannot be approved by the person")]);

    // The refusal does not use up the request: another approver can decide.
    await expect(decide("approve ABC234", "ULORENZO01")).resolves.toMatchObject({
      status: "approved",
      decidedBy: "ULORENZO01",
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("recognises the requester approving from another channel by their Fi identity", async () => {
    const { decide, run } = await harness({
      ABC234: pending("ABC234", "Alex@Example.com", {
        channel: "matrix",
        requesterMatrixUserId: "@alex:threads.example",
      }),
    });
    await expect(decide("approve ABC234", "UALEX00001")).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(notes()).toEqual([expect.stringContaining("cannot be approved by the person")]);
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
    // Refused: the approver's own request.
    await expect(outcome("approve OWN234", "UALEX00001")).resolves.toEqual({ claimed: true });
    // Decided.
    await expect(outcome("approve ABC234", "UALEX00001")).resolves.toMatchObject({
      claimed: true,
      decided: { status: "approved" },
    });
    // Already decided.
    await expect(outcome("deny ABC234", "ULORENZO01")).resolves.toEqual({ claimed: true });
    expect(run).toHaveBeenCalledTimes(1);
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
    await expect(outcome("approve ZZZ999", "UALEX00001")).resolves.toEqual({ claimed: false });
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
              : { registerIfAbsent: vi.fn(async () => true) },
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

    vi.mocked(fetch).mockResolvedValueOnce(member("org-a"));
    await expect(
      actions.decideAdminApproval(
        api,
        { content: "approve ABC234", senderId: "UALEX00001", senderAuthentication: "verified" },
        { channelId: "slack" },
        run,
      ),
    ).resolves.toMatchObject({ claimed: true, decided: { status: "approved" } });
    expect(run).toHaveBeenCalledTimes(1);
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
              : { registerIfAbsent },
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
          openKeyedStore: () => {
            throw new Error("no store in tests");
          },
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

  it("files into the project library when no room is given, and briefs fi-admin for the library", async () => {
    const { actions, tool, send } = await requestTool();
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

    const brief = actions.adminActionBrief({
      id: "ABC234",
      task: "restricted_filing",
      fields: { project: "24-bright", destination: "project_library", description: "MEP set" },
      requester: { email: "member@example.com", identity: { channel: "unknown" } },
      createdAt: Date.now(),
      status: "approved",
    });
    expect(brief).toContain("project's document library as a restricted document");
    expect(brief).toContain("do not add it to any data room");
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
