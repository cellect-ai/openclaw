import { sanitizeToolArgs } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  OpenClawPluginApi,
  PluginAgentEventSubscriptionRegistration,
} from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminActionSessions } from "./admin-action.js";
import { registerAdminDelegation } from "./admin-delegation.js";
import { configFromRuntime } from "./fi-delegation.js";
import fiUserPlugin from "./index.js";

const BROKER = "fixture-broker-credential";
const TOKEN = "fixtureheader.fixturepayload.fixturesignature";
const SESSION = "agent:cellect-fi-admin:slack:direct:u0admin001";
const MATRIX_SESSION = "agent:cellect-fi-admin:matrix:channel:!dm:matrix.example";
const AUTHORIZE_URL = "https://fi.example.test/fi/api/threads/agent-authorize";
/** A Matrix direct message from the admin, as the host reports it at each hook. */
const matrix = {
  arrive: {
    channel: "matrix",
    senderId: "@admin:matrix.example",
    sessionKey: MATRIX_SESSION,
    isGroup: false,
    messageId: "$event",
  },
  start: {
    channel: "matrix",
    senderId: "@admin:matrix.example",
    sessionKey: MATRIX_SESSION,
    accountId: "adminprod",
    chatId: "!dm:matrix.example",
    channelContext: {
      sender: { id: "@admin:matrix.example" },
      chat: { id: "!dm:matrix.example", eventId: "$event" },
    },
  },
  exec: {
    sessionKey: MATRIX_SESSION,
    requester: { channel: "matrix", senderId: "@admin:matrix.example", accountId: "adminprod" },
  },
};
const THREAD = "agent:cellect-fi-admin:matrix:channel:!room:matrix.example:thread:$root";
/** One message in a Matrix room thread, as the host reports it at each hook. */
const thread = (senderId = "@admin:matrix.example", eventId = "$e1") => ({
  arrive: { channel: "matrix", senderId, sessionKey: THREAD, isGroup: true, messageId: eventId },
  start: {
    channel: "matrix",
    senderId,
    sessionKey: THREAD,
    accountId: "adminprod",
    chatId: "!room:matrix.example",
    channelContext: { sender: { id: senderId }, chat: { id: "!room:matrix.example", eventId } },
  },
  exec: {
    sessionKey: THREAD,
    requester: { channel: "matrix", senderId, accountId: "adminprod" },
  },
});
const MINT_URL = "https://fi.example.test/fi/api/openclaw-user-delegation";
type Env = Record<string, string>;
type Rewrite =
  | { params: { env?: Env; host?: unknown; elevated?: unknown }; block?: boolean }
  | undefined;
type Middleware = (
  event: { toolName: string; result: unknown },
  context: { agentId?: string },
) => { result: unknown } | undefined;
const HELD = "Another admin's command is still finishing here. Try again in a few minutes.";
/** A runtime whose admin agent always runs in the sandbox, with elevation off. */
const SANDBOXED = {
  agents: { defaults: { sandbox: { mode: "all" as const } } },
  tools: { elevated: { enabled: false } },
};

