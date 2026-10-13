import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ exchange: vi.fn(), sendMedia: vi.fn() }));
vi.mock("./fi-delegation.js", async (original) => ({
  ...(await original<typeof import("./fi-delegation.js")>()),
  exchange: mocks.exchange,
}));
import {
  generatedFileAction,
  readGeneratedArtifact,
  withoutInternalDownloadLinks,
} from "./generated-artifacts.js";
import fiUserPlugin from "./index.js";
import { createDeliverFileTool } from "./member-tools.js";

let directory: string;
let output: string;
let context: OpenClawPluginToolContext;
let api: OpenClawPluginApi;
let tables: Map<string, Map<string, unknown>>;
const csv = Buffer.from("item,amount\nConcrete,100\n");
function details(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object" || !("details" in result)) {
    throw new Error("Expected structured tool result");
  }
  return result.details as Record<string, unknown>;
}
const delegation = (
  orgId = "org-shape",
  email = "nicholas@example.test",
  requester = "UNICHOLAS",
) => ({
  delegation: { user: { orgId, email, orgSlug: "shape" } },
  identity: { channel: "slack", requesterSenderId: requester },
});

beforeEach(async () => {
  vi.clearAllMocks();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "generated-artifact-test-"));
  context = {
    agentId: "cellect-fi-user",
    messageChannel: "slack",
    requesterSenderId: "UNICHOLAS",
    workspaceDir: directory,
    sessionId: "session-1",
    sessionKey: "agent:cellect-fi-user:slack:direct:UNICHOLAS",
    agentAccountId: "fi-user",
    assertInvocationCurrent: vi.fn(),
  } as OpenClawPluginToolContext;
  context.getRuntimeConfig = () => ({
    channels: { slack: { accounts: { "fi-user": { botToken: "fixture-token" } } } },
  });
  tables = new Map();
  api = {
    config: {},
    runtime: {
      state: {
        openKeyedStore: ({ namespace }: { namespace: string }) => {
          let table = tables.get(namespace);
          if (!table) {
            table = new Map();
            tables.set(namespace, table);
          }
          const store = {
            lookup: async (key: string) => table.get(key),
            register: async (
              key: string,
              value: unknown,
              options?: { assertCurrent?: () => void },
            ) => {
              options?.assertCurrent?.();
              table.set(key, value);
            },
            registerIfAbsent: async (key: string, value: unknown) => {
              if (table.has(key)) {
                return false;
              }
              table.set(key, value);
              return true;
            },
          };
          return {
            ...store,
            withCurrent: ({ assertCurrent }: { assertCurrent: () => void }) => ({
              lookup: store.lookup,
              register: async (key: string, value: unknown) => {
                assertCurrent();
                return store.register(key, value);
              },
              registerIfAbsent: async (key: string, value: unknown) => {
                assertCurrent();
                return store.registerIfAbsent(key, value);
              },
              delete: async (key: string) => {
                assertCurrent();
                table.delete(key);
              },
            }),
          };
        },
      },
      channel: {
        runtimeContexts: { register: vi.fn() },
        outbound: { loadAdapter: async () => ({ sendMedia: mocks.sendMedia }) },
      },
    },
  } as unknown as OpenClawPluginApi;
  mocks.exchange.mockResolvedValue(delegation());
  mocks.sendMedia.mockResolvedValue({ messageId: "1791918000.123456" });
  const prepared = await generatedFileAction(api, context, { action: "prepare" });
  output = path.join(
    directory,
    String(details(prepared).outputDirectory).replace(/^\/workspace\//, ""),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(directory, { recursive: true, force: true });
});

async function register(name = "Budget.csv", bytes = csv) {
  await fs.writeFile(path.join(output, name), bytes);
  const result = await createDeliverFileTool(api, context).execute("register", {
    action: "register",
    fileName: name,
  });
  expect(result.details).toMatchObject({
    status: "generated_not_delivered",
    fileName: name,
    bytes: bytes.length,
  });
  expect(mocks.sendMedia).not.toHaveBeenCalled();
  return String(details(result).artifactId);
}

