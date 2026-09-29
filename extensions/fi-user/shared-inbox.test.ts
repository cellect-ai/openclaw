import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:util", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:util")>()),
  promisify: () => mocks.execFile,
}));
vi.mock("openclaw/plugin-sdk/document-extractor", () => ({ extractDocumentContent: vi.fn() }));

import { headerAddresses } from "./gam.js";
import fiUserPlugin from "./index.js";

type ToolFactory = (context: OpenClawPluginToolContext) => AnyAgentTool | AnyAgentTool[] | null;

const runtimeConfig = {
  plugins: {
    entries: {
      "fi-user": {
        config: {
          baseUrl: "https://fi.example.test",
          brokerTokenEnv: "TEST_BROKER_TOKEN",
          gamBinary: "/opt/gam",
          gamConfigDir: "/opt/gam-config",
          sharedInboxMailbox: "shared@example.com",
        },
      },
    },
  },
};

function gmailTool(): AnyAgentTool {
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
  const factory = registrations[0] as ToolFactory;
  const result = factory({
    agentId: "cellect-fi-user",
    messageChannel: "slack",
    requesterSenderId: "U12345678",
    getRuntimeConfig: () => runtimeConfig,
  } as OpenClawPluginToolContext);
  const tool = (Array.isArray(result) ? result : result ? [result] : []).find(
    (candidate) => candidate.name === "fi_user_gmail",
  );
  if (!tool) {
    throw new Error("missing fi_user_gmail");
  }
  return tool;
}

/** GAM answers the headers-only check and the full read differently. */
function gamMessage(headers: string, body = "Body:\n  hello") {
  mocks.execFile.mockImplementation(async (_binary: string, args: string[]) => ({
    stdout: args.includes("showbody")
      ? `User: shared@example.com, Show 1 Message\n  Message: abc123\n${headers}\n${body}`
      : `User: shared@example.com, Show 1 Message\n  Message: abc123\n${headers}`,
    stderr: "",
  }));
}

function readShared() {
  return gmailTool().execute("g1", { action: "read_shared_inbox", messageId: "abc123" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TEST_BROKER_TOKEN", "broker-token");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            user: { email: "member@example.com", orgSlug: "shape", role: "member" },
            gmail: { enabled: true, mailbox: "member@example.com" },
            fi: { token: "delegated-token", expiresAt: 1_900_000_000 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
  );
});

describe("read_shared_inbox", () => {
  it("reads a message only after its own headers name the requester", async () => {
    gamMessage("    From: Member <Member@Example.com>\n    To: shared@example.com");
    const result = await readShared();
    expect(JSON.stringify(result.details)).toContain("hello");
    const [check, read] = mocks.execFile.mock.calls.map((call) => call[1] as string[]);
    expect(check).toEqual([
      "user",
      "shared@example.com",
      "show",
      "messages",
      "ids",
      "abc123",
      "headers",
      "from,to,cc,delivered-to",
    ]);
    expect(read).toContain("showbody");
  });

  it("ignores headers quoted in a forwarded body", async () => {
    gamMessage(
      "    From: Someone <someone@example.com>\n    To: shared@example.com",
      "Body:\n---------- Forwarded message ---------\nFrom: Member <member@example.com>\nTo: member@example.com\nCc: member@example.com",
    );
    await expect(readShared()).rejects.toThrow(/not from, to, or copied to you/);
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.execFile.mock.calls[0]![1]).not.toContain("showbody");
  });

  it.each([
    ["a display name quoting the address", '    From: "member@example.com" <someone@example.com>'],
    ["a bare display name with the address", "    From: member@example.com <someone@example.com>"],
    ["a comment with the address", "    From: someone@example.com (member@example.com)"],
    ["a longer local part", "    To: xmember@example.com"],
    ["a longer domain", "    To: member@example.com.evil.test"],
    ["plus-addressing", "    Cc: member+ops@example.com"],
    ["only the shared inbox", "    Delivered-To: shared@example.com"],
    ["other headers", "    Reply-To: member@example.com\n    Subject: To: member@example.com"],
  ])("refuses %s", async (_label, headers) => {
    gamMessage(`${headers}\n    To: shared@example.com`);
    await expect(readShared()).rejects.toThrow(/not from, to, or copied to you/);
  });

  it.each([
    [
      "one of several recipients",
      '    To: "Ops, Team" <ops@example.com>, Member <MEMBER@example.com>',
    ],
    ["a group member", "    Cc: Team: ops@example.com, member@example.com;"],
    ["Delivered-To", "    Delivered-To: member@example.com"],
  ])("accepts the requester as %s", async (_label, headers) => {
    gamMessage(`    From: someone@example.com\n${headers}`);
    await expect(readShared()).resolves.toBeTruthy();
  });
});

describe("headerAddresses", () => {
  it("returns only the addr-spec of each mailbox", () => {
    expect(
      headerAddresses(
        '"Doe, Jane (Ops)" <Jane@Example.com>, bob@example.com (Bob), Team: a@x.test, "q\\"<c@x.test>" <d@x.test>;',
      ),
    ).toEqual(["jane@example.com", "bob@example.com", "a@x.test", "d@x.test"]);
  });

  it("yields nothing for malformed or unterminated entries", () => {
    expect(headerAddresses("<member@example.com, member")).toEqual([]);
    expect(headerAddresses("undisclosed-recipients:;")).toEqual([]);
  });
});
