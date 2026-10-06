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
    /** Input the host accepts for the session without dispatching it: an injection into a run. */
    inject: (overrides: Record<string, unknown> = {}) =>
      hook(
        "message_received",
        { from: "x", content: "also do this", senderId: "U0ADMIN001", ...overrides },
        { channelId: overrides.channel ?? "slack", sessionKey: overrides.sessionKey ?? SESSION },
      ),
    /** A message the host receives and then dispatches to the session. */
    arrive: async (overrides: Record<string, unknown> = {}) => {
      await hook(
        "message_received",
        { from: "x", content: "run the audit", senderId: "U0ADMIN001", ...overrides },
        { channelId: overrides.channel ?? "slack", sessionKey: overrides.sessionKey ?? SESSION },
      );
      return hook(
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
      );
    },
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
  it("gives a verified requester's exec their own token", async () => {
    const turn = plugin();
    await turn.arrive();
    await turn.start();
    const result = await turn.exec(
      {},
      {
        params: {
          command: "npm run fi:audit --as U0SOMEONE9",
          env: { KEEP: "1", fi_delegated_user_token: "forged", REQUESTER: "U0SOMEONE9" },
        },
      },
    );
    // FI_APP_URL is the sandbox's own: nothing is set for it.
    expect(result?.params.env).toEqual({
      KEEP: "1",
      REQUESTER: "U0SOMEONE9",
      FI_ON_BEHALF_OF: expect.any(String),
      FI_DELEGATED_USER_TOKEN: TOKEN,
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

  it("withholds the token from a call that names another Fi, and leaves its env alone", async () => {
    const turn = plugin();
    await turn.arrive();
    await turn.start();
    const same = await turn.exec(
      {},
      { params: { command: "x", env: { Fi_App_Url: "https://fi.example.test/fi//" } } },
    );
    expect(same?.params.env).toEqual({
      Fi_App_Url: "https://fi.example.test/fi//",
      FI_ON_BEHALF_OF: expect.any(String),
      FI_DELEGATED_USER_TOKEN: TOKEN,
    });
    fetchMock.mockClear();
    for (const url of ["https://evil.test", "https://fi.example.test", 7]) {
      const other = await turn.exec(
        {},
        { params: { command: "x", env: { FI_APP_URL: url, FI_DELEGATED_USER_TOKEN: "forged" } } },
      );
      expect(other?.params.env).toEqual({ FI_APP_URL: url, FI_ON_BEHALF_OF: expect.any(String) });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("covers sandbox_exec and asks Fi afresh for every call", async () => {
    const turn = plugin();
    await turn.arrive();
    await turn.start();
    fetchMock.mockImplementationOnce(async () => minted({ token: "first.fixture.token" }));
    const first = await turn.exec({ toolName: "sandbox_exec" }, { toolName: "sandbox_exec" });
    const second = await turn.exec({}, { params: { command: "x", host: "sandbox" } });
    expect(first?.params.env?.FI_DELEGATED_USER_TOKEN).toBe("first.fixture.token");
    expect(second?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses this runtime's own admin agent id with Fi's protocol name", async () => {
    const session = "agent:tenant-admin:slack:channel:c1";
    const turn = plugin({ adminAgentId: "tenant-admin" });
    await turn.arrive({ sessionKey: session });
    await turn.start({ agentId: "tenant-admin", sessionKey: session });
    // The host and the config may spell the agent id in different case.
    const result = await turn.exec({ agentId: "Tenant-Admin", sessionKey: session });
    // No legacy assertion for an agent Fi's on-behalf-of does not know; the token alone.
    expect(result?.params.env).toEqual({ FI_DELEGATED_USER_TOKEN: TOKEN });
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
    await turn.arrive({ ...matrix, sessionKey: session });
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

  it("leaves an approved admin action with today's attribution only", async () => {
    const sessionKey = "agent:cellect-fi-admin:admin-action:zzz222";
    adminActionSessions.set(sessionKey, {
      id: "ZZZ222",
      task: "external_share_link",
      fields: {},
      requester: {
        email: "member@example.com",
        identity: { channel: "slack", requesterSenderId: "U0MEMBER01" },
      },
      createdAt: Date.now(),
      status: "approved",
    });
    try {
      const turn = plugin();
      // Even a turn that would otherwise be admitted on that session.
      await turn.arrive({ sessionKey });
      await turn.start({ sessionKey });
      const result = await turn.exec({ sessionKey });
      expect(result?.params.env).toEqual({ FI_ON_BEHALF_OF: expect.any(String) });
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

    it.each(["asserted", undefined])(
      "a Matrix sender the homeserver path did not stamp: %s",
      async (authentication) => {
        const matrix = { channel: "matrix", senderId: "@admin:matrix.example" };
        vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
        const session = "agent:cellect-fi-admin:slack:matrix-linked";
        const turn = plugin();
        await turn.arrive({ ...matrix, sessionKey: session, senderAuthentication: authentication });
        await turn.start({ ...matrix, sessionKey: session });
        await refused(
          turn.exec({ sessionKey: session, requester: { ...matrix, accountId: "adminprod" } }),
        );
      },
    );

    it("a message queued behind a long run and collected with the owner's much later", async () => {
      vi.useFakeTimers();
      try {
        const turn = plugin();
        await turn.arrive();
        await turn.start();
        // Someone else posts while the run is busy: queued, and it ends this run's admission.
        await turn.arrive({ senderId: "U0OTHER002" });
        vi.advanceTimersByTime(45 * 60 * 1000);
        await turn.arrive();
        await turn.settle();
        // The host collects both under the last item's sender.
        await turn.start({ runId: "run-2" });
        await refused(turn.exec({ runId: "run-2" }));
      } finally {
        vi.useRealTimers();
      }
    });

    it("a run that only a heartbeat separated from someone else's queued message", async () => {
      const turn = plugin();
      await turn.arrive({ senderId: "U0OTHER002" });
      await turn.start({ runId: "beat", trigger: "heartbeat", senderId: undefined });
      await turn.settle("beat");
      await turn.arrive();
      await turn.start();
      await refused(turn.exec());
    });

    it("a run that takes input injected without a dispatch", async () => {
      const turn = plugin();
      await turn.arrive();
      await turn.start();
      await turn.inject({ channel: "webchat", senderId: "operator-ui" });
      await refused(turn.exec());
    });

    it("a turn after an undispatched input nobody proved", async () => {
      const turn = plugin();
      await turn.inject({ senderId: "U0OTHER002" });
      await turn.arrive();
      await turn.start();
      await refused(turn.exec());
      // The same person's own undispatched input alone proves nothing either.
      await turn.settle();
      await turn.inject();
      await turn.start({ runId: "run-2" });
      await refused(turn.exec({ runId: "run-2" }));
    });

    it("a session a Talk consult has run on, from then on", async () => {
      const turn = plugin();
      await turn.arrive();
      await turn.start();
      await turn.start({
        runId: "consult",
        channel: "matrix",
        senderId: "@admin:matrix.example",
        channelContext: { chat: { id: "!r:matrix.example", talkThreadRootEventId: "$root" } },
      });
      await refused(turn.exec());
      await turn.settle();
      await turn.settle("consult");
      await turn.arrive();
      await turn.start({ runId: "run-2" });
      await refused(turn.exec({ runId: "run-2" }));
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

    it("forgets a steered message once the session has been idle, so the owner is not held back", async () => {
      vi.useFakeTimers();
      try {
        const turn = plugin();
        await turn.arrive();
        await turn.start();
        await turn.arrive({ senderId: "U0OTHER002" });
        vi.advanceTimersByTime(45 * 60 * 1000);
        // Idle is counted from the end of the run, not from the message.
        await turn.settle();
        vi.advanceTimersByTime(29 * 60 * 1000);
        await turn.arrive();
        await turn.start({ runId: "run-2" });
        await refused(turn.exec({ runId: "run-2" }));
        await turn.settle("run-2");
        await turn.arrive({ senderId: "U0OTHER002" });
        vi.advanceTimersByTime(31 * 60 * 1000);
        await turn.arrive();
        await turn.start({ runId: "run-3" });
        expect((await turn.exec({ runId: "run-3" }))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(
          TOKEN,
        );
      } finally {
        vi.useRealTimers();
      }
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
    it.each(["process", "sandbox_process", "read", "message"])("%s", async (toolName) => {
      const turn = plugin();
      await turn.arrive();
      await turn.start();
      const result = await turn.exec({ toolName }, { toolName, params: {} });
      expect(JSON.stringify(result ?? {})).not.toContain(TOKEN);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    // Codex's gateway_exec and node_exec reach the hook as `exec` with the host pinned;
    // a harness's native shell reaches it as `exec` with its own parameters.
    it.each([
      ["gateway_exec", { command: "x", host: "gateway" }],
      ["node_exec", { command: "x", host: "node", node: "build-1" }],
      ["a node named without a host", { command: "x", node: "build-1" }],
      ["an inherited host", { command: "x", host: "auto" }],
      ["an elevated command", { command: "x", elevated: true }],
      ["Claude Code's native Bash", { command: "x", description: "run x", timeout: 1000 }],
      ["Codex's native shell", { command: ["bash", "-lc", "x"], workdir: "/w" }],
    ])("%s", async (_name, params) => {
      const turn = plugin();
      await turn.arrive();
      await turn.start();
      const result = await turn.exec({}, { params });
      expect(result?.params.env).toEqual({ FI_ON_BEHALF_OF: expect.any(String) });
      expect(fetchMock).not.toHaveBeenCalled();
    });

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
              env: {
                FI_DELEGATED_USER_TOKEN: "replayed",
                FI_APP_URL: "https://fi.example.test/fi",
              },
            },
          },
        );
        // Nothing is set, nothing stands in for it, and the legacy path is as it was.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result?.params.env).toEqual({
          FI_ON_BEHALF_OF: expect.any(String),
          FI_APP_URL: "https://fi.example.test/fi",
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
