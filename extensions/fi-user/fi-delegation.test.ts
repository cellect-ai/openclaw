import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exchange, isFiUserTurn, lookupDelegation, requesterIdentity } from "./fi-delegation.js";

const connection = { baseUrl: "https://fi.example.test", brokerTokenEnv: "TEST_BROKER_TOKEN" };
const requester = { requesterSenderId: "U12345678" };

function member(user: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      user: { email: "member@example.com", orgSlug: "tenant-a", role: "member", ...user },
      gmail: { enabled: false, mailbox: null },
      fi: { token: "delegated-token", expiresAt: 1_900_000_000 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** A Slack turn on a runtime whose fi-user plugin carries `pluginConfig`. */
function slackTurn(pluginConfig: Record<string, unknown>) {
  const config = {
    plugins: { entries: { "fi-user": { config: { ...connection, ...pluginConfig } } } },
  };
  const api = { config, runtime: { config: { current: () => config } } } as never;
  const context = {
    agentId: "cellect-fi-user",
    messageChannel: "slack",
    requesterSenderId: "U12345678",
    getRuntimeConfig: () => config,
  } as unknown as OpenClawPluginToolContext;
  return exchange(api as OpenClawPluginApi, context);
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("TEST_BROKER_TOKEN", "broker-token");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("delegation is bound to this runtime's tenant", () => {
  it("accepts a member of the configured tenant", async () => {
    fetchMock.mockResolvedValue(member({ orgId: "org-a" }));
    await expect(
      lookupDelegation({ ...connection, tenantOrgId: "org-a" }, requester),
    ).resolves.toMatchObject({ user: { email: "member@example.com", orgId: "org-a" } });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://fi.example.test/api/openclaw-user-delegation",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer broker-token" }),
      }),
    );
  });

  it("refuses a member Fi resolved in another organization", async () => {
    fetchMock.mockResolvedValue(member({ orgId: "org-b", orgSlug: "tenant-b" }));
    await expect(
      lookupDelegation({ ...connection, tenantOrgId: "org-a" }, requester),
    ).rejects.toThrow(/does not belong to this runtime's Fi organization/);
  });

  it("refuses a response that does not name its organization", async () => {
    for (const user of [{}, { orgId: "" }, { orgId: null }, { orgId: 7 }]) {
      fetchMock.mockResolvedValueOnce(member(user));
      await expect(
        lookupDelegation({ ...connection, tenantOrgId: "org-a" }, requester),
        JSON.stringify(user),
      ).rejects.toThrow(/does not belong/);
    }
    // A slug that happens to equal the tenant id is not the tenant.
    fetchMock.mockResolvedValueOnce(member({ orgSlug: "org-a" }));
    await expect(
      lookupDelegation({ ...connection, tenantOrgId: "org-a" }, requester),
    ).rejects.toThrow(/does not belong/);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    await expect(
      lookupDelegation({ ...connection, tenantOrgId: "org-a" }, requester),
    ).rejects.toThrow(/does not belong/);
  });

  it("still reports an unlinked person as no member, and a broker failure as a failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not linked", { status: 404 }));
    await expect(
      lookupDelegation({ ...connection, tenantOrgId: "org-a" }, requester),
    ).resolves.toBeNull();
    fetchMock.mockResolvedValueOnce(new Response("down", { status: 503 }));
    await expect(
      lookupDelegation({ ...connection, tenantOrgId: "org-a" }, requester),
    ).rejects.toThrow(/delegation failed \(503\)/);
  });

  it("refuses everyone on a runtime with no configured tenant, without asking Fi", async () => {
    fetchMock.mockResolvedValue(member({ orgId: "org-b" }));
    await expect(lookupDelegation(connection, requester)).rejects.toThrow(
      /no Fi organization configured/,
    );
    await expect(slackTurn({})).rejects.toThrow(/no Fi organization configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports each mismatched organization pair once, naming both and nothing else", async () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const served = { ...connection, tenantOrgId: "org-served" };
    for (const answered of ["org-answered", "org-answered", "org-other", undefined]) {
      fetchMock.mockResolvedValueOnce(member(answered ? { orgId: answered } : {}));
      await expect(lookupDelegation(served, requester)).rejects.toThrow(/does not belong/);
    }
    const lines = report.mock.calls.map((call) => JSON.parse(String(call[0])) as object);
    expect(lines).toMatchObject([
      { answeredOrgId: "org-answered", servedOrgId: "org-served" },
      { answeredOrgId: "org-other", servedOrgId: "org-served" },
      { answeredOrgId: "(none)", servedOrgId: "org-served" },
    ]);
    const text = report.mock.calls.join("\n");
    expect(text).not.toContain("broker-token");
    expect(text).not.toContain("delegated-token");
    expect(text).not.toContain("member@example.com");
    // A matching answer is not a mismatch.
    fetchMock.mockResolvedValueOnce(member({ orgId: "org-served" }));
    await expect(lookupDelegation(served, requester)).resolves.toMatchObject({
      user: { orgId: "org-served" },
    });
    expect(report).toHaveBeenCalledTimes(3);
  });
});

