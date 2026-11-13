import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exchange,
  lookupDelegation,
  lookupRequesterEmail,
  resetResolveRouteAvailability,
} from "./fi-delegation.js";
import { mailWakeCredential } from "./mail-wake-fixture.test-support.js";

const connection = { baseUrl: "https://fi.example.test", brokerTokenEnv: "TEST_BROKER_TOKEN" };
const requester = { requesterSenderId: "U12345678" };

it("retains the incoming private review grant exchange without requesting a generic mail credential", async () => {
  const config = {
    plugins: { entries: { "fi-user": { config: { ...connection, tenantOrgId: "org-a" } } } },
  };
  const api = {
    config,
    runtime: { config: { current: () => config } },
  } as unknown as OpenClawPluginApi;
  const attestation = `pra:review-job:${"a".repeat(43)}`;
  const sessionKey = `agent:cellect-fi-user:hook:fi-review:${"b".repeat(40)}`;
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        user: { orgId: "org-a", orgSlug: "tenant-a", email: "owner@example.test" },
        requester: { channel: "personal-agent-review", email: "owner@example.test" },
        fi: { token: "private-review-only-token", expiresAt: Math.floor(Date.now() / 1000) + 60 },
        review: {
          roomId: "!main:example.test",
          jobId: "review-job",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          profile: {},
        },
      }),
    ),
  );
  const current = vi.fn();
  const result = await exchange(api, {
    agentId: "cellect-fi-user",
    runId: "review-run",
    sessionKey,
    hookRequesterAttestation: attestation,
    assertInvocationCurrent: current,
  } as OpenClawPluginToolContext);
  expect(result.identity).toEqual({ channel: "personal-agent-review" });
  expect(fetchMock.mock.calls[0][0]).toBe(
    "https://fi.example.test/api/personal-agent/background-grant",
  );
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
    reviewAttestation: attestation,
    sessionKey,
  });
  expect(current).toHaveBeenCalledTimes(2);
});

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

describe("the resolve-route fallback is remembered per Fi origin", () => {
  const cfg = (baseUrl: string) => ({ ...connection, baseUrl, tenantOrgId: "org-a" });
  const routeMissing = () => new Response("<html>404</html>", { status: 404 });
  beforeEach(() => resetResolveRouteAvailability());

  it("does not skip the route on another Fi because one Fi lacked it", async () => {
    const urls: string[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      urls.push(url);
      if (url === "https://old.example.test/api/openclaw-user-delegation/resolve") {
        return routeMissing();
      }
      if (url === "https://new.example.test/api/openclaw-user-delegation/resolve") {
        return new Response(
          JSON.stringify({
            ok: true,
            user: { email: "member@example.com" },
            requester: { channel: "slack", email: "member@example.com" },
          }),
        );
      }
      const mint = (await member({ orgId: "org-a" }).json()) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ ...mint, requester: { channel: "slack", email: "member@example.com" } }),
      );
    });
    await expect(lookupRequesterEmail(cfg("https://old.example.test"), requester)).resolves.toBe(
      "member@example.com",
    );
    await expect(lookupRequesterEmail(cfg("https://new.example.test"), requester)).resolves.toBe(
      "member@example.com",
    );
    expect(urls).toEqual([
      "https://old.example.test/api/openclaw-user-delegation/resolve",
      "https://old.example.test/api/openclaw-user-delegation",
      "https://new.example.test/api/openclaw-user-delegation/resolve",
    ]);
    // The old Fi is not asked for the route again while its verdict stands.
    await lookupRequesterEmail(cfg("https://old.example.test"), requester);
    expect(urls.at(-1)).toBe("https://old.example.test/api/openclaw-user-delegation");
  });
});

it("exchanges the exact host-bound mail context and never a model-selected source", async () => {
  const { registerMailWakeSourceLock } = await import("../../src/infra/mail-wake-source-lock.js");
  const { resolveOpenClawPluginToolInputs } =
    await import("../../src/agents/openclaw-tools.plugin-context.js");
  const config = {
    plugins: { entries: { "fi-user": { config: { ...connection, tenantOrgId: "org-a" } } } },
  };
  const api = {
    config,
    runtime: { config: { current: () => config } },
  } as unknown as OpenClawPluginApi;
  const sessionKey = "agent:cellect-fi-user:hook:fi-mail:thread";
  const receipt = `slw:job-mail:${"a".repeat(43)}`;
  const release = registerMailWakeSourceLock({
    runId: "run-mail",
    sessionKey,
    capability: receipt,
    environment: "prod",
  });
  try {
    const response = await member({ orgId: "org-a" }).json();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ...response,
          fi: mailWakeCredential(
            { sub: "member@example.com", org_slug: "tenant-a" },
            "cellect-fi-user",
          ),
        }),
      ),
    );
    const context = resolveOpenClawPluginToolInputs({
      options: {
        config,
        runId: "run-mail",
        agentSessionKey: sessionKey,
        agentChannel: "slack",
        requesterSenderId: "U12345678",
      },
    }).context;
    await exchange(api, context);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      requesterSenderId: "U12345678",
      sessionKey,
      sourceLockCapability: receipt,
    });
    release();
    fetchMock.mockClear();
    const revoked = resolveOpenClawPluginToolInputs({
      options: {
        config,
        runId: "run-mail",
        agentSessionKey: sessionKey,
        agentChannel: "slack",
        requesterSenderId: "U12345678",
      },
    }).context;
    await expect(exchange(api, revoked)).rejects.toThrow("no current host source receipt");
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    release();
  }
});

