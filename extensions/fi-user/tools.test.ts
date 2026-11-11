import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  sendMedia: vi.fn(),
  sendText: vi.fn(),
  subagentRun: vi.fn(),
  waitForRun: vi.fn(),
  getSessionMessages: vi.fn(),
}));

vi.mock("node:util", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:util")>()),
  promisify: () => mocks.execFile,
}));
vi.mock("openclaw/plugin-sdk/document-extractor", () => ({ extractDocumentContent: vi.fn() }));

import { approvalStores } from "./admin-action.test-support.js";
import { FI_USER_API_SHADOW_READ_ROUTES, fiUserApiPath } from "./fi-api-tool.js";
import { rememberWebchatContext } from "./fi-delegation.js";
import fiUserPlugin from "./index.js";
import { offersMailItemsTool } from "./mail-items-tool.js";
import { registerFiUserEsignTests } from "./tools.esign.test-support.js";
import { registerFiUserMatrixEnvironmentTests } from "./tools.matrix-environment.test-support.js";
import { registerFiUserWorkflowTests } from "./tools.workflow.test-support.js";

type ToolFactory = (context: OpenClawPluginToolContext) => AnyAgentTool | AnyAgentTool[] | null;
type ToolRegistration = AnyAgentTool | ToolFactory | { contextVersion: 2; create: ToolFactory };
type Hook = (event: never, context: never) => unknown;

const BROKER = "broker-token";
const runtimeConfig = {
  plugins: {
    entries: {
      "fi-user": {
        config: {
          baseUrl: "https://fi.example.test",
          brokerTokenEnv: "TEST_BROKER_TOKEN",
          tenantOrgId: "org-shape",
          matrixEnvironments: {
            dev: {
              baseUrl: "https://dev-fi.example.test",
              brokerTokenEnv: "TEST_DEV_BROKER_TOKEN",
            },
          },
          gamBinary: "/opt/gam",
          gamConfigDir: "/opt/gam-config",
          sharedInboxMailbox: "shared@example.com",
          adminApprovers: ["UALEX00001", "ULORENZO01"],
          adminPrincipals: ["UALEX00001", "ULORENZO01"],
        },
      },
    },
  },
  channels: { slack: { accounts: { "fi-user": { botToken: "xoxb-fi-user" } } } },
};

function plugin() {
  const tools: ToolRegistration[] = [];
  const hooks = new Map<string, Hook[]>();
  const stores = approvalStores();
  fiUserPlugin.register?.(
    createTestPluginApi({
      id: "fi-user",
      name: "Fi User Delegation",
      config: runtimeConfig,
      runtime: {
        config: { current: () => runtimeConfig },
        channel: {
          runtimeContexts: { register: vi.fn() },
          outbound: {
            loadAdapter: async () => ({ sendMedia: mocks.sendMedia, sendText: mocks.sendText }),
          },
        },
        subagent: {
          run: mocks.subagentRun,
          waitForRun: mocks.waitForRun,
          getSessionMessages: mocks.getSessionMessages,
          deleteSession: vi.fn(),
        },
        state: {
          openKeyedStore: stores.openKeyedStore,
        },
      } as unknown as OpenClawPluginApi["runtime"],
      registerTool: (tool: unknown) => tools.push(tool as ToolRegistration),
      on: (name: string, handler: Hook) => {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
    } as never),
  );
  const registration = tools[0]!;
  const factory = (
    typeof registration === "function"
      ? registration
      : "create" in registration
        ? registration.create
        : () => registration
  ) as ToolFactory;
  return {
    stores,
    tool(name: string, toolContext: OpenClawPluginToolContext) {
      const result = factory(toolContext);
      const tool = (Array.isArray(result) ? result : result ? [result] : []).find(
        (candidate) => candidate.name === name,
      );
      if (!tool) {
        throw new Error(`missing ${name}`);
      }
      return tool;
    },
    hook(name: string): Hook {
      // The host runs every handler registered for a hook, in order.
      const handlers = hooks.get(name) ?? [];
      if (handlers.length === 0) {
        throw new Error(`missing hook ${name}`);
      }
      if (handlers.length === 1) {
        return handlers[0]!;
      }
      return async (...args: Parameters<Hook>) => {
        for (const handler of handlers) {
          await handler(...args);
        }
      };
    },
  };
}

function context(overrides: Partial<OpenClawPluginToolContext> = {}) {
  return {
    agentId: "cellect-fi-user",
    messageChannel: "slack",
    requesterSenderId: "U12345678",
    agentAccountId: "fi-user",
    sessionKey: "agent:cellect-fi-user:slack:channel:C0CHANNEL1:thread:1710000000.000100",
    nativeChannelId: "C0CHANNEL1",
    getRuntimeConfig: () => runtimeConfig,
    ...overrides,
  } as OpenClawPluginToolContext;
}

function privateMatrixContext(overrides: Partial<OpenClawPluginToolContext> = {}) {
  return context({
    messageChannel: "matrix",
    requesterSenderId: "@member:threads.example",
    sessionKey: "agent:cellect-fi-user:matrix:room:!private",
    nativeChannelId: "!private:threads.example",
    deliveryContext: { channel: "matrix", to: "room:!private:threads.example" },
    ...overrides,
  } as Partial<OpenClawPluginToolContext>);
}

type Route = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;
const routes: Route[] = [];
const calls: Array<{ url: string; init: RequestInit }> = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Fi members behind channel identities; anyone else resolves to the default member. */
const members: Record<string, string> = {
  UALEX00001: "alex@example.com",
  ULORENZO01: "lorenzo@example.com",
  "@alex:threads.example": "alex@example.com",
};

function delegation(body?: Record<string, unknown>) {
  return json({
    user: { email: "member@example.com", orgSlug: "shape", orgId: "org-shape", role: "member" },
    gmail: { enabled: true, mailbox: "member@example.com" },
    fi: { token: "delegated-token", expiresAt: 1_900_000_000 },
    ...body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TEST_BROKER_TOKEN", BROKER);
  vi.stubEnv("TEST_DEV_BROKER_TOKEN", "dev-broker-token");
  vi.stubEnv(
    "FI_THREADS_ENV_BY_ACCOUNT",
    JSON.stringify({ "fi-user": "prod", "fi-user-dev": "dev" }),
  );
  routes.length = 0;
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ url: url.toString(), init });
      if (
        url.pathname === "/fi-api/openclaw-user-delegation" ||
        url.pathname === "/api/openclaw-user-delegation"
      ) {
        const requester = bodyJson(init) as Record<string, string> | null;
        // Fi refuses the whole mint when the asked-for private room is not the requester's own.
        const privateRoom = (requester as { privateConversation?: { roomId?: string } } | null)
          ?.privateConversation?.roomId;
        if (privateRoom !== undefined && privateRoom !== "!private:threads.example") {
          return new Response("Forbidden", { status: 403 });
        }
        const email =
          members[requester?.requesterSenderId ?? ""] ??
          members[requester?.requesterMatrixUserId ?? ""];
        return email
          ? delegation({
              user: { email, orgSlug: "shape", orgId: "org-shape", role: "admin" },
              gmail: { enabled: true, mailbox: email },
            })
          : delegation();
      }
      for (const route of routes) {
        const response = await route(url, init);
        if (response) {
          return response;
        }
      }
      return new Response(`unexpected ${init.method ?? "GET"} ${url}`, { status: 599 });
    }),
  );
});

