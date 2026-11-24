import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AUTHORIZE_URL,
  BROKER,
  TOKEN,
  SANDBOXED,
  plugin,
  thread,
  fetchMock,
  installDelegationFixtures,
  mints,
} from "./admin-delegation.test-helpers.js";

installDelegationFixtures();
const directories = useAutoCleanupTempDirTracker(afterEach);
const source = Buffer.from("%PDF-1.4\nfixture drawing excerpt\n");
const sessionKey = "agent:cellect-main:matrix:channel:!room:matrix.example:thread:$root";
const command =
  "cellect fi build rfi attach --tenant sample --project project --rfi RFI-001 --role source --expect-environment prod --actor admin@example.test --file /workspace/excerpt.pdf";
let workspace: string;
let receiptRequests: Record<string, unknown>[];
let respond: () => Promise<Response>;

beforeEach(async () => {
  workspace = directories.make("operator-command-");
  await fs.writeFile(path.join(workspace, "excerpt.pdf"), source);
  receiptRequests = [];
  respond = async () =>
    new Response(
      JSON.stringify({
        ok: true,
        agentId: "cellect-main",
        credentialClass: "operator",
        orgId: "org-a",
        operationCommand: {
          orgId: "org-a",
          receipt: TOKEN,
          expiresAt: Math.floor(Date.now() / 1000) + 120,
        },
      }),
    );
  vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    if (url !== AUTHORIZE_URL) {
      throw new Error("Operator must never request a user delegation");
    }
    if (typeof init.body !== "string") {
      throw new Error("Authorization request must contain JSON text");
    }
    const body = JSON.parse(init.body);
    if (body.operationCommand) {
      receiptRequests.push(body);
      return respond();
    }
    return new Response(
      JSON.stringify({
        ok: true,
        agentId: "cellect-main",
        credentialClass: "operator",
        orgId: "org-a",
      }),
    );
  });
});

function operator() {
  return plugin(
    { tenantOrgId: undefined, operatorAgentId: "cellect-main" },
    {
      ...SANDBOXED,
      talk: { agentId: "cellect-main" },
      agents: {
        defaults: { sandbox: { ...SANDBOXED.agents.defaults.sandbox, scope: "session" } },
      },
    },
  );
}
async function admit(turn: ReturnType<typeof operator>, overrides: Record<string, unknown> = {}) {
  await turn.arrive({ ...thread().arrive, sessionKey });
  return turn.start({
    ...thread().start,
    agentId: "cellect-main",
    sessionKey,
    workspaceDir: workspace,
    ...overrides,
  });
}
const execute = (
  turn: ReturnType<typeof operator>,
  overrides: Record<string, unknown> = {},
  text = command,
) =>
  turn.exec(
    { ...thread().exec, agentId: "cellect-main", sessionKey, ...overrides },
    { toolName: "sandbox_exec", params: { command: text } },
  );

it("binds a literal escaped workspace filename to the same operation receipt and file hash", async () => {
  const name = "drawing's (rev 2).pdf";
  await fs.writeFile(path.join(workspace, name), source);
  const turn = operator();
  await admit(turn);
  const rewritten = await execute(
    turn,
    {},
    command.replace("/workspace/excerpt.pdf", String.raw`/workspace/drawing\'s\ \(rev\ 2\).pdf`),
  );
  expect(rewritten?.params.env?.FI_OPERATION_RECEIPT_TOKEN).toBe(TOKEN);
  expect(receiptRequests).toHaveLength(1);
  expect(receiptRequests[0]).toMatchObject({
    operationCommand: {
      file: { name, sha256: createHash("sha256").update(source).digest("hex") },
      argv: expect.arrayContaining([`/workspace/${name}`]),
    },
  });
  expect(mints()).toHaveLength(0);
});