describe("the tenant applies to a Slack-only runtime", () => {
  it("refuses another organization's member under tenantOrgId", async () => {
    fetchMock.mockResolvedValue(member({ orgId: "org-b" }));
    await expect(slackTurn({ tenantOrgId: "org-a" })).rejects.toThrow(/does not belong/);
  });

  it("keeps the earlier matrixTenantOrgId key working for the same check", async () => {
    fetchMock.mockResolvedValueOnce(member({ orgId: "org-b" }));
    await expect(slackTurn({ matrixTenantOrgId: "org-a" })).rejects.toThrow(/does not belong/);
    fetchMock.mockResolvedValueOnce(member({ orgId: "org-a" }));
    await expect(slackTurn({ matrixTenantOrgId: "org-a" })).resolves.toMatchObject({
      delegation: { user: { orgId: "org-a" } },
      config: { tenantOrgId: "org-a" },
    });
  });

  it("refuses everyone when the two keys disagree", async () => {
    fetchMock.mockResolvedValue(member({ orgId: "org-a" }));
    await expect(slackTurn({ tenantOrgId: "org-a", matrixTenantOrgId: "org-b" })).rejects.toThrow(
      /configured inconsistently/,
    );
  });

  it("admits the tenant's own member", async () => {
    fetchMock.mockResolvedValue(member({ orgId: "org-a" }));
    await expect(slackTurn({ tenantOrgId: " org-a " })).resolves.toMatchObject({
      delegation: { user: { email: "member@example.com" } },
      identity: { channel: "slack", requesterSenderId: "U12345678" },
    });
  });
});

/**
 * A Matrix reply in a Fi-user Slack thread's projection runs in the Slack
 * session; the host may report that session's channel and account while the
 * run's own reply route is the Matrix room the verified message came from.
 */
describe("a projected Matrix reply in a Slack-keyed Fi-user session", () => {
  const SESSION = "agent:cellect-fi-user:slack:channel:c0channel1:thread:1792189039.487369";
  const MATRIX = "@member:matrix.example";
  const projected = (overrides: Record<string, unknown> = {}) =>
    ({
      agentId: "cellect-fi-user",
      sessionKey: SESSION,
      messageChannel: "slack",
      agentAccountId: "fi-user",
      requesterSenderId: MATRIX,
      deliveryContext: { channel: "matrix", to: "room:!projection:matrix.example", accountId: "userprod" },
      ...overrides,
    }) as unknown as OpenClawPluginToolContext;
  beforeEach(() => {
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ userprod: "prod" }));
  });

  it("takes the requester from the verified Matrix sender although the run reports Slack", () => {
    expect(requesterIdentity(projected())).toEqual({
      channel: "matrix",
      requesterMatrixUserId: MATRIX,
    });
    expect(isFiUserTurn(projected())).toBe(true);
  });

  it("asks Fi for that Matrix person through the Matrix account's environment", async () => {
    fetchMock.mockResolvedValueOnce(member({ orgId: "org-a" }));
    const config = {
      plugins: {
        entries: { "fi-user": { config: { ...connection, tenantOrgId: "org-a" } } },
      },
    };
    const api = { config, runtime: { config: { current: () => config } } } as never;
    await exchange(
      api as OpenClawPluginApi,
      projected({ getRuntimeConfig: () => config }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      requesterMatrixUserId: MATRIX,
      agentId: "cellect-fi-user",
    });
  });

  it("keeps a Slack sender a Slack requester", () => {
    expect(requesterIdentity(projected({ requesterSenderId: "U12345678" }))).toEqual({
      channel: "slack",
      requesterSenderId: "U12345678",
    });
  });

  it.each([
    ["the reply route is not Matrix", { deliveryContext: { channel: "slack", accountId: "fi-user" } }],
    ["the Matrix account is not configured", { deliveryContext: { channel: "matrix", accountId: "unknown" } }],
    ["the session is a Slack DM", { sessionKey: "agent:cellect-fi-user:slack:direct:u12345678" }],
    ["the session belongs to another agent", { sessionKey: SESSION.replace("cellect-fi-user", "cellect-fi-admin") }],
    ["the sender is not a Matrix user id", { requesterSenderId: "matrix-alice" }],
  ])("refuses when %s", (_name, overrides) => {
    expect(requesterIdentity(projected(overrides))).toBeNull();
  });
});
