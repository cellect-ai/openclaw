import type {
  OpenClawPluginApi,
  PluginAgentEventSubscriptionRegistration,
} from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminActionSessions } from "./admin-action.js";
import fiUserPlugin from "./index.js";

const BROKER = "fixture-broker-credential";
const TOKEN = "fixtureheader.fixturepayload.fixturesignature";
const SESSION = "agent:cellect-fi-admin:slack:channel:c1:thread:1.2";
const MINT_URL = "https://fi.example.test/fi/api/openclaw-user-delegation";
type Env = Record<string, string>;
type Rewrite = { params: { env?: Env } } | undefined;

function plugin(configOverrides: Record<string, unknown> = {}) {
  const hooks = new Map<string, Array<(event: never, context: never) => unknown>>();
  const subscriptions: PluginAgentEventSubscriptionRegistration[] = [];
  const warn = vi.fn();
  fiUserPlugin.register?.(
    createTestPluginApi({
      id: "fi-user",
      name: "Fi User Delegation",
      config: {
        plugins: {
          entries: {
            "fi-user": {
              config: {
                baseUrl: "https://fi.example.test/fi/",
                brokerTokenEnv: "FIXTURE_BROKER",
                tenantOrgId: "org-a",
                ...configOverrides,
              },
            },
          },
        },
      },
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
      runtime: {
        channel: { runtimeContexts: { register: vi.fn() } },
      } as unknown as OpenClawPluginApi["runtime"],
      on: (name, handler) => hooks.set(name, [...(hooks.get(name) ?? []), handler as never]),
      registerAgentEventSubscription: (subscription) => subscriptions.push(subscription),
    }),
  );
  const hook = async (name: string, event: unknown, context: unknown) => {
    for (const handler of hooks.get(name) ?? []) {
      const result = await handler(event as never, context as never);
      if (result) {
        return result;
      }
    }
    return undefined;
  };
  return {
    warn,
    /** A message the host dispatches to the session. */
    arrive: (overrides: Record<string, unknown> = {}) =>
      hook(
        "before_dispatch",
        {
          content: "run the audit",
          channel: "slack",
          sessionKey: SESSION,
          senderId: "U0ADMIN001",
          senderAuthentication: "verified",
          ...overrides,
        },
        { channelId: overrides.channel ?? "slack", sessionKey: overrides.sessionKey ?? SESSION },
      ),
    /** The run the host starts for it. */
    start: (overrides: Record<string, unknown> = {}) =>
      hook(
        "before_agent_reply",
        { cleanedBody: "run the audit" },
        {
          runId: "run-1",
          agentId: "cellect-fi-admin",
          sessionKey: SESSION,
          channel: "slack",
          trigger: "user",
          senderId: "U0ADMIN001",
          ...overrides,
        },
      ),
    exec: (overrides: Record<string, unknown> = {}, event: Record<string, unknown> = {}) =>
      hook(
        "before_tool_call",
        { toolName: "exec", params: { command: "npm run fi:audit" }, ...event },
        {
          runId: "run-1",
          agentId: "cellect-fi-admin",
          sessionKey: SESSION,
          toolName: "exec",
          requester: { channel: "slack", senderId: "U0ADMIN001" },
          ...overrides,
        },
      ) as Promise<Rewrite>,
    settle: async (runId = "run-1") => {
      for (const subscription of subscriptions) {
        await subscription.handle(
          { runId, data: { phase: "end", executionSettled: true } } as never,
          {} as never,
        );
      }
    },
  };
}