it("forwards only a file-bound operation receipt from the actual operator/no-tenant configuration", async () => {
  const turn = operator();
  await admit(turn);
  const rewritten = await execute(turn);
  expect(rewritten?.params).toMatchObject({
    host: "sandbox",
    elevated: false,
    env: { FI_OPERATION_RECEIPT_TOKEN: TOKEN, FI_APP_URL: "https://fi.example.test/fi" },
  });
  expect(rewritten?.params.env).not.toHaveProperty("FI_DELEGATED_USER_TOKEN");
  expect(JSON.stringify(rewritten)).not.toContain(BROKER);
  expect(mints()).toHaveLength(0);
  expect(receiptRequests).toHaveLength(1);
  expect(receiptRequests[0]).toMatchObject({
    roomId: "!room:matrix.example",
    eventId: "$e1",
    agentId: "cellect-main",
    recheck: true,
    operationCommand: {
      operation: "build.rfi.attach",
      file: { name: "excerpt.pdf", sha256: createHash("sha256").update(source).digest("hex") },
      proof: {
        roomId: "!room:matrix.example",
        eventId: "$e1",
        threadRootEventId: "$root",
        sessionKey,
        senderMxid: "@admin:matrix.example",
        accountId: "adminprod",
        runId: "run-1",
        toolCallId: "command-1",
      },
    },
  });
});

it.each(["synthetic", "voice", "foreign sender", "wrong account", "wrong run", "no dispatch"])(
  "refuses an RFI upload with %s custody",
  async (scenario) => {
    const turn = operator();
    if (scenario !== "no dispatch") {
      await admit(
        turn,
        scenario === "synthetic"
          ? { trigger: "heartbeat" }
          : scenario === "voice"
            ? {
                channelContext: {
                  sender: { id: "@admin:matrix.example" },
                  chat: { id: "!room:matrix.example", talkThreadRootEventId: "$root" },
                },
              }
            : {},
      );
    }
    if (scenario === "foreign sender") {
      await turn.inject({ ...thread("@other:matrix.example").arrive, sessionKey });
    }
    const result = await execute(
      turn,
      scenario === "wrong account"
        ? { requester: { ...thread().exec.requester, accountId: "other" } }
        : scenario === "wrong run"
          ? { runId: "other" }
          : {},
    );
    expect(result?.block).toBe(true);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(receiptRequests).toHaveLength(0);
  },
);

it.each(["outside workspace", "symlink", "hardlink", "oversized"])(
  "never grants arbitrary file access: %s",
  async (scenario) => {
    const turn = operator();
    await admit(turn);
    let file = "/workspace/excerpt.pdf";
    if (scenario === "outside workspace") {
      file = "/workspace/../outside.pdf";
    }
    if (scenario === "symlink") {
      await fs.symlink("excerpt.pdf", path.join(workspace, "linked.pdf"));
      file = "/workspace/linked.pdf";
    }
    if (scenario === "hardlink") {
      await fs.link(path.join(workspace, "excerpt.pdf"), path.join(workspace, "linked.pdf"));
      file = "/workspace/linked.pdf";
    }
    if (scenario === "oversized") {
      await fs.truncate(path.join(workspace, "excerpt.pdf"), 25 * 1024 * 1024 + 1);
    }
    expect((await execute(turn, {}, command.replace("/workspace/excerpt.pdf", file)))?.block).toBe(
      true,
    );
    expect(receiptRequests).toHaveLength(0);
  },
);

it.each(["refused", "wrong tenant", "settled run", "steered run"])(
  "rejects %s while Fi issues the receipt",
  async (scenario) => {
    const turn = operator();
    await admit(turn);
    const success = respond;
    respond = async () => {
      if (scenario === "refused") {
        return new Response("Forbidden", { status: 403 });
      }
      if (scenario === "wrong tenant") {
        return new Response(
          JSON.stringify({
            ok: true,
            agentId: "cellect-main",
            credentialClass: "operator",
            orgId: "org-other",
          }),
        );
      }
      if (scenario === "settled run") {
        await turn.settle();
      }
      if (scenario === "steered run") {
        await turn.inject({ ...thread("@other:matrix.example").arrive, sessionKey });
      }
      return success();
    };
    const result = await execute(turn);
    expect(result?.block).toBe(true);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  },
);

it("keeps ordinary operator commands on their existing path without minting any user token", async () => {
  const turn = operator();
  await admit(turn);
  const result = await execute(
    turn,
    {},
    "cellect fi build budget show --tenant sample --project project",
  );
  expect(result?.params.env).not.toHaveProperty("FI_OPERATION_RECEIPT_TOKEN");
  expect(result?.params.env).not.toHaveProperty("FI_DELEGATED_USER_TOKEN");
  expect(receiptRequests).toEqual([]);
  expect(mints()).toEqual([]);
});
