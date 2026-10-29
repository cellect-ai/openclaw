import type {
  OpenClawPluginApi,
  PluginAgentEventSubscriptionRegistration,
  PluginJsonValue,
} from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, vi } from "vitest";
import fiUserPlugin from "./index.js";
export const BROKER = "fixture-broker-credential";
export const TOKEN = "fixtureheader.fixturepayload.fixturesignature";
export const SESSION = "agent:cellect-fi-admin:slack:direct:u0admin001";
export const MATRIX_SESSION = "agent:cellect-fi-admin:matrix:channel:!dm:matrix.example";
export const AUTHORIZE_URL = "https://fi.example.test/fi/api/threads/agent-authorize";
/** A Matrix direct message from the admin, as the host reports it at each hook. */
export const matrix = {
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
export const THREAD = "agent:cellect-fi-admin:matrix:channel:!room:matrix.example:thread:$root";
/** One message in a Matrix room thread, as the host reports it at each hook. */
export const thread = (senderId = "@admin:matrix.example", eventId = "$e1") => ({
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
export const MINT_URL = "https://fi.example.test/fi/api/openclaw-user-delegation";
export const SLACK_CHANNEL = "C0CHANNEL1";
export const SLACK_THREAD =
  "agent:cellect-fi-admin:slack:channel:c0channel1:thread:1792189039.487369";
export const slackThread = (sessionKey = SLACK_THREAD) => ({
  arrive: {
    channel: "slack",
    senderId: "U0ADMIN001",
    sessionKey,
    isGroup: true,
    messageId: "1792190933.152459",
  },
  start: {
    channel: "slack",
    senderId: "U0ADMIN001",
    sessionKey,
    channelContext: {
      sender: { id: "U0ADMIN001" },
      chat: { id: SLACK_CHANNEL, eventId: "1792190933.152459" },
    },
  },
  exec: { sessionKey, requester: { channel: "slack", senderId: "U0ADMIN001" } },
});
export type Env = Record<string, string>;
export type Rewrite =
  | { params: { env?: Env; host?: unknown; elevated?: unknown }; block?: boolean }
  | undefined;
export const HELD =
  "This sandbox still holds another requester's command state. Retry after its requester token expires.";
/** A runtime whose admin agent always runs in the sandbox, with elevation off. */
export const SANDBOXED = {
  agents: { defaults: { sandbox: { mode: "all" as const } } },
  tools: { elevated: { enabled: false } },
};

export function plugin(
  configOverrides: Record<string, unknown> = {},
  host: Record<string, unknown> = SANDBOXED,
) {
  const hooks = new Map<string, Array<(event: never, context: never) => unknown>>();
  const middleware = vi.fn();
  const subscriptions: PluginAgentEventSubscriptionRegistration[] = [];
  const warn = vi.fn();
  const info = vi.fn();
  const runContexts = new Map<string, PluginJsonValue>();
  const runtimeContexts = vi.fn();
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
      logger: { info, warn, error: vi.fn(), debug: vi.fn() },
      runContext: {
        getRunContext: ({ runId, namespace }) => runContexts.get(`${runId}:${namespace}`),
        setRunContext: ({ runId, namespace, value }) => {
          if (value === undefined) {
            return false;
          }
          runContexts.set(`${runId}:${namespace}`, value);
          return true;
        },
        clearRunContext: ({ runId, namespace }) => {
          for (const key of runContexts.keys()) {
            if (namespace ? key === `${runId}:${namespace}` : key.startsWith(`${runId}:`)) {
              runContexts.delete(key);
            }
          }
        },
      },
      runtime: {
        channel: { runtimeContexts: { register: runtimeContexts } },
      } as unknown as OpenClawPluginApi["runtime"],
      on: (name, handler) => hooks.set(name, [...(hooks.get(name) ?? []), handler as never]),
      registerAgentEventSubscription: (subscription) => subscriptions.push(subscription),
      registerAgentToolResultMiddleware: middleware,
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
    info,
    diagnosticRunContextSize: () => runContexts.size,
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
    /** The context the plugin registered for one channel capability. */
    runtimeContext: (channelId: string, capability: string) =>
      (
        runtimeContexts.mock.calls as Array<
          [{ channelId: string; capability: string; context: unknown }]
        >
      ).find(([entry]) => entry.channelId === channelId && entry.capability === capability)?.[0]
        .context,
    /** What the plugin registered with the host. */
    registered: () => ({
      hooks: [...hooks].flatMap(([name, handlers]) => handlers.map(() => name)).toSorted(),
      subscriptions: subscriptions.map((subscription) => subscription.id).toSorted(),
      middleware: middleware.mock.calls.length,
    }),
    settle: async (runId = "run-1") => {
      for (const subscription of subscriptions) {
        await subscription.handle(
          { runId, data: { phase: "end", executionSettled: true } } as never,
          {} as never,
        );
      }
    },
    cleanup: async (overrides: Record<string, unknown> = {}) => {
      for (const subscription of subscriptions) {
        if (!subscription.streams?.includes("sandbox_process")) {
          continue;
        }
        await subscription.handle(
          {
            runId: "run-1",
            stream: "sandbox_process",
            data: {
              phase: "cleanup-complete",
              toolCallId: "command-1",
              agentId: "cellect-fi-admin",
              sessionKey: SESSION,
              ...overrides,
            },
          } as never,
          {} as never,
        );
      }
    },
  };
}

export const fetchMock = vi.fn();
export const minted = (fi: Record<string, unknown> = {}, user: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      ok: true,
      user: { email: "admin@example.com", orgSlug: "a", orgId: "org-a", role: "admin", ...user },
      fi: { token: TOKEN, expiresAt: Math.floor(Date.now() / 1000) + 600, ...fi },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
export const mints = () => fetchMock.mock.calls.filter(([url]) => url === MINT_URL);
export const mintBody = () =>
  JSON.parse((mints()[0]![1] as { body: string }).body) as Record<string, string>;

export function installDelegationFixtures() {
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
}