function delegationBody() {
  const call = calls.find((entry) => entry.url.endsWith("/api/openclaw-user-delegation"));
  return bodyJson(call?.init);
}

function bodyJson(init: RequestInit | undefined) {
  return JSON.parse(typeof init?.body === "string" ? init.body : "null");
}

function authorization(init: RequestInit) {
  return new Headers(init.headers).get("authorization");
}

describe("fi_user_api", () => {
  it.each([
    "fi-view/context",
    "305-third/budget/text",
    "companies/opco/pnl/text",
    "companies/opco/balance-sheet/text",
    "companies/opco/cash-flow-statement/text",
    "apps/accounts-payable/cash-needs/text",
    "apps/accounts-payable/vendor-portals/text",
    "apps/accounts-payable/vendor-portals/room-1/text",
    "audit/text",
    "debt/project-305-third:Loan-1/statement/text",
  ])("accepts the registered screen read route %s", (path) => {
    expect(fiUserApiPath("shape", path)).toBe(`/api/shape/${path}`);
  });

  it.each([
    "mail-agent/items",
    "mail-agent/items/item-12345678/context",
    "mail-agent/items/item-12345678/conversations/conv-1/text",
  ])("accepts the mail item read route %s", (path) => {
    expect(fiUserApiPath("shape", path)).toBe(`/api/shape/${path}`);
  });

  it.each([
    "mail-agent/items/item-12345678",
    "mail-agent/items/item-12345678/control",
    "mail-agent/items/item-12345678/context/extra",
    "mail-agent/items/item-12345678/conversations/conv-1",
    "mail-agent/items/item-12345678/conversations/conv-1/text/more",
    "mail-agent/items/a/b/context",
    "mail-agent/workspace",
    "mail-agent/tasks/item-12345678",
    "mail-agent/items/../enrollment",
  ])("denies %s on the shadow route list", (path) => {
    expect(() => fiUserApiPath("shape", path, FI_USER_API_SHADOW_READ_ROUTES)).toThrow();
  });

  it("offers fi_user_mail_items to a normal user turn and posts a strict control body", async () => {
    const mailTool = plugin().tool("fi_user_mail_items", privateMatrixContext());
    routes.push((url) =>
      url.pathname === "/api/shape/mail-agent/items/item-12345678/control"
        ? json({ ok: true })
        : undefined,
    );
    await mailTool.execute("m1", {
      action: "control",
      itemId: "item-12345678",
      control: "pause",
      reason: "later",
      expectedRevision: "3",
    });
    const delegation = calls.find((entry) => entry.url.endsWith("/api/openclaw-user-delegation"));
    expect(JSON.parse(String(delegation!.init.body)).privateConversation).toEqual({
      roomId: "!private:threads.example",
    });
    const call = calls.find((entry) => entry.url.endsWith("/control"));
    expect(call!.init.method).toBe("POST");
    expect(authorization(call!.init)).toBe("Bearer delegated-token");
    expect(bodyJson(call!.init)).toEqual({ kind: "pause", reason: "later", expectedRevision: "3" });
    await expect(
      mailTool.execute("m2", {
        action: "control",
        itemId: "item-12345678",
        control: "drop",
        text: "x",
      }),
    ).rejects.toThrow(/does not accept/);
    await expect(
      mailTool.execute("m3", { action: "control", itemId: "../x", control: "resume" }),
    ).rejects.toThrow(/itemId/);
  });

  it("rejects a non-string or malformed expectedRevision before calling Fi", async () => {
    const mailTool = plugin().tool("fi_user_mail_items", privateMatrixContext());
    for (const bad of [3, "-1", "1.5", "12345678901234567890", ""]) {
      await expect(
        mailTool.execute("r", {
          action: "control",
          itemId: "item-12345678",
          control: "resume",
          expectedRevision: bad,
        }),
      ).rejects.toThrow(/expectedRevision/);
    }
    expect(calls.some((entry) => entry.url.endsWith("/control"))).toBe(false);
    const schema = JSON.stringify(mailTool.parameters);
    expect(schema).toContain("^[0-9]{1,19}$");
    expect(schema).toContain('"maxLength":2000');
  });

  it("offers fi_user_mail_items only in the requester's own Matrix room, never Slack or webchat", () => {
    const offered = (ctx: OpenClawPluginToolContext) => (offersMailItemsTool(ctx) ? "yes" : "no");
    expect(offered(privateMatrixContext())).toBe("yes");
    expect(offered(context())).toBe("no");
    expect(offered(context({ messageChannel: "webchat" }))).toBe("no");
    expect(offered(privateMatrixContext({ nativeChannelId: "!other:threads.example" }))).toBe("no");
    expect(offered(privateMatrixContext({ requesterSenderId: undefined }))).toBe("no");
    expect(
      offered(privateMatrixContext({ sessionKey: "agent:cellect-fi-user:hook:fi-shadow:abc123" })),
    ).toBe("no");
  });

  it("reads a reviewed Fi text route with the requester's delegation token", async () => {
    routes.push((url) =>
      url.pathname === "/api/shape/305-third/budget/text" ? new Response("budget text") : undefined,
    );
    const result = await plugin()
      .tool("fi_user_api", context())
      .execute("c1", { path: "305-third/budget/text" });
    expect(result.details).toMatchObject({ status: 200, result: "budget text" });
    const call = calls.find((entry) => entry.url.includes("/budget/text"));
    expect(authorization(call!.init)).toBe("Bearer delegated-token");
    expect(call!.init.method).toBe("GET");
    expect(delegationBody()).toEqual({
      requesterSenderId: "U12345678",
      agentId: "cellect-fi-user",
    });
  });

  it("requests a private-conversation delegation for fi_user_api only in the private Matrix room", async () => {
    routes.push((url) =>
      url.pathname === "/api/shape/mail-agent/items" ? json({ items: [] }) : undefined,
    );
    const mint = async (ctx: OpenClawPluginToolContext) => {
      calls.length = 0;
      await plugin().tool("fi_user_api", ctx).execute("p", { path: "mail-agent/items" });
      return delegationBody();
    };
    expect(await mint(privateMatrixContext())).toMatchObject({
      privateConversation: { roomId: "!private:threads.example" },
    });
    expect(await mint(context())).not.toHaveProperty("privateConversation");
    expect(
      await mint(privateMatrixContext({ nativeChannelId: "!other:threads.example" })),
    ).not.toHaveProperty("privateConversation");
    expect(await mint(privateMatrixContext())).toMatchObject({
      privateConversation: { roomId: "!private:threads.example" },
    });
  });

  it.each(["305-third/budget/text", "documents/search", "fi-view/context"])(
    "mints an ordinary %s read without a private audience, even in the private room",
    async (path) => {
      routes.push((url) =>
        url.pathname.startsWith("/api/shape/") ? json({ ok: true }) : undefined,
      );
      await plugin().tool("fi_user_api", privateMatrixContext()).execute("o", { path });
      expect(delegationBody()).not.toHaveProperty("privateConversation");
    },
  );

  it("reads Fi from a shared Matrix room: no private audience is asked, so the mint succeeds", async () => {
    routes.push((url) =>
      url.pathname === "/api/shape/305-third/budget/text" ? new Response("budget text") : undefined,
    );
    const shared = privateMatrixContext({
      sessionKey: "agent:cellect-fi-user:matrix:room:!shared",
      nativeChannelId: "!shared:threads.example",
      deliveryContext: { channel: "matrix", to: "room:!shared:threads.example" },
    } as Partial<OpenClawPluginToolContext>);
    const result = await plugin()
      .tool("fi_user_api", shared)
      .execute("s", { path: "305-third/budget/text" });
    expect(result.details).toMatchObject({ status: 200, result: "budget text" });
    expect(delegationBody()).toEqual({
      requesterMatrixUserId: "@member:threads.example",
      agentId: "cellect-fi-user",
    });
    // Mail items there still ask for the private audience, and Fi refuses it; nothing retries.
    calls.length = 0;
    await expect(
      plugin().tool("fi_user_api", shared).execute("m", { path: "mail-agent/items" }),
    ).rejects.toThrow(/Fi user delegation failed \(403\)/);
    await expect(
      plugin().tool("fi_user_mail_items", shared).execute("mi", { action: "list" }),
    ).rejects.toThrow(/Fi user delegation failed \(403\)/);
    const mintBodies = calls
      .filter((entry) => entry.url.endsWith("/api/openclaw-user-delegation"))
      .map((entry) => bodyJson(entry.init));
    expect(mintBodies).toHaveLength(2);
    expect(
      mintBodies.every((body) => body.privateConversation?.roomId === "!shared:threads.example"),
    ).toBe(true);
    expect(calls.some((entry) => entry.url.includes("/mail-agent/"))).toBe(false);
  });

  it("still lists mail items in the requester's own private room", async () => {
    routes.push((url) =>
      url.pathname === "/api/shape/mail-agent/items"
        ? json({ items: [{ id: "item-1" }] })
        : undefined,
    );
    const result = await plugin()
      .tool("fi_user_mail_items", privateMatrixContext())
      .execute("pl", { action: "list" });
    expect(result.details).toMatchObject({ status: 200, result: { items: [{ id: "item-1" }] } });
    expect(delegationBody()).toMatchObject({
      privateConversation: { roomId: "!private:threads.example" },
    });
  });

  registerFiUserMatrixEnvironmentTests({
    BROKER,
    authorization,
    calls,
    context,
    delegationBody,
    json,
    plugin,
    routes,
  });

  it("resolves missing Matrix screen context through authorized navigation search", async () => {
    routes.push((url) =>
      url.pathname === "/api/shape/nav/search"
        ? json({
            items: [
              { type: "project", label: "236 Montgomery", href: "/shape/projects/236-montgomery" },
            ],
          })
        : undefined,
    );
    const result = await plugin()
      .tool(
        "fi_user_api",
        context({
          messageChannel: "matrix",
          requesterSenderId: "@member:threads.example",
          sessionKey: "agent:cellect-fi-user:matrix:room:!abc",
        }),
      )
      .execute("c2-nav", { path: "nav/search", query: { q: "236 Montgomery" } });

    expect(result.details).toMatchObject({
      status: 200,
      path: "/api/shape/nav/search",
      result: { items: [{ label: "236 Montgomery" }] },
    });
    expect(
      calls.some((entry) => entry.url.endsWith("/api/shape/nav/search?q=236+Montgomery")),
    ).toBe(true);
    expect(delegationBody()).toEqual({
      requesterMatrixUserId: "@member:threads.example",
      agentId: "cellect-fi-user",
    });
  });

  it("reads the current registered Matrix screen through its delegated text endpoint", async () => {
    routes.push((url) =>
      url.pathname === "/api/shape/fi-view/context"
        ? json({
            view: { id: "project.budget", title: "Budget" },
            route: { path: "/fi/shape/projects/305-third/budget?asOf=2026-09-01" },
            actions: [
              {
                id: "copy_text",
                method: "GET",
                label: "Copy text context",
                href: "/fi/api/shape/305-third/budget/text?asOf=2026-09-01",
              },
            ],
          })
        : undefined,
    );
    routes.push((url) =>
      url.pathname === "/api/shape/305-third/budget/text"
        ? new Response("Budget view for 305 Third as of 2026-09-01")
        : undefined,
    );

    const result = await plugin()
      .tool(
        "fi_user_api",
        context({
          messageChannel: "matrix",
          requesterSenderId: "@member:threads.example",
          sessionKey: "agent:cellect-fi-user:matrix:room:!abc",
        }),
      )
      .execute("c2-screen", {
        path: "fi-view/context",
        query: { path: "/fi/shape/projects/305-third/budget?asOf=2026-09-01" },
      });

    expect(result.details).toMatchObject({
      status: 200,
      path: "/api/shape/fi-view/context",
      result: {
        context: {
          view: { id: "project.budget" },
          route: { path: "/fi/shape/projects/305-third/budget?asOf=2026-09-01" },
          actions: [{ id: "copy_text", method: "GET" }],
        },
        text: {
          status: "ready",
          content: "Budget view for 305 Third as of 2026-09-01",
        },
      },
    });
    expect(JSON.stringify(result.details)).not.toContain("/fi/api/shape/");
    expect(calls.map((call) => new URL(call.url).pathname)).toContain(
      "/api/shape/305-third/budget/text",
    );
    const textCall = calls.find((call) => call.url.includes("/budget/text"));
    expect(new URL(textCall!.url).searchParams.get("asOf")).toBe("2026-09-01");
    expect(authorization(textCall!.init)).toBe("Bearer delegated-token");
    expect(delegationBody()).toEqual({
      requesterMatrixUserId: "@member:threads.example",
      agentId: "cellect-fi-user",
    });
  });

  it("follows the exact vendor-statement detail action generated by Fi", async () => {
    routes.push((url) =>
      url.pathname === "/api/shape/fi-view/context"
        ? json({
            view: { id: "app:accounts-payable", title: "Accounts Payable" },
            route: { path: "/fi/shape/apps/accounts-payable/vendor-portals/room-1" },
            actions: [
              {
                id: "copy_text",
                method: "GET",
                href: "/fi/api/shape/apps/accounts-payable/vendor-portals/room-1/text",
              },
            ],
          })
        : undefined,
    );
    routes.push((url, init) =>
      url.pathname === "/api/shape/apps/accounts-payable/vendor-portals/room-1/text" &&
      init.method === "GET"
        ? new Response("Vendor statement: ACME\nInvoice INV-10; amount $100.00")
        : undefined,
    );

    const result = await plugin()
      .tool("fi_user_api", context())
      .execute("c-ap-vendor-screen", {
        path: "fi-view/context",
        query: { path: "/fi/shape/apps/accounts-payable/vendor-portals/room-1" },
      });

    expect(result.details).toMatchObject({
      result: {
        context: { view: { id: "app:accounts-payable" } },
        text: {
          status: "ready",
          content: "Vendor statement: ACME\nInvoice INV-10; amount $100.00",
        },
      },
    });
    const detailRead = calls.find((call) =>
      new URL(call.url).pathname.endsWith("/vendor-portals/room-1/text"),
    );
    expect(detailRead).toBeDefined();
    expect(authorization(detailRead!.init)).toBe("Bearer delegated-token");
  });

  it("does not follow a current-screen text action outside the delegated tenant read routes", async () => {
    routes.push((url) =>
      url.pathname === "/api/shape/fi-view/context"
        ? json({ actions: [{ id: "copy_text", method: "GET", href: "https://evil.test/steal" }] })
        : undefined,
    );
    const result = await plugin()
      .tool("fi_user_api", context())
      .execute("c2-screen-denied", {
        path: "fi-view/context",
        query: { path: "/fi/shape/projects/305-third/budget" },
      });

    expect(result.details).toMatchObject({
      result: {
        context: { actions: [{ id: "copy_text", method: "GET" }] },
        text: { status: "not_available" },
      },
    });
    expect(calls.some((call) => call.url.includes("evil.test"))).toBe(false);
  });

  it("strips Fi action URLs and context YAML after following the authorized screen text action", async () => {
    routes.push((url) =>
      url.pathname === "/api/shape/fi-view/context"
        ? json({
            view: { id: "company.pnl", title: "Company P&L" },
            route: { path: "/fi/shape/companies/opco/pnl?period=2026-Q3" },
            actions: [
              {
                id: "copy_text",
                method: "GET",
                href: "/fi/api/shape/companies/opco/pnl/text?period=2026-Q3",
              },
            ],
            structuredContext: {
              actions: [
                { id: "copy_text", href: "/fi/api/shape/companies/opco/pnl/text?period=2026-Q3" },
              ],
            },
            contextYaml: "actions:\n  - href: /fi/api/shape/companies/opco/pnl/text",
          })
        : undefined,
    );
    routes.push((url) =>
      url.pathname === "/api/shape/companies/opco/pnl/text"
        ? new Response("Company P&L for Q3", { headers: { "content-type": "text/plain" } })
        : undefined,
    );

    const result = await plugin()
      .tool(
        "fi_user_api",
        context({
          messageChannel: "matrix",
          requesterSenderId: "@member:threads.example",
          sessionKey: "agent:cellect-fi-user:matrix:room:!abc",
        }),
      )
      .execute("c2-company-screen", {
        path: "/api/shape/fi-view/context",
        query: { path: "/fi/shape/companies/opco/pnl?period=2026-Q3" },
      });

    expect(result.details).toMatchObject({
      result: {
        context: {
          view: { id: "company.pnl" },
          actions: [{ id: "copy_text", method: "GET" }],
          structuredContext: { actions: [{ id: "copy_text" }] },
        },
        text: { status: "ready", content: "Company P&L for Q3", truncated: false },
      },
    });
    const serialized = JSON.stringify(result.details);
    expect(serialized).not.toContain("contextYaml");
    expect(serialized).not.toContain("/fi/api/shape/companies/opco/pnl/text");
    const textCall = calls.find((call) => call.url.includes("/companies/opco/pnl/text"));
    expect(textCall).toBeDefined();
    expect(new URL(textCall!.url).searchParams.get("period")).toBe("2026-Q3");
    expect(authorization(textCall!.init)).toBe("Bearer delegated-token");
  });

  it.each([
    ["cross-org", "/fi/api/other/305-third/budget/text"],
    ["unreviewed route", "/fi/api/shape/apps/accounts-payable/intakes/secret/file"],
    ["external origin", "https://evil.test/fi/api/shape/305-third/budget/text"],
  ])("does not follow a %s copy-text action", async (_label, href) => {
    routes.push((url) =>
      url.pathname === "/api/shape/fi-view/context"
        ? json({ actions: [{ id: "copy_text", method: "GET", href }] })
        : undefined,
    );
    const result = await plugin()
      .tool("fi_user_api", context())
      .execute("c2-screen-boundary", {
        path: "fi-view/context",
        query: { path: "/fi/shape/projects/305-third/budget" },
      });

    expect(result.details).toMatchObject({ result: { text: { status: "not_available" } } });
    expect(
      calls.some((call) => call.url.includes("/budget/text") || call.url.includes("evil.test")),
    ).toBe(false);
  });

  it("bounds current screen text to 32,000 characters", async () => {
    routes.push((url) =>
      url.pathname === "/api/shape/fi-view/context"
        ? json({
            actions: [
              { id: "copy_text", method: "GET", href: "/fi/api/shape/305-third/budget/text" },
            ],
          })
        : undefined,
    );
    routes.push((url) =>
      url.pathname === "/api/shape/305-third/budget/text"
        ? new Response("x".repeat(32_010))
        : undefined,
    );
    const result = await plugin()
      .tool("fi_user_api", context())
      .execute("c2-screen-large", {
        path: "fi-view/context",
        query: { path: "/fi/shape/projects/305-third/budget" },
      });

    expect(result.details).toMatchObject({
      result: {
        text: { status: "ready", truncated: true, sourceChars: 32_010, includedChars: 32_000 },
      },
    });
    expect(JSON.stringify(result.details)).toContain(
      "Fi screen text truncated after 32,000 characters",
    );
  });

  it("works on webchat with the Fi-signed context credential of that chat", async () => {
    const sessionKey = "agent:cellect-fi-user:webchat:member";
    rememberWebchatContext(
      sessionKey,
      'Conversation info:\n```json\n{"fiContextAuth":{"type":"fi_context","scheme":"Bearer","token":"aaa.bbb.ccc"}}\n```\nhi',
    );
    routes.push((url) =>
      url.pathname === "/api/shape/apps/accounts-payable/text" ? new Response("ap") : undefined,
    );
    await plugin()
      .tool(
        "fi_user_api",
        context({ messageChannel: "webchat", requesterSenderId: undefined, sessionKey }),
      )
      .execute("c3", { path: "apps/accounts-payable/text" });
    expect(delegationBody()).toEqual({
      appContextToken: "aaa.bbb.ccc",
      agentId: "cellect-fi-user",
    });
  });

  it.each([
    "api/other/305-third/budget/text",
    "305-third/../x/budget/text",
    "305-third//budget/text",
    "305-third/%2e%2e/budget/text",
    "305-third/budget/text?x=1",
    "305-third/budget/text#frag",
  ])("refuses %s before calling Fi", async (requested) => {
    await expect(
      plugin().tool("fi_user_api", context()).execute("c4", { path: requested }),
    ).rejects.toThrow();
    expect(calls.some((entry) => !entry.url.endsWith("/api/openclaw-user-delegation"))).toBe(false);
  });

  it("leaves route admission to Fi outside a shadow turn: an owner reads apps/invoices/text", async () => {
    routes.push((url) =>
      url.pathname === "/api/shape/apps/invoices/text"
        ? new Response("Invoices: 3 open", { headers: { "content-type": "text/plain" } })
        : undefined,
    );
    const result = await plugin()
      .tool("fi_user_api", context({ requesterSenderId: "UALEX00001" }))
      .execute("c-inv", { path: "apps/invoices/text" });
    expect(result.details).toMatchObject({ status: 200, result: "Invoices: 3 open" });
  });

  it("says a route Fi does not admit for member tokens is not available to member agents", async () => {
    routes.push((url) =>
      url.pathname === "/api/shape/datarooms/room-1/members"
        ? json(
            {
              error: "bearer_rejected",
              message: "This route does not accept the presented bearer token.",
            },
            401,
          )
        : undefined,
    );
    await expect(
      plugin().tool("fi_user_api", context()).execute("c-br", { path: "datarooms/room-1/members" }),
    ).rejects.toThrow(/\/api\/shape\/datarooms\/room-1\/members is not available to member agents/);
  });

  it.each(["delegation_expired", "delegation_revoked"])(
    "asks to re-authenticate, not the route copy, when Fi answers %s",
    async (code) => {
      routes.push((url) =>
        url.pathname === "/api/shape/305-third/budget/text"
          ? json({ error: code, message: "expired" }, 401)
          : undefined,
      );
      const error = await plugin()
        .tool("fi_user_api", context())
        .execute("c-exp", { path: "305-third/budget/text" })
        .catch((caught: Error) => caught);
      expect(String(error)).toMatch(/re-authenticate/);
      expect(String(error)).not.toMatch(/not available to member agents/);
    },
  );

  it("passes Fi's own 403 copy through for a member without the grant", async () => {
    routes.push((url) =>
      url.pathname === "/api/shape/apps/invoices/text"
        ? json({ error: "forbidden", message: "Invoices needs owner or admin" }, 403)
        : undefined,
    );
    await expect(
      plugin().tool("fi_user_api", context()).execute("c-403", { path: "apps/invoices/text" }),
    ).rejects.toThrow(
      /Fi returned 403 for \/api\/shape\/apps\/invoices\/text: .*Invoices needs owner or admin/,
    );
  });

  it("refuses a document's bytes by content type without reading the body", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    routes.push((url) =>
      url.pathname === "/api/shape/305-third/docs/doc-1/file"
        ? new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
            headers: { "content-type": "application/pdf" },
          })
        : undefined,
    );
    await expect(
      plugin()
        .tool("fi_user_api", context())
        .execute("c-bin", { path: "305-third/docs/doc-1/file" }),
    ).rejects.toThrow(/^binary: .*fi_user_deliver_file/);
    expect(cancel).toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
  });

  it("sends number and boolean query values as text", async () => {
    routes.push((url) =>
      url.pathname === "/api/shape/documents/search" ? json({ items: [] }) : undefined,
    );
    await plugin()
      .tool("fi_user_api", context())
      .execute("c-q", { path: "documents/search", query: { q: "lease", limit: 5, exact: true } });
    const call = calls.find((entry) => entry.url.includes("/documents/search"));
    expect(new URL(call!.url).search).toBe("?q=lease&limit=5&exact=true");
    const schema = plugin().tool("fi_user_api", context()).parameters;
    const { Value } = await import("typebox/value");
    expect(Value.Check(schema, { path: "documents/search", query: { limit: 5 } })).toBe(true);
    expect(Value.Check(schema, { path: "documents/search", query: { limit: [5] } })).toBe(false);
  });
});

