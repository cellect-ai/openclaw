import fs from "node:fs/promises";
import path from "node:path";
import type {
  AnyAgentTool,
  OpenClawPluginToolContext,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  extractDocumentContent: vi.fn(),
}));

vi.mock("node:util", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:util")>()),
  promisify: () => mocks.execFile,
}));
vi.mock("openclaw/plugin-sdk/document-extractor", () => ({
  extractDocumentContent: mocks.extractDocumentContent,
}));

import fiUserPlugin from "./index.js";

type ToolFactory = (context: OpenClawPluginToolContext) => AnyAgentTool | AnyAgentTool[] | null;

const runtimeConfig = {
  plugins: {
    entries: {
      "fi-user": {
        config: {
          baseUrl: "https://fi.example.test",
          brokerTokenEnv: "TEST_BROKER_TOKEN",
          tenantOrgId: "org-shape",
          gamBinary: "/opt/gam",
          gamConfigDir: "/opt/gam-config",
        },
      },
    },
  },
};

function registeredTools(context: OpenClawPluginToolContext): AnyAgentTool[] {
  const registrations: Array<AnyAgentTool | ToolFactory> = [];
  fiUserPlugin.register?.(
    createTestPluginApi({
      id: "fi-user",
      name: "Fi User Delegation",
      config: runtimeConfig,
      runtime: {
        channel: { runtimeContexts: { register: vi.fn() } },
      } as unknown as OpenClawPluginApi["runtime"],
      registerTool: (tool) => registrations.push(tool as AnyAgentTool | ToolFactory),
    }),
  );
  const registered = registrations[0];
  if (!registered) {
    throw new Error("expected fi-user tool registration");
  }
  const result = typeof registered === "function" ? registered(context) : registered;
  return result ? (Array.isArray(result) ? result : [result]) : [];
}

function registeredMessageReceivedHook(config = runtimeConfig) {
  const hooks: Array<(event: never, context: never) => Promise<void> | void> = [];
  fiUserPlugin.register?.(
    createTestPluginApi({
      id: "fi-user",
      name: "Fi User Delegation",
      config,
      runtime: {
        channel: { runtimeContexts: { register: vi.fn() } },
      } as unknown as OpenClawPluginApi["runtime"],
      on: (name, handler) => {
        if (name === "message_received") {
          hooks.push(handler as (event: never, context: never) => Promise<void> | void);
        }
      },
    }),
  );
  const hook = hooks.at(-1);
  if (!hook) {
    throw new Error("expected message_received hook");
  }
  return hook;
}

function slackContext(overrides: Partial<OpenClawPluginToolContext> = {}) {
  return {
    agentId: "cellect-fi-user",
    messageChannel: "slack",
    requesterSenderId: "U12345678",
    getRuntimeConfig: () => runtimeConfig,
    ...overrides,
  } as OpenClawPluginToolContext;
}

function delegatedResponse() {
  return {
    ok: true,
    json: async () => ({
      user: { email: "member@example.com", orgSlug: "shape", orgId: "org-shape", role: "member" },
      gmail: { enabled: true, mailbox: "member@example.com" },
      fi: { token: "delegated-token", expiresAt: 1_900_000_000 },
    }),
  } as Response;
}

function mockPdfDownload() {
  mocks.execFile.mockImplementation(async (_binary, args: string[]) => {
    if (args.includes("info")) {
      return {
        stdout: JSON.stringify({
          id: "drive-file-1",
          name: "Contract.pdf",
          mimeType: "application/pdf",
          size: "1024",
        }),
        stderr: "",
      };
    }
    const targetFolder = args[args.indexOf("targetfolder") + 1];
    if (!targetFolder) {
      throw new Error("expected Drive download target folder");
    }
    await fs.writeFile(path.join(targetFolder, "Contract.pdf"), "%PDF-1.4 test");
    return { stdout: "downloaded", stderr: "" };
  });
}