const fetchMock = vi.fn();
const minted = (fi: Record<string, unknown> = {}, user: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      ok: true,
      user: { email: "admin@example.com", orgSlug: "a", orgId: "org-a", role: "admin", ...user },
      fi: { token: TOKEN, expiresAt: Math.floor(Date.now() / 1000) + 600, ...fi },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
const mintBody = (call = 0) =>
  JSON.parse((fetchMock.mock.calls[call]![1] as { body: string }).body) as Record<string, string>;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => minted());
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("FIXTURE_BROKER", BROKER);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the admin agent's delegated user token", () => {
  it("gives a verified requester's exec their own token, pinned to the Fi it came from", async () => {
    const turn = plugin();
    await turn.arrive();
    await turn.start();
    const result = await turn.exec(
      {},
      {
        params: {
          command: "npm run fi:audit",
          requesterSenderId: "U0SOMEONE9",
          env: { KEEP: "1", fi_delegated_user_token: "forged", Fi_App_Url: "https://evil.test" },
        },
      },
    );
    expect(result?.params.env).toEqual({
      KEEP: "1",
      FI_ON_BEHALF_OF: expect.any(String),
      FI_DELEGATED_USER_TOKEN: TOKEN,
      FI_APP_URL: "https://fi.example.test/fi",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      MINT_URL,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: `Bearer ${BROKER}` }),
      }),
    );
    // The host's sender, never the tool input; exactly one requester form.
    expect(mintBody()).toEqual({ requesterSenderId: "U0ADMIN001", agentId: "cellect-fi-admin" });
  });

  it("covers sandbox_exec and asks Fi afresh for every call", async () => {
    const turn = plugin();
    await turn.arrive();
    await turn.start();
    fetchMock.mockImplementationOnce(async () => minted({ token: "first.fixture.token" }));
    const first = await turn.exec({ toolName: "sandbox_exec" }, { toolName: "sandbox_exec" });
    const second = await turn.exec();
    expect(first?.params.env?.FI_DELEGATED_USER_TOKEN).toBe("first.fixture.token");
    expect(second?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses this runtime's own admin agent id with Fi's protocol name", async () => {
    const session = "agent:tenant-admin:slack:channel:c1";
    const turn = plugin({ adminAgentId: "tenant-admin" });
    await turn.arrive({ sessionKey: session });
    await turn.start({ agentId: "tenant-admin", sessionKey: session });
    const result = await turn.exec({ agentId: "tenant-admin", sessionKey: session });
    // No legacy assertion for an agent Fi's on-behalf-of does not know; the token alone.
    expect(result?.params.env).toEqual({
      FI_DELEGATED_USER_TOKEN: TOKEN,
      FI_APP_URL: "https://fi.example.test/fi",
    });
    expect(mintBody().agentId).toBe("cellect-fi-admin");
    // The default admin agent is no longer this runtime's admin tier.
    fetchMock.mockClear();
    await turn.arrive();
    await turn.start();
    expect((await turn.exec())?.params.env).not.toHaveProperty("FI_DELEGATED_USER_TOKEN");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mints for a homeserver-recorded Matrix sender of the account's own Fi", async () => {
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
    const session = "agent:cellect-fi-admin:slack:matrix-linked";
    const matrix = { channel: "matrix", senderId: "@admin:matrix.example" };
    const turn = plugin();
    await turn.arrive({ ...matrix, sessionKey: session, senderAuthentication: undefined });
    await turn.start({ ...matrix, sessionKey: session });
    const result = await turn.exec({
      sessionKey: session,
      requester: { ...matrix, accountId: "adminprod" },
    });
    expect(result?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
    expect(mintBody()).toEqual({
      requesterMatrixUserId: "@admin:matrix.example",
      agentId: "cellect-fi-admin",
    });
    // An account with no configured Fi environment has nowhere to ask.
    fetchMock.mockClear();
    const other = await turn.exec({
      sessionKey: session,
      requester: { ...matrix, accountId: "unknown" },
    });
    expect(other?.params.env).not.toHaveProperty("FI_DELEGATED_USER_TOKEN");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("acts for the recorded requester of an approved admin action", async () => {
    const sessionKey = "agent:cellect-fi-admin:admin-action:zzz222";
    const record = {
      id: "ZZZ222",
      task: "external_share_link" as const,
      fields: {},
      requester: {
        email: "member@example.com",
        identity: { channel: "slack" as const, requesterSenderId: "U0MEMBER01" },
      },
      createdAt: Date.now(),
      status: "approved" as const,
    };
    adminActionSessions.set(sessionKey, record);
    try {
      const turn = plugin();
      const result = await turn.exec({ sessionKey, runId: "action-run", requester: undefined });
      expect(result?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
      expect(mintBody().requesterSenderId).toBe("U0MEMBER01");
      // Fi refuses a webchat identity for this token, so none is asked for.
      fetchMock.mockClear();
      adminActionSessions.set(sessionKey, {
        ...record,
        requester: {
          email: "member@example.com",
          identity: { channel: "webchat", appContextToken: "context" },
        },
      });
      const webchat = await turn.exec({ sessionKey, runId: "action-run", requester: undefined });
      expect(webchat?.params.env).not.toHaveProperty("FI_DELEGATED_USER_TOKEN");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      adminActionSessions.delete(sessionKey);
    }
  });

  describe("turns that get no token", () => {
    const refused = async (result: Promise<Rewrite>) => {
      const env = (await result)?.params.env ?? {};
      expect(env).not.toHaveProperty("FI_DELEGATED_USER_TOKEN");
      expect(env).not.toHaveProperty("FI_APP_URL");
      expect(fetchMock).not.toHaveBeenCalled();
      return env;
    };

    it.each(["cron", "heartbeat", "memory", "manual", undefined])(
      "a %s run, even with a sender on it",
      async (trigger) => {
        const turn = plugin();
        await turn.arrive();
        await turn.start({ trigger });
        await refused(turn.exec());
      },
    );

    it("a run no dispatched message started: webhook, sub-agent, inter-session, resumed", async () => {
      const turn = plugin();
      // The host stamps a stored sender on a resumed run; nothing arrived for it.
      await turn.start();
      const env = await refused(turn.exec());
      // The legacy assertion is unaffected.
      expect(env.FI_ON_BEHALF_OF).toEqual(expect.any(String));
    });

    it("a run with no sender of its own", async () => {
      const turn = plugin();
      await turn.arrive();
      await turn.start({ senderId: undefined });
      await refused(turn.exec({ requester: { channel: "slack" } }));
    });

    it("a batch of messages from more than one sender", async () => {
      const turn = plugin();
      await turn.arrive();
      await turn.arrive({ senderId: "U0OTHER002" });
      await turn.start();
      await refused(turn.exec());
    });

    it("a run someone else writes into while it is running", async () => {
      const turn = plugin();
      await turn.arrive();
      await turn.start();
      await turn.arrive({ senderId: "U0OTHER002" });
      await refused(turn.exec());
    });

    it("a second message from the same sender leaves the run admitted", async () => {
      const turn = plugin();
      await turn.arrive();
      await turn.start();
      await turn.arrive();
      expect((await turn.exec())?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
    });

    it.each(["asserted", undefined])("a Slack sender that is only %s", async (authentication) => {
      const turn = plugin();
      await turn.arrive({ senderAuthentication: authentication });
      await turn.start();
      await refused(turn.exec());
    });

    it("a Matrix sender another party named", async () => {
      const matrix = { channel: "matrix", senderId: "@admin:matrix.example" };
      vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
      const session = "agent:cellect-fi-admin:slack:matrix-linked";
      const turn = plugin();
      await turn.arrive({ ...matrix, sessionKey: session, senderAuthentication: "asserted" });
      await turn.start({ ...matrix, sessionKey: session });
      await refused(
        turn.exec({ sessionKey: session, requester: { ...matrix, accountId: "adminprod" } }),
      );
    });

    it("a tool call whose requester, session or run is not the admitted turn's", async () => {
      const turn = plugin();
      await turn.arrive();
      await turn.start();
      await refused(turn.exec({ requester: { channel: "slack", senderId: "U0OTHER002" } }));
      await refused(turn.exec({ sessionKey: `${SESSION}:other` }));
      await refused(turn.exec({ runId: "run-2" }));
      await refused(turn.exec({ requester: { channel: "webchat", senderId: "U0ADMIN001" } }));
    });

    it("a run that has settled, and the next run without a message of its own", async () => {
      const turn = plugin();
      await turn.arrive();
      await turn.start();
      await turn.settle();
      await refused(turn.exec());
      await turn.start({ runId: "run-2" });
      await refused(turn.exec({ runId: "run-2" }));
    });

    it("a message that arrived too long before the run", async () => {
      vi.useFakeTimers();
      try {
        const turn = plugin();
        await turn.arrive();
        vi.advanceTimersByTime(31 * 60 * 1000);
        await turn.start();
        await refused(turn.exec());
      } finally {
        vi.useRealTimers();
      }
    });

    it("a runtime with no tenant", async () => {
      const turn = plugin({ tenantOrgId: undefined });
      await turn.arrive();
      await turn.start();
      await refused(turn.exec());
    });
  });

  describe("tools and agents that get no token", () => {
    it.each(["process", "gateway_exec", "node_exec", "sandbox_process", "read", "message"])(
      "%s",
      async (toolName) => {
        const turn = plugin();
        await turn.arrive();
        await turn.start();
        const result = await turn.exec({ toolName }, { toolName, params: {} });
        expect(JSON.stringify(result ?? {})).not.toContain(TOKEN);
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it("code-mode exec, which runs no shell command", async () => {
      const turn = plugin();
      await turn.arrive();
      await turn.start();
      const result = await turn.exec(
        { toolKind: "code_mode_exec" },
        { toolKind: "code_mode_exec", params: { code: "1" } },
      );
      expect(JSON.stringify(result ?? {})).not.toContain(TOKEN);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(["cellect-main", "cellect-fi-user"])("%s", async (agentId) => {
      const session = `agent:${agentId}:slack:channel:c1`;
      const turn = plugin();
      await turn.arrive({ sessionKey: session });
      await turn.start({ agentId, sessionKey: session });
      const result = await turn.exec({ agentId, sessionKey: session });
      expect(JSON.stringify(result ?? {})).not.toContain(TOKEN);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("fails closed", () => {
    const answers: Array<[string, () => Promise<Response>]> = [
      ["no linked member (404)", async () => new Response("Not found", { status: 404 })],
      ["a refused credential (401)", async () => new Response("Unauthorized", { status: 401 })],
      ["a Fi error (500)", async () => new Response("boom", { status: 500 })],
      [
        "a throttle (429)",
        async () => new Response("Too many", { status: 429, headers: { "retry-after": "30" } }),
      ],
      [
        "an unreachable Fi",
        async () => {
          throw new Error(`connect failed for Bearer ${BROKER}`);
        },
      ],
      ["a body that is not JSON", async () => new Response("<html>", { status: 200 })],
      ["another organization's member", async () => minted({}, { orgId: "org-b" })],
      ["an answer naming no organization", async () => minted({}, { orgId: undefined })],
      ["a token about to expire", async () => minted({ expiresAt: Date.now() / 1000 + 59 })],
      ["a token with no expiry", async () => minted({ expiresAt: undefined })],
      ["a token that is not a JWT", async () => minted({ token: "one two\nFI_APP_URL=x" })],
      ["no token", async () => minted({ token: undefined })],
    ];

    it.each(answers)("on %s", async (_name, answer) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        fetchMock.mockImplementation(answer);
        const turn = plugin();
        await turn.arrive();
        await turn.start();
        const result = await turn.exec(
          {},
          {
            params: {
              command: "npm run fi:audit",
              env: { FI_DELEGATED_USER_TOKEN: "replayed", FI_APP_URL: "https://sandbox.test" },
            },
          },
        );
        // Nothing is set, nothing stands in for it, and the legacy path is as it was.
        expect(result?.params.env).toEqual({
          FI_ON_BEHALF_OF: expect.any(String),
          FI_APP_URL: "https://sandbox.test",
        });
        expect(JSON.stringify(result)).not.toContain(BROKER);
        const logged = JSON.stringify([turn.warn.mock.calls, consoleError.mock.calls]);
        expect(logged).not.toContain(BROKER);
        expect(logged).not.toContain(TOKEN);
      } finally {
        consoleError.mockRestore();
      }
    });

    it("drops a token Fi issued for a turn that ended or was joined while it answered", async () => {
      const turn = plugin();
      await turn.arrive();
      await turn.start();
      let answer!: (response: Response) => void;
      fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (answer = resolve)));
      const pending = turn.exec();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      await turn.arrive({ senderId: "U0OTHER002" });
      answer(minted());
      expect((await pending)?.params.env).not.toHaveProperty("FI_DELEGATED_USER_TOKEN");
    });

    it("drops a token for a call cancelled while Fi answered", async () => {
      const turn = plugin();
      await turn.arrive();
      await turn.start();
      const controller = new AbortController();
      fetchMock.mockImplementation(async () => {
        controller.abort();
        return minted();
      });
      const result = await turn.exec({ abortSignal: controller.signal });
      expect(result?.params.env).not.toHaveProperty("FI_DELEGATED_USER_TOKEN");
    });

    it("never logs the token it issues", async () => {
      const spies = (["info", "warn", "error", "log"] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation(() => undefined),
      );
      try {
        const turn = plugin();
        await turn.arrive();
        await turn.start();
        expect((await turn.exec())?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
        const logged = JSON.stringify([turn.warn.mock.calls, ...spies.map((s) => s.mock.calls)]);
        expect(logged).not.toContain(TOKEN);
        expect(logged).not.toContain(BROKER);
      } finally {
        for (const spy of spies) {
          spy.mockRestore();
        }
      }
    });
  });

  it("answers a model env that held only a forged token with an empty one", async () => {
    const turn = plugin();
    const result = await turn.exec(
      { agentId: "cellect-main", requester: { channel: "webchat", senderId: "ui" } },
      { params: { command: "true", env: { Fi_Delegated_User_Token: "forged" } } },
    );
    // Omitting env would let the host's merge hand the forged one back.
    expect(result?.params).toEqual({ command: "true", env: {} });
  });
});