describe("requester-bound generated artifact delivery", () => {
  it("exposes generated delivery through the plugin's host-bound context-v2 registration", async () => {
    let factory:
      | { contextVersion: 2; create: (context: OpenClawPluginToolContext) => AnyAgentTool[] | null }
      | undefined;
    fiUserPlugin.register?.(
      createTestPluginApi({
        id: "fi-user",
        name: "Fi User Delegation",
        config: api.config,
        runtime: api.runtime,
        registerTool: (registration) => {
          if (typeof registration === "object" && "create" in registration) {
            factory = registration as typeof factory;
          }
        },
      }),
    );
    expect(factory?.contextVersion).toBe(2);
    const tool = factory
      ?.create(context)
      ?.find((candidate) => candidate.name === "fi_user_deliver_file");
    expect(tool).toBeDefined();
    await fs.writeFile(path.join(output, "Budget.csv"), csv);
    const registered = await tool!.execute("registered-entry", {
      action: "register",
      fileName: "Budget.csv",
    });
    const artifactId = String(details(registered).artifactId);
    expect(
      (await tool!.execute("delivery-entry", { action: "deliver", artifactId })).details,
    ).toMatchObject({ delivered: "slack_dm", messageId: "1791918000.123456" });
  });

  it("delivers exact registered bytes and returns a provider receipt, then reuses it without sending twice", async () => {
    const artifactId = await register();
    const tool = createDeliverFileTool(api, context);
    expect(
      (await tool.execute("deliver", { action: "deliver", artifactId })).details,
    ).toMatchObject({ delivered: "slack_dm", messageId: "1791918000.123456" });
    const send = mocks.sendMedia.mock.calls[0]?.[0];
    if (!send) {
      throw new Error("Expected a Slack delivery call");
    }
    expect(send.to).toBe("user:UNICHOLAS");
    expect(send.accountId).toBe("fi-user");
    expect(await send.mediaReadFile(send.mediaUrl)).toEqual(csv);
    expect((await tool.execute("again", { action: "deliver", artifactId })).details).toMatchObject({
      reusedReceipt: true,
    });
    expect(mocks.sendMedia).toHaveBeenCalledTimes(1);
  });

  it.each(["requester", "tenant", "email", "sessionId", "sessionKey", "account", "workspace"])(
    "refuses %s substitution before delivery",
    async (field) => {
      const artifactId = await register();
      const other = { ...context };
      if (field === "requester") {
        mocks.exchange.mockResolvedValue(
          delegation("org-shape", "nicholas@example.test", "UOTHER"),
        );
      }
      if (field === "tenant") {
        mocks.exchange.mockResolvedValue(delegation("org-other"));
      }
      if (field === "email") {
        mocks.exchange.mockResolvedValue(delegation("org-shape", "other@example.test"));
      }
      if (field === "sessionId") {
        other.sessionId = "session-2";
      }
      if (field === "sessionKey") {
        other.sessionKey = "agent:cellect-fi-user:slack:direct:UOTHER";
      }
      if (field === "account") {
        other.agentAccountId = "fi-admin";
      }
      if (field === "workspace") {
        other.workspaceDir = path.dirname(directory);
      }
      await expect(readGeneratedArtifact(api, other, artifactId)).rejects.toThrow(
        /does not belong/,
      );
      expect(mocks.sendMedia).not.toHaveBeenCalled();
    },
  );

  it("rejects changed bytes and does not send a stale artifact", async () => {
    const artifactId = await register();
    await fs.writeFile(path.join(output, "Budget.csv"), "changed\n");
    await expect(
      generatedFileAction(api, context, { action: "deliver", artifactId }),
    ).rejects.toThrow(/changed after registration/);
    expect(mocks.sendMedia).not.toHaveBeenCalled();
  });

  it.each(["../Budget.csv", "/tmp/Budget.csv", "sub/Budget.csv", "Budget.exe", "bad\u0000.csv"])(
    "refuses unsafe or unsupported name %s",
    async (fileName) => {
      await expect(
        generatedFileAction(api, context, { action: "register", fileName }),
      ).rejects.toThrow();
    },
  );

  it("rejects symlink and hardlink sources", async () => {
    const source = path.join(directory, "outside.csv");
    await fs.writeFile(source, csv);
    await fs.symlink(source, path.join(output, "linked.csv"));
    await expect(
      generatedFileAction(api, context, { action: "register", fileName: "linked.csv" }),
    ).rejects.toThrow();
    await fs.link(source, path.join(output, "hardlink.csv"));
    await expect(
      generatedFileAction(api, context, { action: "register", fileName: "hardlink.csv" }),
    ).rejects.toThrow();
  });

  it.each([
    ["empty.csv", Buffer.alloc(0)],
    ["binary.csv", Buffer.from([0])],
    ["bad.xlsx", csv],
    ["bad.pdf", csv],
    ["bad.png", csv],
  ])("rejects empty or mismatched output %s", async (name, bytes) => {
    await fs.writeFile(path.join(output, name), bytes);
    await expect(
      generatedFileAction(api, context, { action: "register", fileName: name }),
    ).rejects.toThrow();
  });

  it("rejects ZIP signatures that are not an Office workbook", async () => {
    await fs.writeFile(
      path.join(output, "not-workbook.xlsx"),
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
    );
    await expect(
      generatedFileAction(api, context, { action: "register", fileName: "not-workbook.xlsx" }),
    ).rejects.toThrow();
  });

  it("revalidates live invocation after awaiting identity", async () => {
    const artifactId = await register();
    mocks.exchange.mockImplementation(async () => {
      context.assertInvocationCurrent = () => {
        throw new Error("Invocation retired");
      };
      return delegation();
    });
    await expect(
      generatedFileAction(api, context, { action: "deliver", artifactId }),
    ).rejects.toThrow(/retired/);
    expect(mocks.sendMedia).not.toHaveBeenCalled();
  });

  it("does not resend after an unknown provider outcome, including through a fresh tool instance", async () => {
    const artifactId = await register();
    mocks.sendMedia.mockRejectedValue(new Error("Connection interrupted"));
    await expect(
      generatedFileAction(api, context, { action: "deliver", artifactId }),
    ).rejects.toThrow(/interrupted/);
    mocks.sendMedia.mockResolvedValue({ messageId: "later" });
    await expect(
      createDeliverFileTool(api, { ...context }).execute("retry", {
        action: "deliver",
        artifactId,
      }),
    ).rejects.toThrow(/uncertain/);
    expect(mocks.sendMedia).toHaveBeenCalledTimes(1);
  });

  it("does not claim delivery when provider returned no message receipt", async () => {
    const artifactId = await register();
    mocks.sendMedia.mockResolvedValue({});
    await expect(
      generatedFileAction(api, context, { action: "deliver", artifactId }),
    ).rejects.toThrow(/no delivery receipt/);
  });

  it("allows exact-artifact retry only after the delivery owner proves non-dispatch", async () => {
    const artifactId = await register();
    mocks.sendMedia.mockRejectedValueOnce(
      new PlatformMessageNotDispatchedError("missing_scope", {
        cause: new Error("Slack rejected before dispatch"),
      }),
    );
    await expect(
      generatedFileAction(api, context, { action: "deliver", artifactId }),
    ).rejects.toThrow(/missing_scope/);
    const result = await generatedFileAction(api, context, { action: "deliver", artifactId });
    expect(details(result)).toMatchObject({ delivered: "slack_dm" });
    expect(mocks.sendMedia).toHaveBeenCalledTimes(2);
  });

  it("does not resend after a raw platform rejection without non-dispatch proof", async () => {
    const artifactId = await register();
    mocks.sendMedia.mockRejectedValueOnce(
      Object.assign(new Error("missing_scope"), {
        code: "slack_webapi_platform_error",
        data: { error: "missing_scope" },
      }),
    );
    await expect(
      generatedFileAction(api, context, { action: "deliver", artifactId }),
    ).rejects.toThrow(/missing_scope/);
    await expect(
      generatedFileAction(api, context, { action: "deliver", artifactId }),
    ).rejects.toThrow(/uncertain/);
    expect(mocks.sendMedia).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    "reconciles an uncertain send only when requester-DM file bytes match (%s)",
    async (match) => {
      const artifactId = await register();
      mocks.sendMedia.mockRejectedValueOnce(new Error("timeout"));
      await expect(
        generatedFileAction(api, context, { action: "deliver", artifactId }),
      ).rejects.toThrow(/timeout/);
      const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
        if (url.endsWith("conversations.open")) {
          return new Response(JSON.stringify({ ok: true, channel: { id: "DREQUESTER" } }));
        }
        if (url.endsWith("conversations.history")) {
          return new Response(
            JSON.stringify({
              ok: true,
              messages: [
                {
                  ts: "1791919000.111111",
                  files: [
                    {
                      id: "FFILE001",
                      name: "Budget.csv",
                      size: csv.length,
                      url_private_download: "https://files.slack.com/file",
                    },
                  ],
                },
              ],
            }),
          );
        }
        return new Response(match ? csv : Buffer.alloc(csv.length, 65));
      });
      vi.stubGlobal("fetch", fetch);
      const result = await generatedFileAction(api, context, { action: "reconcile", artifactId });
      expect(String(fetch.mock.calls[0]?.[1]?.body)).toBe("users=UNICHOLAS");
      if (match) {
        expect(details(result)).toMatchObject({
          delivered: "slack_dm",
          reconciled: true,
          messageId: "1791919000.111111",
        });
        expect(
          details(await generatedFileAction(api, context, { action: "deliver", artifactId })),
        ).toMatchObject({ reusedReceipt: true });
      } else {
        expect(details(result)).toMatchObject({ status: "unknown" });
        await expect(
          generatedFileAction(api, context, { action: "deliver", artifactId }),
        ).rejects.toThrow(/uncertain/);
      }
      expect(mocks.sendMedia).toHaveBeenCalledTimes(1);
    },
  );

  it("returns bounded image content instead of a base64 text dump and rejects non-image inspection", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMZkAAAAASUVORK5CYII=",
      "base64",
    );
    await fs.writeFile(path.join(output, "preview.png"), png);
    const inspected = await generatedFileAction(api, context, {
      action: "inspect",
      fileName: "preview.png",
    });
    expect(inspected.content).toEqual([
      { type: "image", data: png.toString("base64"), mimeType: "image/png" },
    ]);
    await fs.writeFile(path.join(output, "Budget.csv"), csv);
    await expect(
      generatedFileAction(api, context, { action: "inspect", fileName: "Budget.csv" }),
    ).rejects.toThrow(/Inspect accepts/);
  });

  it("refuses cross-source inputs and artifact IDs presented as public links", async () => {
    const artifactId = await register();
    await expect(
      createDeliverFileTool(api, context).execute("mixed", {
        action: "deliver",
        artifactId,
        documentId: "doc-1",
      }),
    ).rejects.toThrow(/cannot also select/);
    await expect(
      generatedFileAction(api, context, { action: "deliver", artifactId, via: "link" }),
    ).rejects.toThrow(/authorized Library/);
  });
});

describe("internal download links", () => {
  it.each(["</workspace/output.xlsx|Download>", "&lt;/workspace/output.xlsx|Download&gt;"])(
    "removes inaccessible Slack link %s",
    (content) => {
      expect(withoutInternalDownloadLinks(content)).not.toContain("/workspace/");
      expect(withoutInternalDownloadLinks(content)).toContain("delivery has not been verified");
    },
  );
  it("does not expose bare internal output paths as accessible downloads", () => {
    expect(
      withoutInternalDownloadLinks("Download /workspace/report.xlsx or file:///tmp/report.pdf"),
    ).toBe(
      "Download [internal file location — not a download link] or [internal file location — not a download link]",
    );
  });
  it("replaces local Markdown download links but preserves real HTTPS links", () => {
    expect(
      withoutInternalDownloadLinks(
        "[Budget](/workspace/budget.xlsx) [PDF](file:///tmp/a.pdf) [real](https://fi.example.test/doc)",
      ),
    ).toBe(
      "Budget — file delivery has not been verified; no accessible download link is available. PDF — file delivery has not been verified; no accessible download link is available. [real](https://fi.example.test/doc)",
    );
  });
});