function plugin(
  configOverrides: Record<string, unknown> = {},
  host: Record<string, unknown> = SANDBOXED,
) {
  const hooks = new Map<string, Array<(event: never, context: never) => unknown>>();
  const middlewares: Middleware[] = [];
  const subscriptions: PluginAgentEventSubscriptionRegistration[] = [];
  const warn = vi.fn();
  fiUserPlugin.register?.(
    createTestPluginApi({
      id: "fi-user",
      name: "Fi User Delegation",
      config: {
        ...host,
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
      registerAgentToolResultMiddleware: (handler) => middlewares.push(handler as Middleware),
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
    /** What the host shows of a tool result once the plugin's middleware has seen it. */
    result: (result: unknown, agentId = "cellect-fi-admin") =>
      middlewares.reduce(
        (current, middleware) =>
          middleware({ toolName: "exec", result: current }, { agentId })?.result ?? current,
        result,
      ),
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
const mints = () => fetchMock.mock.calls.filter(([url]) => url === MINT_URL);
const mintBody = () =>
  JSON.parse((mints()[0]![1] as { body: string }).body) as Record<string, string>;

beforeEach(() => {
  fetchMock.mockReset();
  // The Matrix admission gate asks Fi about the turn; everything else here is a mint.
  fetchMock.mockImplementation(async (url: string) =>
    url === AUTHORIZE_URL
      ? new Response(JSON.stringify({ ok: true, agentId: "cellect-fi-admin", orgId: "org-a" }))
      : minted(),
  );
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
    // The host is told where to run it, whatever its configured default or elevated level.
    expect(result?.params).toMatchObject({ host: "sandbox", elevated: false });
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
      expect(other?.params).not.toHaveProperty("host");
      expect(other?.params).not.toHaveProperty("elevated");
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
    const session = "agent:tenant-admin:slack:direct:u0admin001";
    const turn = plugin({ adminAgentId: "tenant-admin" });
    await turn.arrive({ sessionKey: session });
    await turn.start({ agentId: "tenant-admin", sessionKey: session });
    // The host and the config may spell the agent id in different case.
    const result = await turn.exec({
      agentId: "Tenant-Admin",
      sessionKey: "agent:Tenant-Admin:slack:direct:U0ADMIN001",
    });
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

  it("mints for a verified Matrix direct message, at the account's own Fi", async () => {
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
    const turn = plugin();
    await turn.arrive(matrix.arrive);
    await turn.start(matrix.start);
    const result = await turn.exec(matrix.exec);
    expect(result?.params).toMatchObject({
      host: "sandbox",
      elevated: false,
      env: { FI_DELEGATED_USER_TOKEN: TOKEN },
    });
    expect(mintBody()).toEqual({
      requesterMatrixUserId: "@admin:matrix.example",
      agentId: "cellect-fi-admin",
    });
  });

  describe("a Matrix room or thread, one message at a time", () => {
    const OTHER = "@other:matrix.example";
    const token = (result: Rewrite) => result?.params?.env?.FI_DELEGATED_USER_TOKEN;
    /** Fi answers for the person asked about: only the admin is one. */
    const fiKnowsOnlyTheAdmin = () =>
      fetchMock.mockImplementation(async (url: string, init: { body: string }) => {
        if (url === AUTHORIZE_URL) {
          return new Response(
            JSON.stringify({ ok: true, agentId: "cellect-fi-admin", orgId: "org-a" }),
          );
        }
        const asked = JSON.parse(init.body) as { requesterMatrixUserId?: string };
        return asked.requesterMatrixUserId === "@admin:matrix.example"
          ? minted()
          : new Response("Not found", { status: 404 });
      });
    beforeEach(() => {
      vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
    });

    it("mints for the run a verified admin's message started, pinned to the sandbox", async () => {
      const turn = plugin();
      const message = thread();
      await turn.arrive(message.arrive);
      await turn.start(message.start);
      const result = await turn.exec(message.exec);
      expect(result?.params).toMatchObject({
        host: "sandbox",
        elevated: false,
        env: { FI_DELEGATED_USER_TOKEN: TOKEN },
      });
      expect(mintBody()).toEqual({
        requesterMatrixUserId: "@admin:matrix.example",
        agentId: "cellect-fi-admin",
      });
    });

    it("gives the next run in the thread nothing of the first", async () => {
      vi.useFakeTimers();
      try {
        fiKnowsOnlyTheAdmin();
        const turn = plugin();
        const first = thread();
        await turn.arrive(first.arrive);
        await turn.start(first.start);
        expect(token(await turn.exec(first.exec))).toBe(TOKEN);
        await turn.settle();

        // Someone else, equally verified by the homeserver, writes next. The
        // sandbox still holds the admin's token, so their commands wait.
        const second = thread(OTHER, "$e2");
        await turn.arrive(second.arrive);
        await turn.start({ ...second.start, runId: "run-2" });
        fetchMock.mockClear();
        expect(await turn.exec({ ...second.exec, runId: "run-2" })).toEqual({
          block: true,
          blockReason: HELD,
        });
        // Neither the admin's name on their run nor the admin's settled run gets further.
        for (const stale of [
          { ...first.exec, runId: "run-2" },
          { ...first.exec, runId: "run-1" },
          { ...second.exec, runId: "run-1" },
        ]) {
          const result = await turn.exec(stale);
          expect(result?.block).toBe(true);
          expect(JSON.stringify(result)).not.toContain(TOKEN);
        }
        expect(mints()).toEqual([]);

        // Once the admin's token has expired they are asked about on their own, and refused.
        vi.advanceTimersByTime(10 * 60 * 1000 + 1);
        const theirs = await turn.exec({ ...second.exec, runId: "run-2" });
        expect(theirs?.params.env).toEqual({ FI_ON_BEHALF_OF: expect.any(String) });
        expect(theirs?.params).not.toHaveProperty("host");
        expect(mints()).toHaveLength(1);
        expect(mintBody().requesterMatrixUserId).toBe(OTHER);

        // The admin's own next message is a new run with a new token.
        await turn.settle("run-2");
        const third = thread("@admin:matrix.example", "$e3");
        await turn.arrive(third.arrive);
        await turn.start({ ...third.start, runId: "run-3" });
        expect(token(await turn.exec({ ...third.exec, runId: "run-3" }))).toBe(TOKEN);
      } finally {
        vi.useRealTimers();
      }
    });

    it("requires the run's own sender to be the one the message proved", async () => {
      // The Matrix admission gate refuses such a run first; this is the token rule alone.
      const admit = async (runSender: string) => {
        let onRun!: (event: unknown, context: unknown) => unknown;
        const api = createTestPluginApi({
          config: {
            ...SANDBOXED,
            plugins: {
              entries: {
                "fi-user": {
                  config: {
                    baseUrl: "https://fi.example.test/fi/",
                    brokerTokenEnv: "FIXTURE_BROKER",
                    tenantOrgId: "org-a",
                  },
                },
              },
            },
          },
          on: (_name, handler) => (onRun = handler as typeof onRun),
        });
        const delegation = registerAdminDelegation(api);
        const message = thread();
        delegation.dispatched({ ...message.arrive, senderAuthentication: "verified" as const });
        await onRun(
          {},
          {
            ...message.start,
            runId: "run-1",
            agentId: "cellect-fi-admin",
            trigger: "user",
            channelContext: {
              sender: { id: runSender },
              chat: { id: "!room:matrix.example", eventId: "$e1" },
            },
          },
        );
        return delegation.mint(
          configFromRuntime(api),
          { toolName: "exec", params: { command: "npm run fi:audit" } },
          { ...message.exec, runId: "run-1", agentId: "cellect-fi-admin", toolName: "exec" },
          Date.now(),
        );
      };
      expect(await admit(OTHER)).toBeUndefined();
      expect(mints()).toEqual([]);
      expect(await admit("@admin:matrix.example")).toBe(TOKEN);
    });

    it("ends the admin's run when someone else writes into the thread", async () => {
      const turn = plugin();
      const message = thread();
      await turn.arrive(message.arrive);
      await turn.start(message.start);
      await turn.arrive(thread(OTHER, "$e2").arrive);
      expect(token(await turn.exec(message.exec))).toBeUndefined();
      expect(mints()).toEqual([]);
    });

    it.each([
      ["nobody verified", { senderAuthentication: undefined }],
      ["another party named", { senderAuthentication: "asserted" }],
    ])("gives nothing for a sender %s", async (_name, arrival) => {
      const turn = plugin();
      const message = thread();
      await turn.arrive({ ...message.arrive, ...arrival });
      await turn.start(message.start);
      expect(token(await turn.exec(message.exec))).toBeUndefined();
      expect(mints()).toEqual([]);
    });

    const origin = (sender: Record<string, unknown>, eventId: string) => ({
      channelContext: {
        sender: { id: "@admin:matrix.example", ...sender },
        chat: { id: "!room:matrix.example", eventId },
      },
    });
    it.each([
      ["a cron run", { trigger: "cron" }],
      ["a heartbeat", { trigger: "heartbeat" }],
      ["a system event", { trigger: "system" }],
      ["a run the host started for another event", origin({}, "$e0")],
      ["a run a configured bot account started", origin({ isBot: true }, "$e1")],
    ])("gives nothing to %s, even after the admin's message", async (_name, run) => {
      const turn = plugin();
      const message = thread();
      await turn.arrive(message.arrive);
      await turn.start({ ...message.start, ...run });
      expect(token(await turn.exec(message.exec))).toBeUndefined();
      expect(mints()).toEqual([]);
    });

    it("gives nothing to a run no message started: resumed, tool-injected, agent-to-agent", async () => {
      const turn = plugin();
      const message = thread();
      // The host stamps a stored sender and event on such a run; nothing arrived for it.
      await turn.start(message.start);
      expect(token(await turn.exec(message.exec))).toBeUndefined();
      // Nor does input injected without a dispatch prove anyone.
      await turn.settle();
      await turn.inject(message.arrive);
      await turn.start({ ...message.start, runId: "run-2" });
      expect(token(await turn.exec({ ...message.exec, runId: "run-2" }))).toBeUndefined();
      expect(mints()).toEqual([]);
    });

    it.each([403, 404])(
      "treats Fi's refusal (%i) as no token and says only that",
      async (status) => {
        fetchMock.mockImplementation(async (url: string) =>
          url === AUTHORIZE_URL
            ? new Response(
                JSON.stringify({ ok: true, agentId: "cellect-fi-admin", orgId: "org-a" }),
              )
            : new Response(`@admin:matrix.example is not an admin of org-a`, { status }),
        );
        const turn = plugin();
        const message = thread();
        await turn.arrive(message.arrive);
        await turn.start(message.start);
        const result = await turn.exec(message.exec);
        // The command still runs, with the attribution it always had.
        expect(result?.params.env).toEqual({ FI_ON_BEHALF_OF: expect.any(String) });
        expect(result?.params).not.toHaveProperty("host");
        expect(mints()).toHaveLength(1);
        // "Not a member" is an ordinary answer; any other refusal is logged by status alone.
        expect(turn.warn.mock.calls).toEqual(
          status === 404 ? [] : [[`fi-user: admin delegation not issued (status ${status})`]],
        );
      },
    );

    it("gives nothing in a room Fi places in another organization", async () => {
      fetchMock.mockImplementation(async (url: string) =>
        url === AUTHORIZE_URL
          ? new Response(JSON.stringify({ ok: true, agentId: "cellect-fi-admin", orgId: "org-b" }))
          : minted(),
      );
      const turn = plugin();
      const message = thread();
      await turn.arrive(message.arrive);
      await turn.start(message.start);
      const result = await turn.exec(message.exec);
      expect(result).toMatchObject({ block: true });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(mints()).toEqual([]);
    });

    it.each([
      ["a Slack channel", "slack", "agent:cellect-fi-admin:slack:channel:c1", "U0ADMIN001"],
      [
        "a Slack thread",
        "slack",
        "agent:cellect-fi-admin:slack:channel:c1:thread:1.2",
        "U0ADMIN001",
      ],
      ["a Discord channel", "discord", "agent:cellect-fi-admin:discord:channel:1", "1234567890"],
    ])("does not extend to %s", async (_name, channel, sessionKey, senderId) => {
      const turn = plugin();
      await turn.arrive({ channel, sessionKey, senderId, isGroup: true, messageId: "$e1" });
      await turn.start({
        channel,
        sessionKey,
        senderId,
        channelContext: { sender: { id: senderId }, chat: { eventId: "$e1" } },
      });
      const result = await turn.exec({ sessionKey, requester: { channel, senderId } });
      expect(JSON.stringify(result ?? {})).not.toContain(TOKEN);
      expect(mints()).toEqual([]);
    });
  });

  it("admits a Matrix direct message only for the run of that very event", async () => {
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
    const turn = plugin();
    await turn.arrive(matrix.arrive);
    await turn.start({
      ...matrix.start,
      channelContext: {
        sender: { id: "@admin:matrix.example" },
        chat: { id: "!dm:matrix.example", eventId: "$another" },
      },
    });
    expect((await turn.exec(matrix.exec))?.params.env).not.toHaveProperty(
      "FI_DELEGATED_USER_TOKEN",
    );
    expect(mints()).toEqual([]);
  });

  describe("a runtime where the sandbox pin would change how commands run", () => {
    const admin = (entry: Record<string, unknown>) => ({
      ...SANDBOXED,
      agents: { ...SANDBOXED.agents, list: [{ id: "cellect-fi-admin", ...entry }] },
    });
    it.each([
      ["no sandbox configured", { tools: SANDBOXED.tools }],
      [
        "only non-main sessions sandboxed",
        { ...SANDBOXED, agents: { defaults: { sandbox: { mode: "non-main" } } } },
      ],
      ["the admin agent's own sandbox off", admin({ sandbox: { mode: "off" } })],
      [
        "commands on the Gateway",
        { ...SANDBOXED, tools: { ...SANDBOXED.tools, exec: { host: "gateway" } } },
      ],
      ["the admin agent's commands on a node", admin({ tools: { exec: { host: "node" } } })],
      ["elevation left at its default", { agents: SANDBOXED.agents }],
      ["elevation switched on", { ...SANDBOXED, tools: { elevated: { enabled: true } } }],
      ["Talk owned by the admin agent", { ...SANDBOXED, talk: { agentId: "Cellect-Fi-Admin" } }],
    ])("issues nothing and pins nothing with %s", async (_name, host) => {
      const turn = plugin({}, host);
      await turn.arrive();
      await turn.start();
      const result = await turn.exec({}, { params: { command: "npm run fi:audit" } });
      // Exactly what the command got before there was a token.
      expect(result?.params).toEqual({
        command: "npm run fi:audit",
        env: { FI_ON_BEHALF_OF: expect.any(String) },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      [
        "the sandbox named as the exec host",
        { ...SANDBOXED, tools: { ...SANDBOXED.tools, exec: { host: "sandbox" } } },
      ],
      [
        "the admin agent's own settings over looser defaults",
        {
          agents: {
            defaults: { sandbox: { mode: "off" } },
            list: [
              {
                id: "cellect-fi-admin",
                sandbox: { mode: "all", scope: "session" },
                tools: { exec: { host: "auto" }, elevated: { enabled: false } },
              },
            ],
          },
          tools: { exec: { host: "gateway" } },
          talk: { agentId: "cellect-main" },
        },
      ],
    ])("issues with %s", async (_name, host) => {
      const turn = plugin({}, host);
      await turn.arrive();
      await turn.start();
      expect((await turn.exec())?.params).toMatchObject({
        host: "sandbox",
        elevated: false,
        env: { FI_DELEGATED_USER_TOKEN: TOKEN },
      });
    });
  });

  describe("the time Fi is given to answer", () => {
    /** A Matrix turn whose grant check takes `ms` of the hook's deadline before Fi is asked. */
    const afterGrantCheck = async (ms: number) => {
      vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
      const timeout = vi.spyOn(AbortSignal, "timeout");
      const turn = plugin();
      await turn.arrive(matrix.arrive);
      await turn.start(matrix.start);
      fetchMock.mockImplementation(async (url: string) => {
        if (url !== AUTHORIZE_URL) {
          return minted();
        }
        vi.advanceTimersByTime(ms);
        return new Response(
          JSON.stringify({ ok: true, agentId: "cellect-fi-admin", orgId: "org-a" }),
        );
      });
      timeout.mockClear();
      const result = await turn.exec(matrix.exec);
      return { result, budgets: timeout.mock.calls.map(([budget]) => budget) };
    };
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("is at most eight seconds", async () => {
      const { result, budgets } = await afterGrantCheck(0);
      expect(result?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
      expect(budgets).toEqual([12_000, 8_000]);
    });

    it("is what the grant check left of thirteen seconds", async () => {
      const { result, budgets } = await afterGrantCheck(9_000);
      expect(result?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
      expect(budgets).toEqual([12_000, 4_000]);
    });

    it("is not spent when under half a second is left: the command runs without a token", async () => {
      const { result, budgets } = await afterGrantCheck(12_501);
      expect(result?.block).toBeUndefined();
      expect(result?.params.env).not.toHaveProperty("FI_DELEGATED_USER_TOKEN");
      expect(result?.params).not.toHaveProperty("host");
      expect(budgets).toEqual([12_000]);
      expect(mints()).toEqual([]);
    });
  });

  describe("a sandbox that holds someone's token", () => {
    const OTHER_SESSION = "agent:cellect-fi-admin:slack:direct:u0other002";
    const other = { sessionKey: OTHER_SESSION, senderId: "U0OTHER002" };
    const otherExec = {
      runId: "run-2",
      sessionKey: OTHER_SESSION,
      requester: { channel: "slack", senderId: "U0OTHER002" },
    };
    /** The admin's command has run with a token; someone else's verified turn then starts. */
    const afterAdminsCommand = async (host: Record<string, unknown> = SANDBOXED) => {
      const turn = plugin({}, host);
      await turn.arrive();
      await turn.start();
      expect((await turn.exec())?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
      await turn.arrive(other);
      await turn.start({ ...other, runId: "run-2" });
      fetchMock.mockClear();
      return turn;
    };
    afterEach(() => {
      vi.useRealTimers();
    });

    it.each([
      "exec",
      "sandbox_exec",
      "process",
      "sandbox_process",
      "read",
      "ls",
      "write",
      "edit",
      "apply_patch",
      "view_image",
    ])(
      "keeps another person's %s out of the agent's shared sandbox until the token expires",
      async (toolName) => {
        vi.useFakeTimers();
        const turn = await afterAdminsCommand();
        const call = () =>
          turn.exec({ ...otherExec, toolName }, { toolName, params: { command: "ls", path: "." } });
        expect(await call()).toEqual({ block: true, blockReason: HELD });
        expect(fetchMock).not.toHaveBeenCalled();
        vi.advanceTimersByTime(10 * 60 * 1000 + 1);
        expect((await call())?.block).toBeUndefined();
      },
    );

    it("keeps out a run nobody proved, and the owner's own run once someone else wrote into it", async () => {
      const turn = await afterAdminsCommand();
      await turn.start({ runId: "cron-1", trigger: "cron", senderId: undefined });
      expect(await turn.exec({ runId: "cron-1", requester: undefined })).toEqual({
        block: true,
        blockReason: HELD,
      });
      // The admin's first run is still theirs.
      expect((await turn.exec())?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
      await turn.arrive({ senderId: "U0OTHER002" });
      expect(await turn.exec()).toEqual({ block: true, blockReason: HELD });
    });

    it("leaves the owner's later runs and tools that do not reach the sandbox alone", async () => {
      const turn = await afterAdminsCommand();
      const message = await turn.exec(
        { ...otherExec, toolName: "message" },
        { toolName: "message", params: {} },
      );
      expect(message?.block).toBeUndefined();
      await turn.settle();
      await turn.arrive();
      await turn.start({ runId: "run-3" });
      expect((await turn.exec({ runId: "run-3" }))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(
        TOKEN,
      );
      const read = await turn.exec(
        { runId: "run-3", toolName: "read" },
        { toolName: "read", params: {} },
      );
      expect(read?.block).toBeUndefined();
    });

    it("holds only the session's own sandbox when sandboxes are per session", async () => {
      const turn = await afterAdminsCommand({
        ...SANDBOXED,
        agents: { defaults: { sandbox: { mode: "all", scope: "session" } } },
      });
      // Another session is another sandbox: Fi is asked about its own sender.
      expect((await turn.exec(otherExec))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
      // The admin's session stays theirs for a run nobody proved.
      await turn.start({ runId: "cron-1", trigger: "cron", senderId: undefined });
      expect(await turn.exec({ runId: "cron-1", requester: undefined })).toEqual({
        block: true,
        blockReason: HELD,
      });
    });

    it("does not hold a sandbox for a token Fi refused", async () => {
      fetchMock.mockImplementation(async () => new Response("Not found", { status: 404 }));
      const turn = plugin();
      await turn.arrive();
      await turn.start();
      expect((await turn.exec())?.params.env).not.toHaveProperty("FI_DELEGATED_USER_TOKEN");
      await turn.arrive(other);
      await turn.start({ ...other, runId: "run-2" });
      expect((await turn.exec(otherExec))?.block).toBeUndefined();
    });
  });

  describe("the issued token in what the host records", () => {
    const issue = async () => {
      const turn = plugin();
      await turn.arrive();
      await turn.start();
      const rewritten = await turn.exec();
      expect(rewritten?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
      return { turn, rewritten };
    };
    const LOOKALIKE = "another.fixture.token";

    it("is replaced in the admin agent's tool results, and nothing else is", async () => {
      const { turn } = await issue();
      const printed = {
        content: [
          {
            type: "text",
            text: `FI_DELEGATED_USER_TOKEN=${TOKEN}\nBearer ${TOKEN}; v1.2.3 ${LOOKALIKE}`,
          },
          { type: "image", data: "aGVsbG8=" },
        ],
        details: { status: "completed", aggregated: `{"token":"${TOKEN}"}`, exitCode: 0 },
      };
      const shown = turn.result(printed);
      expect(JSON.stringify(shown)).not.toContain(TOKEN);
      expect(shown).toEqual({
        content: [
          {
            type: "text",
            text: `FI_DELEGATED_USER_TOKEN=[redacted Fi token]\nBearer [redacted Fi token]; v1.2.3 ${LOOKALIKE}`,
          },
          { type: "image", data: "aGVsbG8=" },
        ],
        details: {
          status: "completed",
          aggregated: '{"token":"[redacted Fi token]"}',
          exitCode: 0,
        },
      });
      // A result without it is handed back as it came.
      const clean = { content: [{ type: "text", text: `ok ${LOOKALIKE}` }], details: {} };
      expect(turn.result(clean)).toBe(clean);
      // Another agent's results are not this plugin's to rewrite.
      expect(turn.result(printed, "cellect-main")).toBe(printed);
    });

    it("leaves results alone before any token was issued", () => {
      const turn = plugin();
      const printed = { content: [{ type: "text", text: TOKEN }], details: {} };
      expect(turn.result(printed)).toBe(printed);
    });

    it("is masked by the host wherever it records the rewritten call's arguments", async () => {
      const { rewritten } = await issue();
      // Tool-start events, the trajectory, CLI and worker events all pass through this.
      const recorded = JSON.stringify(sanitizeToolArgs(rewritten?.params));
      expect(recorded).not.toContain(TOKEN);
      expect(recorded).toContain("npm run fi:audit");
    });
  });

  describe("what arrived and was never run", () => {
    it("is forgotten oldest first, without switching issuing off", async () => {
      const turn = plugin();
      // More sessions than are remembered, each with a message no run took up.
      for (let index = 0; index <= 5_000; index += 1) {
        await turn.arrive({
          sessionKey: `agent:cellect-fi-admin:slack:direct:u0flood${index}`,
          senderId: `U0FLOOD${index}`,
        });
      }
      await turn.arrive();
      await turn.start();
      expect((await turn.exec())?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
      expect(turn.warn).not.toHaveBeenCalled();
    });

    it("no longer admits a run six hours later", async () => {
      vi.useFakeTimers();
      try {
        const turn = plugin();
        await turn.arrive();
        vi.advanceTimersByTime(6 * 60 * 60 * 1000);
        await turn.start();
        expect((await turn.exec())?.params.env).not.toHaveProperty("FI_DELEGATED_USER_TOKEN");
        expect(mints()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
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
      const params = (await result)?.params;
      const env = params?.env ?? {};
      expect(env).not.toHaveProperty("FI_DELEGATED_USER_TOKEN");
      expect(env).not.toHaveProperty("FI_APP_URL");
      // No token, no pin: the call runs as it always did.
      expect(params ?? {}).not.toHaveProperty("host");
      expect(params ?? {}).not.toHaveProperty("elevated");
      expect(mints()).toEqual([]);
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

    it.each([
      ["a Matrix sender nobody verified", { senderAuthentication: undefined }],
      ["a Matrix sender another party named", { senderAuthentication: "asserted" }],
      ["a Matrix room message that names no event", { isGroup: true, messageId: undefined }],
      ["a Matrix direct message that names no event", { messageId: undefined }],
      ["a Matrix conversation of unreported kind", { isGroup: undefined }],
    ])("%s", async (_name, arrival) => {
      vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
      const turn = plugin();
      await turn.arrive({ ...matrix.arrive, ...arrival });
      await turn.start(matrix.start);
      await refused(turn.exec(matrix.exec));
    });

    it("a Matrix account with no configured Fi environment", async () => {
      vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "staging" }));
      const turn = plugin();
      await turn.arrive(matrix.arrive);
      await turn.start(matrix.start);
      expect(JSON.stringify(await turn.exec(matrix.exec))).not.toContain(TOKEN);
      expect(mints()).toEqual([]);
    });

    it.each([
      ["a Slack channel", "agent:cellect-fi-admin:slack:channel:c1"],
      ["a Slack thread", "agent:cellect-fi-admin:slack:channel:c1:thread:1.2"],
      ["someone else's Slack direct session", "agent:cellect-fi-admin:slack:direct:u0other002"],
      ["a Slack sender in a Matrix-keyed session", MATRIX_SESSION],
    ])("%s: other people's words reach the agent undispatched", async (_name, sessionKey) => {
      const turn = plugin();
      await turn.arrive({ sessionKey, isGroup: false });
      await turn.start({ sessionKey });
      await refused(turn.exec({ sessionKey }));
    });

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

    it("costs the owner one turn after someone else's message hours ago, then recovers", async () => {
      vi.useFakeTimers();
      try {
        const turn = plugin();
        await turn.arrive({ senderId: "U0OTHER002" });
        vi.advanceTimersByTime(5 * 60 * 60 * 1000);
        await turn.arrive();
        await turn.start();
        await refused(turn.exec());
        await turn.settle();
        await turn.arrive();
        await turn.start({ runId: "run-2" });
        expect((await turn.exec({ runId: "run-2" }))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(
          TOKEN,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("a second attempt of the same run does not take up what arrived after it began", async () => {
      const turn = plugin();
      await turn.start({ runId: "busy", senderId: "U0OTHER002" });
      await turn.arrive({ senderId: "U0OTHER002" });
      // A fallback attempt of the busy run reports itself again.
      await turn.start({ runId: "busy", senderId: "U0OTHER002" });
      await turn.arrive();
      await turn.start();
      await refused(turn.exec());
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
      ["a terminal", { command: "x", pty: true }],
      ["a command sent to the background", { command: "x", background: true }],
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
      const session = `agent:${agentId}:slack:direct:u0admin001`;
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