describe("mail response compatibility at credential mint", () => {
  const sessionKey = "agent:cellect-fi-user:hook:fi-mail:persistent";
  const source = { ...requester, sessionKey, sourceLockCapability: `slw:source:${"a".repeat(43)}` };
  const options = { mailWakeEnvironment: "prod" as const };
  const serve = async (claims: Record<string, unknown>, expiry?: number) => {
    const response = await member({ orgId: "org-a" }).json();
    const credential = mailWakeCredential(
      { sub: "member@example.com", org_slug: "tenant-a", ...claims },
      "cellect-fi-user",
    );
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ...response,
          fi: { ...credential, ...(expiry === undefined ? {} : { expiresAt: expiry }) },
        }),
      ),
    );
  };
  it.each([
    { wake_session: undefined, wake_message_id: undefined },
    { wake_session: false },
    { wake_message_id: "" },
    { wake_message_id: "has whitespace" },
    { agent_id: "cellect-fi-admin" },
    { org_slug: "another-tenant" },
    { sub: "another@example.com" },
    { env: "dev" },
    { env: undefined },
    { exp: 1 },
    { iat: 1 },
  ])("refuses an old or inconsistent trusted-server JWT: %j", async (claims) => {
    await serve(claims);
    await expect(
      lookupDelegation({ ...connection, tenantOrgId: "org-a" }, source, options),
    ).rejects.toThrow("compatible source-bound mail credential");
  });
  it("refuses response expiry disagreement and missing actual host environment", async () => {
    await serve({}, 1);
    await expect(
      lookupDelegation({ ...connection, tenantOrgId: "org-a" }, source, options),
    ).rejects.toThrow("compatible source-bound mail credential");
    fetchMock.mockClear();
    await expect(lookupDelegation({ ...connection, tenantOrgId: "org-a" }, source)).rejects.toThrow(
      "host source environment",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("freshly mints two different source tokens for two messages in one persistent native session", async () => {
    const { registerMailWakeSourceLock } = await import("../../src/infra/mail-wake-source-lock.js");
    const { resolveOpenClawPluginToolInputs } =
      await import("../../src/agents/openclaw-tools.plugin-context.js");
    const config = {
      plugins: { entries: { "fi-user": { config: { ...connection, tenantOrgId: "org-a" } } } },
    };
    const api = {
      config,
      runtime: { config: { current: () => config } },
    } as unknown as OpenClawPluginApi;
    const releases: Array<() => void> = [];
    const tokens: string[] = [];
    try {
      for (const [index, messageId] of ["source-message-1", "source-message-2"].entries()) {
        const runId = `mail-response-${index}`;
        const receipt = `slw:job-${index}:${String(index).repeat(43)}`;
        releases.push(
          registerMailWakeSourceLock({
            runId,
            sessionKey,
            capability: receipt,
            environment: "prod",
          }),
        );
        await serve({ wake_message_id: messageId });
        const context = resolveOpenClawPluginToolInputs({
          options: {
            config,
            runId,
            agentSessionKey: sessionKey,
            agentChannel: "slack",
            requesterSenderId: "U12345678",
          },
        }).context;
        const result = await exchange(api, context);
        tokens.push(result.delegation.fi.token);
        expect(JSON.parse(String(fetchMock.mock.calls[index][1].body))).toMatchObject({
          sessionKey,
          sourceLockCapability: receipt,
        });
        expect(
          JSON.parse(Buffer.from(result.delegation.fi.token.split(".")[1], "base64url").toString())
            .wake_message_id,
        ).toBe(messageId);
      }
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(tokens[0]).not.toBe(tokens[1]);
    } finally {
      for (const release of releases) {
        release();
      }
    }
  });
});
