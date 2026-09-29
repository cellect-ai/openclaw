import { createHmac } from "node:crypto";
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

import { adminActionSessions } from "./admin-action.js";
import { rememberWebchatContext } from "./fi-delegation.js";
import fiUserPlugin from "./index.js";
import { registerFiUserMatrixEnvironmentTests } from "./tools.matrix-environment.test-support.js";

type ToolFactory = (context: OpenClawPluginToolContext) => AnyAgentTool | AnyAgentTool[] | null;
type Hook = (event: never, context: never) => unknown;

const BROKER = "broker-token";
const runtimeConfig = {
  plugins: {
    entries: {
      "fi-user": {
        config: {
          baseUrl: "https://fi.example.test",
          brokerTokenEnv: "TEST_BROKER_TOKEN",
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
  const tools: Array<AnyAgentTool | ToolFactory> = [];
  const hooks = new Map<string, Hook[]>();
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
          openKeyedStore: () => {
            throw new Error("no store in tests");
          },
        },
      } as unknown as OpenClawPluginApi["runtime"],
      registerTool: (tool: unknown) => tools.push(tool as AnyAgentTool | ToolFactory),
      on: (name: string, handler: Hook) => {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
    } as never),
  );
  const factory = tools[0] as ToolFactory;
  return {
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
    user: { email: "member@example.com", orgSlug: "shape", role: "member" },
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
        const email =
          members[requester?.requesterSenderId ?? ""] ??
          members[requester?.requesterMatrixUserId ?? ""];
        return email
          ? delegation({
              user: { email, orgSlug: "shape", role: "admin" },
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
    "305-third/budget",
    "datarooms/room-1/members",
    "305-third/rooms-search",
    "api/other/305-third/budget/text",
    "305-third/../x/budget/text",
    "305-third/budget/text?x=1",
    "companies/c-1/pnl/text",
  ])("refuses %s before calling Fi", async (requested) => {
    await expect(
      plugin().tool("fi_user_api", context()).execute("c4", { path: requested }),
    ).rejects.toThrow();
    expect(calls.some((entry) => !entry.url.endsWith("/api/openclaw-user-delegation"))).toBe(false);
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

  it("offers only the reviewed actions: no generic pass-through, members, recipients or public links", () => {
    const schema = plugin().tool("fi_user_dataroom", context()).parameters as {
      properties: { action: { enum?: string[]; anyOf?: Array<{ const: string }> } };
    };
    const actions =
      schema.properties.action.enum ??
      schema.properties.action.anyOf?.map((entry) => entry.const) ??
      [];
    expect(actions).toEqual([
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

describe("fi_user_deliver_file", () => {
  it("returns the login-gated Fi link in a channel", async () => {
    routes.push((url, init) =>
      url.pathname === "/api/shape/documents/share" && init.method === "POST"
        ? json({
            kind: "authenticated",
            url: "https://fi.example.test/api/shape/305-third/docs/doc-1/file?preview=1",
            access: "sign-in",
          })
        : undefined,
    );
    const result = await plugin()
      .tool("fi_user_deliver_file", context())
      .execute("f1", { documentId: "doc-1", project: "305-third" });
    expect(result.details).toMatchObject({
      delivered: "link",
      url: expect.stringContaining("/docs/doc-1/file"),
    });
    const share = calls.find((entry) => entry.url.endsWith("/documents/share"));
    expect(bodyJson(share!.init)).toEqual({
      documentId: "doc-1",
      project: "305-third",
    });
  });

  it("attaches the file in the requester's own Slack DM", async () => {
    routes.push((url) =>
      url.pathname === "/api/shape/305-third/docs/doc-1/file"
        ? new Response("%PDF-1.4", {
            headers: { "content-disposition": 'attachment; filename="CO-001.pdf"' },
          })
        : undefined,
    );
    mocks.sendMedia.mockResolvedValue({ messageId: "m1" });
    const result = await plugin()
      .tool(
        "fi_user_deliver_file",
        context({
          sessionKey: "agent:cellect-fi-user:slack:direct:U12345678",
          nativeChannelId: "D0DM000001",
        }),
      )
      .execute("f2", { documentId: "doc-1", project: "305-third" });
    expect(result.details).toMatchObject({ delivered: "slack_dm", file: "CO-001.pdf" });
    expect(mocks.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({ to: "user:U12345678", accountId: "fi-user", forceDocument: true }),
    );
  });
});

describe("fi_user_esign", () => {
  const list = {
    templates: [
      {
        sourceDocumentId: "doc-1",
        templateId: 5,
        ownerEmail: "owner@example.com",
        additionalSignerRoles: [],
        sent: false,
      },
      {
        sourceDocumentId: "doc-2",
        templateId: 6,
        ownerEmail: "owner@example.com",
        additionalSignerRoles: ["Contractor"],
        sent: false,
      },
    ],
  };

  it("previews a send with stored defaults and sends only after confirmation", async () => {
    routes.push((url, init) => {
      if (url.pathname === "/api/shape/559-first/esign" && (init.method ?? "GET") === "GET") {
        return json(list);
      }
      if (url.pathname === "/api/shape/559-first/esign/send") {
        return json({ ok: true, submissionId: 140 });
      }
      return undefined;
    });
    const tool = plugin().tool("fi_user_esign", context());
    const preview = await tool.execute("e1", {
      action: "send",
      project: "559-first",
      documentId: "doc-1",
      templateId: 5,
    });
    expect(preview.details).toMatchObject({
      preview: true,
      signer: "owner@example.com",
      completionCopies: ["member@example.com"],
    });
    expect(calls.some((entry) => entry.url.endsWith("/esign/send"))).toBe(false);
    await tool.execute("e2", {
      action: "send",
      project: "559-first",
      documentId: "doc-1",
      templateId: 5,
      confirmSend: true,
    });
    const send = calls.find((entry) => entry.url.endsWith("/esign/send"));
    expect(bodyJson(send!.init)).toEqual({
      documentId: "doc-1",
      templateId: 5,
      recipientsConfirmed: true,
      additionalSignerRecipients: [],
      completionBcc: ["member@example.com"],
    });
  });

  it("sends a template needing extra signers to an administrator instead", async () => {
    routes.push((url) => (url.pathname === "/api/shape/559-first/esign" ? json(list) : undefined));
    await expect(
      plugin().tool("fi_user_esign", context()).execute("e3", {
        action: "send",
        project: "559-first",
        documentId: "doc-2",
        templateId: 6,
        confirmSend: true,
      }),
    ).rejects.toThrow(/request_admin_action/);
  });

  it("resends to an existing signer through Fi as the requester", async () => {
    routes.push((url, init) =>
      url.pathname === "/api/shape/559-first/esign/submissions/124/resend" && init.method === "POST"
        ? json({ ok: true, resentTo: ["signer@example.com"] })
        : undefined,
    );
    const result = await plugin()
      .tool("fi_user_esign", context())
      .execute("e4", { action: "resend", project: "559-first", submissionId: 124 });
    expect(result.details).toMatchObject({ resentTo: ["signer@example.com"] });
  });
});

describe("fi_user_budget_import", () => {
  const rows = [{ costCode: "20-100", description: "Hardwood floors", amount: 40_000 }];

  it("applies only the exact source the requester saw in a dry run, after confirmation", async () => {
    routes.push((url) =>
      url.pathname === "/api/shape/305-third/budget/revisions/import"
        ? json({ ok: true })
        : undefined,
    );
    const tool = plugin().tool("fi_user_budget_import", context());
    const base = { project: "305-third", label: "Rev 4", changeNote: "Floors allowance" };
    await expect(
      tool.execute("b1", { ...base, rows, mode: "apply", confirmApply: true }),
    ).rejects.toThrow(/dry-run/);
    await tool.execute("b2", { ...base, rows });
    await expect(tool.execute("b3", { ...base, rows, mode: "apply" })).rejects.toThrow(
      /confirmApply/,
    );
    await expect(
      tool.execute("b4", {
        ...base,
        rows: [{ ...rows[0], amount: 45_000 }],
        mode: "apply",
        confirmApply: true,
      }),
    ).rejects.toThrow(/dry-run/);
    await tool.execute("b5", { ...base, rows, mode: "apply", confirmApply: true });
    const modes = calls
      .filter((entry) => entry.url.endsWith("/budget/revisions/import"))
      .map((entry) => bodyJson(entry.init).mode);
    expect(modes).toEqual(["dry-run", "apply"]);
  });
});

describe("request_admin_action", () => {
  it("posts an approval card, and runs fi-admin once an approver approves", async () => {
    const send = vi.fn();
    const instance = plugin();
    const ctx = context({
      delivery: { send },
      deliveryContext: {
        channel: "slack",
        to: "C0CHANNEL1",
        accountId: "fi-user",
        threadId: "1710000000.000100",
      },
    });
    const result = await instance.tool("request_admin_action", ctx).execute("a1", {
      task: "esign_change_recipient",
      project: "559-first",
      submissionId: 124,
      currentSignerEmail: "old@example.com",
      newSignerEmail: "asorc@example.com",
      reason: "Signer asked for a different address",
    });
    const requestId = (result.details as { requestId: string }).requestId;
    expect(requestId).toMatch(/^[A-Z0-9]{6}$/);
    const card = send.mock.calls[0]![0].text as string;
    expect(card).toContain("<@UALEX00001> <@ULORENZO01>");
    expect(card).toContain(`approve ${requestId}`);
    expect(card).toContain("<@U12345678>");

    mocks.subagentRun.mockResolvedValue({ runId: "run-1" });
    mocks.waitForRun.mockResolvedValue({ status: "ok" });
    mocks.getSessionMessages.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Signer changed; DocuSeal resent to asorc@example.com." },
          ],
        },
      ],
    });
    const received = instance.hook("message_received");
    // Not an approver: ignored.
    await received(
      { content: `approve ${requestId}`, senderId: "U12345678" } as never,
      { channelId: "slack" } as never,
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(mocks.subagentRun).not.toHaveBeenCalled();

    await received(
      { content: `approve ${requestId}`, senderId: "UALEX00001" } as never,
      { channelId: "slack" } as never,
    );
    await vi.waitFor(() => expect(mocks.sendText).toHaveBeenCalled());
    expect(mocks.subagentRun).toHaveBeenCalledTimes(1);
    const run = mocks.subagentRun.mock.calls[0]![0];
    expect(run.sessionKey).toBe(`agent:cellect-fi-admin:admin-action:${requestId.toLowerCase()}`);
    expect(run.message).toContain("Carry out ONLY this task");
    expect(run.message).toContain("asorc@example.com");
    expect(mocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "C0CHANNEL1",
        threadId: "1710000000.000100",
        text: expect.stringContaining("approved by UALEX00001"),
      }),
    );

    // A second approval does not start another run; it is noted in the thread.
    await received(
      { content: `approve ${requestId}`, senderId: "ULORENZO01" } as never,
      { channelId: "slack" } as never,
    );
    await vi.waitFor(() =>
      expect(mocks.sendText).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("already decided") }),
      ),
    );
    expect(mocks.subagentRun).toHaveBeenCalledTimes(1);
  });

  it("records a denial from an approver who mentions the bot first, and runs nothing", async () => {
    const instance = plugin();
    const ctx = context({
      delivery: { send: vi.fn() },
      deliveryContext: {
        channel: "slack",
        to: "C0CHANNEL1",
        accountId: "fi-user",
        threadId: "1710000000.000100",
      },
    });
    const result = await instance.tool("request_admin_action", ctx).execute("a4", {
      task: "external_share_link",
      project: "90-bright",
      documentId: "doc-geo",
      recipientEmail: "federico@example.com",
    });
    const requestId = (result.details as { requestId: string }).requestId;
    await instance.hook("message_received")(
      { content: `<@UFIUSERBOT> deny ${requestId}`, senderId: "UALEX00001" } as never,
      { channelId: "slack" } as never,
    );
    await vi.waitFor(() => expect(mocks.sendText).toHaveBeenCalled());
    expect(mocks.sendText.mock.calls[0]![0].text).toContain("declined");
    expect(mocks.subagentRun).not.toHaveBeenCalled();
  });

  it("files an access request as the requester in Fi", async () => {
    routes.push((url, init) =>
      url.pathname === "/api/shape/access-requests" && init.method === "POST"
        ? json({
            ok: true,
            request: { id: 3 },
            approvalUrl: "https://fi.example.test/shape/settings?tab=access&request=3",
          })
        : undefined,
    );
    const send = vi.fn();
    const result = await plugin()
      .tool("request_admin_action", context({ delivery: { send } }))
      .execute("a2", {
        task: "access_request",
        targetType: "project",
        targetId: "82-sussex",
        reason: "Title work",
      });
    const call = calls.find((entry) => entry.url.endsWith("/access-requests"));
    expect(bodyJson(call!.init)).toMatchObject({
      requesterEmail: "member@example.com",
      target: { type: "project", id: "82-sussex" },
    });
    expect(result.details).toMatchObject({ filed: true, cardPosted: true });
    expect(send.mock.calls[0]![0].text).toContain("approve or deny in Fi");
    expect(mocks.subagentRun).not.toHaveBeenCalled();
  });

  it("requires the fields of the chosen task", async () => {
    await expect(
      plugin()
        .tool("request_admin_action", context())
        .execute("a3", { task: "external_share_link", project: "x" }),
    ).rejects.toThrow(/documentId, recipientEmail/);
  });
});