describe("fi_user_dataroom", () => {
  const room = {
    roomVersion: 7,
    documents: [
      { documentId: "doc-1", roomCategory: "Draw 3", orderKey: "010", visibility: "shared" },
    ],
    tasks: [{ id: "task-1", documentIds: ["doc-0"] }],
  };

  it("continues a large authorized placement read and retrieves exact details without an admin action", async () => {
    const large = {
      ...room,
      documents: Array.from({ length: 90 }, (_, i) => ({
        documentId: `doc-${i}`,
        displayName: `Document ${i}`,
        roomCategory: i === 89 ? "Lorenzo KYC" : "Overview",
        orderKey: `01.${i}`,
        visibility: "internal",
      })),
      tasks: [{ id: "pfs", title: "PFS", documentIds: ["doc-89"], status: "open" }],
    };
    routes.push((url, init) =>
      url.pathname === "/api/shape/datarooms/room-1" && (init.method ?? "GET") === "GET"
        ? json(large)
        : undefined,
    );
    const tool = plugin().tool("fi_user_dataroom", context());
    let result = await tool.execute("placement", {
      action: "get",
      roomId: "room-1",
      view: "placement",
    });
    let page = result.details as { nextCursor?: string; complete: boolean; tasks: unknown[] };
    expect(page.complete).toBe(false);
    while (page.nextCursor) {
      result = await tool.execute("placement", {
        action: "get",
        roomId: "room-1",
        view: "placement",
        cursor: page.nextCursor,
      });
      page = result.details as typeof page;
    }
    expect(page.complete).toBe(true);
    expect(page.tasks).toContainEqual(large.tasks[0]);
    const exact = await tool.execute("detail", {
      action: "get",
      roomId: "room-1",
      documentId: "doc-89",
    });
    expect(exact.details).toMatchObject({ document: large.documents[89] });
    expect(calls.filter((call) => !call.url.endsWith("/openclaw-user-delegation"))).toSatisfy(
      (values: typeof calls) => values.every((call) => (call.init.method ?? "GET") === "GET"),
    );
    expect(mocks.subagentRun).not.toHaveBeenCalled();
  });

  it("offers only the reviewed actions: no generic pass-through, members, recipients or public links", () => {
    const schema = plugin().tool("fi_user_dataroom", context()).parameters as {
      properties: { action: { enum?: string[]; anyOf?: Array<{ const: string }> } };
    };
    const actions =
      schema.properties.action.enum ??
      schema.properties.action.anyOf?.map((entry) => entry.const) ??
      [];
    expect(actions).toEqual([
      "create",
      "list",
      "get",
      "tasks",
      "available_docs",
      "add_document",
      "update_document",
      "link_task",
      "complete_task",
      "upload_gmail_attachment",
      "upload_slack_file",
      "upload_drive_file",
      "upload_generated_artifact",
      "upload_file",
      "upload_to_project_library",
    ]);
    expect(JSON.stringify(schema)).not.toMatch(/"method"|"path"|jsonBody/);
  });

  it("adds a document with room-version preconditions, then reads it back", async () => {
    routes.push((url, init) => {
      if (url.pathname === "/api/shape/datarooms/room-1" && (init.method ?? "GET") === "GET") {
        return json(room);
      }
      if (url.pathname === "/api/shape/datarooms/room-1/documents" && init.method === "POST") {
        return json({ ok: true, roomVersion: 8 });
      }
      if (
        url.pathname === "/api/shape/datarooms/room-1/documents/doc-1" &&
        init.method === "PATCH"
      ) {
        return json({ ok: true, roomVersion: 9 });
      }
      return undefined;
    });
    const result = await plugin().tool("fi_user_dataroom", context()).execute("d1", {
      action: "add_document",
      roomId: "room-1",
      documentId: "doc-1",
      section: "Draw 3",
      orderKey: "010",
    });
    const post = calls.find(
      (entry) => entry.init.method === "POST" && entry.url.endsWith("/documents"),
    );
    const headers = new Headers(post!.init.headers);
    expect(headers.get("if-match")).toBe("7");
    expect(headers.get("idempotency-key")).toMatch(/^fi-user:[a-f0-9]{48}$/);
    expect(bodyJson(post!.init)).toEqual({ documentId: "doc-1" });
    const patch = calls.find((entry) => entry.init.method === "PATCH");
    expect(bodyJson(patch!.init)).toEqual({
      roomCategory: "Draw 3",
      orderKey: "010",
    });
    expect(result.details).toMatchObject({
      added: "doc-1",
      document: { documentId: "doc-1", roomCategory: "Draw 3" },
    });
  });

  it("links a checklist task by merging, never replacing, its documents", async () => {
    routes.push((url, init) => {
      if (url.pathname === "/api/shape/datarooms/room-1" && (init.method ?? "GET") === "GET") {
        return json(room);
      }
      if (url.pathname === "/api/shape/datarooms/room-1/tasks/task-1" && init.method === "PATCH") {
        return json({ ok: true });
      }
      return undefined;
    });
    await plugin().tool("fi_user_dataroom", context()).execute("d2", {
      action: "link_task",
      roomId: "room-1",
      taskId: "task-1",
      documentId: "doc-1",
    });
    const patch = calls.find((entry) => entry.init.method === "PATCH");
    expect(bodyJson(patch!.init)).toEqual({ documentIds: ["doc-0", "doc-1"] });
  });

  it("rejects a room id that tries to reach another route", async () => {
    await expect(
      plugin()
        .tool("fi_user_dataroom", context())
        .execute("d3", { action: "get", roomId: "room-1/members" }),
    ).rejects.toThrow(/single identifier/);
  });

  function slackFile(
    user: string,
    shares: Record<string, Array<{ ts?: string; thread_ts?: string }>>,
  ) {
    return {
      ok: true,
      file: {
        id: "F0FILE0001",
        name: "Encotech contract.pdf",
        user,
        size: 10,
        url_private_download:
          "https://files.slack.com/files-pri/T1-F0FILE0001/download/encotech.pdf",
        permalink: "https://example.slack.com/files/U12345678/F0FILE0001",
        shares: { private: shares },
      },
    };
  }

  it("uploads a Slack file the requester posted in this thread, with Slack provenance", async () => {
    routes.push((url, init) => {
      if (url.hostname === "slack.com" && url.pathname === "/api/files.info") {
        expect(authorization(init)).toBe("Bearer xoxb-fi-user");
        return json(
          slackFile("U12345678", {
            C0CHANNEL1: [{ ts: "1710000000.000200", thread_ts: "1710000000.000100" }],
          }),
        );
      }
      if (url.hostname === "files.slack.com") {
        return new Response("%PDF-1.4", { headers: { "content-type": "application/pdf" } });
      }
      if (url.pathname === "/api/shape/datarooms/room-1" && (init.method ?? "GET") === "GET") {
        return json(room);
      }
      if (url.pathname === "/api/shape/datarooms/room-1/documents/upload") {
        return json({ ok: true, document: { documentId: "doc-9" }, roomVersion: 8 });
      }
      return undefined;
    });
    const result = await plugin()
      .tool("fi_user_dataroom", context())
      .execute("d4", { action: "upload_slack_file", roomId: "room-1", slackFileId: "F0FILE0001" });
    const upload = calls.find((entry) => entry.url.endsWith("/documents/upload"));
    const form = upload!.init.body as FormData;
    expect(form.get("provenanceSource")).toBe("slack");
    expect(form.get("provenanceFileId")).toBe("F0FILE0001");
    expect(form.get("provenanceMessageId")).toBe("1710000000.000100");
    expect((form.get("file") as File).name).toBe("Encotech contract.pdf");
    expect(authorization(upload!.init)).toBe("Bearer delegated-token");
    expect(result.details).toMatchObject({ documentId: "doc-9" });
  });

  it("refuses a Slack file posted by someone else", async () => {
    routes.push((url) =>
      url.pathname === "/api/files.info"
        ? json(
            slackFile("UOTHER0001", { C0CHANNEL1: [{ ts: "1", thread_ts: "1710000000.000100" }] }),
          )
        : undefined,
    );
    await expect(
      plugin().tool("fi_user_dataroom", context()).execute("d5", {
        action: "upload_slack_file",
        roomId: "room-1",
        slackFileId: "F0FILE0001",
      }),
    ).rejects.toThrow(/not posted by you/);
  });

  it("files a Slack file the requester posted into a project's document library, with provenance", async () => {
    routes.push((url, init) => {
      if (url.hostname === "slack.com" && url.pathname === "/api/files.info") {
        return json(
          slackFile("U12345678", {
            C0CHANNEL1: [{ ts: "1710000000.000200", thread_ts: "1710000000.000100" }],
          }),
        );
      }
      if (url.hostname === "files.slack.com") {
        return new Response("%PDF-1.4", { headers: { "content-type": "application/pdf" } });
      }
      if (url.pathname === "/api/shape/24-bright/docs/upload" && init.method === "POST") {
        return json({
          ok: true,
          duplicate: false,
          projectSlug: "24-bright",
          document: { documentId: "doc-lib", state: "restricted_unclassified" },
        });
      }
      return undefined;
    });
    const result = await plugin().tool("fi_user_dataroom", context()).execute("d7", {
      action: "upload_to_project_library",
      project: "24-bright",
      category: "construction",
      section: "Permits",
      slackFileId: "F0FILE0001",
    });
    const upload = calls.find((entry) => entry.url.endsWith("/docs/upload"));
    expect(upload!.url).toBe("https://fi.example.test/api/shape/24-bright/docs/upload");
    expect(authorization(upload!.init)).toBe("Bearer delegated-token");
    const form = upload!.init.body as FormData;
    expect(form.get("category")).toBe("construction");
    expect(form.get("section")).toBe("Permits");
    expect(form.get("provenanceSource")).toBe("slack");
    expect(form.get("provenanceFileId")).toBe("F0FILE0001");
    expect(form.get("provenanceMessageId")).toBe("1710000000.000100");
    expect(form.get("provenanceUrl")).toBe("https://example.slack.com/files/U12345678/F0FILE0001");
    expect((form.get("file") as File).name).toBe("Encotech contract.pdf");
    // No data room is touched.
    expect(calls.some((entry) => entry.url.includes("/datarooms"))).toBe(false);
    expect(result.details).toMatchObject({
      project: "24-bright",
      duplicate: false,
      document: { documentId: "doc-lib" },
    });
  });

  it("refuses a library upload of a Slack file posted by someone else, before any Fi write", async () => {
    routes.push((url) =>
      url.pathname === "/api/files.info"
        ? json(
            slackFile("UOTHER0001", { C0CHANNEL1: [{ ts: "1", thread_ts: "1710000000.000100" }] }),
          )
        : undefined,
    );
    await expect(
      plugin().tool("fi_user_dataroom", context()).execute("d8", {
        action: "upload_to_project_library",
        project: "24-bright",
        slackFileId: "F0FILE0001",
      }),
    ).rejects.toThrow(/not posted by you/);
    expect(calls.some((entry) => entry.url.endsWith("/docs/upload"))).toBe(false);
  });

  it("requires a single project slug for a library upload", async () => {
    for (const project of [undefined, "24-bright/../other", "a/b"]) {
      await expect(
        plugin()
          .tool("fi_user_dataroom", context())
          .execute("d9", {
            action: "upload_to_project_library",
            ...(project ? { project } : {}),
            slackFileId: "F0FILE0001",
          }),
      ).rejects.toThrow(/project must be a single identifier/);
    }
    expect(calls.some((entry) => entry.url.includes("slack.com"))).toBe(false);
  });

  it("refuses a Slack file from another conversation", async () => {
    routes.push((url) =>
      url.pathname === "/api/files.info"
        ? json(
            slackFile("U12345678", { C0ELSEWHERE: [{ ts: "1", thread_ts: "1710000000.000100" }] }),
          )
        : undefined,
    );
    await expect(
      plugin().tool("fi_user_dataroom", context()).execute("d6", {
        action: "upload_slack_file",
        roomId: "room-1",
        slackFileId: "F0FILE0001",
      }),
    ).rejects.toThrow(/not posted in this conversation/);
  });
});