describe("Fi user requester-bound Google Drive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TEST_BROKER_TOKEN", "broker-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => delegatedResponse()),
    );
  });

  it("registers the requester-bound tools for verified Fi-user Slack, Matrix and webchat turns", () => {
    const names = [
      "fi_user_api",
      "fi_user_gmail",
      "fi_user_gdrive",
      "fi_user_dataroom",
      "fi_user_deliver_file",
      "fi_user_esign",
      "fi_user_budget_import",
      "request_admin_action",
    ];
    expect(registeredTools(slackContext()).map((tool) => tool.name)).toEqual(names);
    expect(
      registeredTools(
        slackContext({
          messageChannel: "matrix",
          agentAccountId: "fi-user",
          requesterSenderId: "@member:threads.example",
        }),
      ).map((tool) => tool.name),
    ).toEqual(names);
    expect(
      registeredTools(
        slackContext({ messageChannel: "webchat", requesterSenderId: undefined }),
      ).map((tool) => tool.name),
    ).toEqual(names);
    expect(registeredTools(slackContext({ requesterSenderId: undefined }))).toEqual([]);
    expect(registeredTools(slackContext({ messageChannel: "telegram" }))).toEqual([]);
    expect(registeredTools(slackContext({ agentId: "cellect-fi-admin" }))).toEqual([]);
  });

  it.each(["cellect-fi-user", "cellect-fi-admin", "cellect-main"])(
    "leaves %s DM projection to the canonical full-source reconciler",
    async (agentId) => {
      const hook = registeredMessageReceivedHook();
      await hook(
        {
          content: "Check this invoice",
          senderId: "U12345678",
          messageId: "1710000000.000001",
          sessionKey: `agent:${agentId}:slack:direct:u12345678`,
        } as never,
        {
          channelId: "slack",
          sessionKey: `agent:${agentId}:slack:direct:u12345678`,
        } as never,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("never projects an unthreaded channel or another agent's DM", async () => {
    const hook = registeredMessageReceivedHook();
    await hook(
      {
        content: "channel",
        senderId: "U12345678",
        sessionKey: "agent:cellect-fi-user:slack:channel:C1",
      } as never,
      { channelId: "slack" } as never,
    );
    await hook(
      {
        content: "other",
        senderId: "U12345678",
        sessionKey: "agent:cellect-fi-admin:slack:direct:u1",
      } as never,
      { channelId: "slack" } as never,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("searches every file visible to the immutable requester mailbox", async () => {
    mocks.execFile.mockResolvedValue({
      stdout: "Owner,id,name\nmember@example.com,1,Contract",
      stderr: "",
    });
    const drive = registeredTools(slackContext()).find((tool) => tool.name === "fi_user_gdrive");
    if (!drive) {
      throw new Error("expected Drive tool");
    }

    const result = await drive.execute("call-1", {
      action: "search",
      query: "name contains 'Contract'",
      maxResults: 15,
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://fi.example.test/api/openclaw-user-delegation",
      expect.objectContaining({
        body: JSON.stringify({ requesterSenderId: "U12345678", agentId: "cellect-fi-user" }),
      }),
    );
    expect(mocks.execFile).toHaveBeenCalledWith(
      "/opt/gam",
      [
        "user",
        "member@example.com",
        "print",
        "filelist",
        "anyowner",
        "query",
        "name contains 'Contract'",
        "excludetrashed",
        "maxfiles",
        "15",
        "fields",
        "id,name,mimetype,size,modifiedtime,parents",
        "filepath",
      ],
      expect.objectContaining({ env: expect.objectContaining({ GAMCFGDIR: "/opt/gam-config" }) }),
    );
    expect(result.details).toEqual({
      mailbox: "member@example.com",
      output: "Owner,id,name\nmember@example.com,1,Contract",
    });
  });

  it("clamps Gmail search to 50 results with print-messages syntax", async () => {
    mocks.execFile.mockResolvedValue({ stdout: "User,threadId,id", stderr: "" });
    const gmail = registeredTools(slackContext()).find((tool) => tool.name === "fi_user_gmail");
    if (!gmail) {
      throw new Error("expected Gmail tool");
    }

    await gmail.execute("call-3", { action: "search", query: "invoice", maxResults: 200 });

    expect(mocks.execFile).toHaveBeenCalledWith(
      "/opt/gam",
      ["user", "member@example.com", "print", "messages", "query", "invoice", "max_to_print", "50"],
      expect.anything(),
    );
  });

  it("treats a zero-match GAM exit as an empty result", async () => {
    mocks.execFile.mockRejectedValue(
      Object.assign(new Error("Command failed"), {
        code: 60,
        stdout: "Owner,id,name",
        stderr: "Got 0 Drive Files/Folders that matched query",
      }),
    );
    const drive = registeredTools(slackContext()).find((tool) => tool.name === "fi_user_gdrive");
    if (!drive) {
      throw new Error("expected Drive tool");
    }

    const result = await drive.execute("call-4", { action: "search", query: "name = 'none'" });

    expect(result.details).toEqual({
      mailbox: "member@example.com",
      output: "Owner,id,name\nGot 0 Drive Files/Folders that matched query",
    });
  });

  it("still fails on other GAM errors", async () => {
    mocks.execFile.mockRejectedValue(
      Object.assign(new Error("Command failed"), {
        code: 2,
        stdout: "",
        stderr: "ERROR: Invalid argument",
      }),
    );
    const drive = registeredTools(slackContext()).find((tool) => tool.name === "fi_user_gdrive");
    if (!drive) {
      throw new Error("expected Drive tool");
    }

    await expect(drive.execute("call-5", { action: "search", query: "x" })).rejects.toThrow(
      "Command failed",
    );
  });

  it("downloads and extracts a requester-visible PDF for the model", async () => {
    mockPdfDownload();
    mocks.extractDocumentContent.mockResolvedValue({
      text: "Developer-favorable scope text",
      images: [{ type: "image", data: "cG5n", mimeType: "image/png" }],
      extractor: "pdf",
    });
    const drive = registeredTools(slackContext()).find((tool) => tool.name === "fi_user_gdrive");
    if (!drive) {
      throw new Error("expected Drive tool");
    }

    const result = await drive.execute("call-2", {
      action: "read",
      fileId: "drive-file-1",
      maxPages: 12,
    });

    expect(mocks.extractDocumentContent).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: "application/pdf", maxPages: 12 }),
    );
    expect(result.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Developer-favorable"),
      }),
      { type: "image", data: "cG5n", mimeType: "image/png" },
    ]);
    expect(result.details).toEqual(
      expect.objectContaining({
        mailbox: "member@example.com",
        extractedTextChars: 30,
        extractedImageCount: 1,
      }),
    );
  });

  it("continues a bounded PDF read from a later page", async () => {
    mockPdfDownload();
    mocks.extractDocumentContent.mockResolvedValue({
      text: "Exhibit A scope text",
      images: [],
      extractor: "pdf",
    });
    const drive = registeredTools(slackContext()).find((tool) => tool.name === "fi_user_gdrive");
    if (!drive) {
      throw new Error("expected Drive tool");
    }

    const result = await drive.execute("call-3", {
      action: "read",
      fileId: "drive-file-1",
      startPage: 31,
      maxPages: 12,
    });

    expect(mocks.extractDocumentContent).toHaveBeenCalledWith(
      expect.objectContaining({
        maxPages: 12,
        pageNumbers: Array.from({ length: 12 }, (_, index) => index + 31),
      }),
    );
    expect(result.details).toEqual(
      expect.objectContaining({
        requestedPages: { start: 31, end: 42, continueWithStartPage: 43 },
      }),
    );
  });
});