describe("before_tool_call", () => {
  function verify(assertion: string) {
    const [header, payload, signature] = assertion.split(".");
    expect(createHmac("sha256", BROKER).update(`${header}.${payload}`).digest("base64url")).toBe(
      signature,
    );
    return JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
  }

  it("injects a gateway-signed on-behalf-of assertion into fi-admin exec", () => {
    const hook = plugin().hook("before_tool_call");
    const result = hook(
      {
        toolName: "exec",
        params: {
          command: "npm run rooms:filing -- inspect",
          env: { FI_ON_BEHALF_OF: "forged", KEEP: "1" },
        },
      } as never,
      {
        agentId: "cellect-fi-admin",
        toolName: "exec",
        requester: { channel: "slack", senderId: "u12345678" },
      } as never,
    ) as { params: { env: Record<string, string> } };
    expect(result.params.env.KEEP).toBe("1");
    const claims = verify(result.params.env.FI_ON_BEHALF_OF!);
    expect(claims).toMatchObject({
      iss: "openclaw-gateway",
      aud: "fi-on-behalf-of",
      agent_id: "cellect-fi-admin",
      requester_slack_user_id: "U12345678",
    });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(15 * 60);
    expect(JSON.stringify(result)).not.toContain(BROKER);
  });

  it("drops a model-supplied assertion when there is no verified requester", () => {
    const hook = plugin().hook("before_tool_call");
    const result = hook(
      {
        toolName: "exec",
        params: { command: "true", env: { FI_ON_BEHALF_OF: "replayed" } },
      } as never,
      {
        agentId: "cellect-main",
        toolName: "exec",
        requester: { channel: "webchat", senderId: "webchat-ui" },
      } as never,
    ) as { params: Record<string, unknown> };
    expect(result.params).toEqual({ command: "true" });
  });

  it("leaves other agents and tools alone", () => {
    const hook = plugin().hook("before_tool_call");
    expect(
      hook(
        { toolName: "exec", params: { command: "x" } } as never,
        { agentId: "cellect-fi-user", toolName: "exec" } as never,
      ),
    ).toBeUndefined();
    expect(
      hook(
        { toolName: "read", params: {} } as never,
        { agentId: "cellect-fi-admin", toolName: "read" } as never,
      ),
    ).toBeUndefined();
  });

  it("keeps fi-admin from handing work off", () => {
    const hook = plugin().hook("before_tool_call");
    expect(
      hook(
        { toolName: "sessions_send", params: {} } as never,
        { agentId: "cellect-fi-admin" } as never,
      ),
    ).toMatchObject({ block: true });
    expect(
      hook(
        { toolName: "sessions_spawn", params: { agentId: "cellect-main" } } as never,
        { agentId: "cellect-fi-admin" } as never,
      ),
    ).toMatchObject({ block: true });
    expect(
      hook(
        { toolName: "message", params: {} } as never,
        {
          agentId: "cellect-fi-admin",
          sessionKey: "agent:cellect-fi-admin:admin-action:abc234",
        } as never,
      ),
    ).toMatchObject({ block: true });
  });

  it("attributes an approved admin action's exec to the original requester", () => {
    const sessionKey = "agent:cellect-fi-admin:admin-action:zzz222";
    adminActionSessions.set(sessionKey, {
      id: "ZZZ222",
      task: "external_share_link",
      fields: {},
      requester: {
        email: "member@example.com",
        identity: { channel: "matrix", requesterMatrixUserId: "@member:threads.example" },
      },
      createdAt: Date.now(),
      status: "approved",
    });
    try {
      const result = plugin().hook("before_tool_call")(
        { toolName: "exec", params: { command: "x" } } as never,
        { agentId: "cellect-fi-admin", sessionKey } as never,
      ) as { params: { env: Record<string, string> } };
      expect(verify(result.params.env.FI_ON_BEHALF_OF!)).toMatchObject({
        requester_matrix_user_id: "@member:threads.example",
      });
    } finally {
      adminActionSessions.delete(sessionKey);
    }
  });
});

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