registerFiUserWorkflowTests({
  BROKER,
  bodyJson,
  calls,
  context,
  json,
  mocks,
  plugin,
  routes,
});

registerFiUserEsignTests({ bodyJson, calls, context, json, plugin, routes });

describe("shared inbox", () => {
  it("narrows every search to the requester's own correspondence", async () => {
    mocks.execFile.mockResolvedValue({ stdout: "User,id", stderr: "" });
    await plugin()
      .tool("fi_user_gmail", context())
      .execute("g1", { action: "search_shared_inbox", query: "waiver Lidiya" });
    expect(mocks.execFile).toHaveBeenCalledWith(
      "/opt/gam",
      [
        "user",
        "shared@example.com",
        "print",
        "messages",
        "query",
        "{from:member@example.com to:member@example.com cc:member@example.com} (waiver Lidiya)",
        "max_to_print",
        "10",
      ],
      expect.anything(),
    );
  });

  it.each(["x) OR (from:other", "a | b", "{from:other}", "waiver OR invoice"])(
    "refuses %s",
    async (query) => {
      await expect(
        plugin()
          .tool("fi_user_gmail", context())
          .execute("g2", { action: "search_shared_inbox", query }),
      ).rejects.toThrow(/plain search terms/);
      expect(mocks.execFile).not.toHaveBeenCalled();
    },
  );
});
