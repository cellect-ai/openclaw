import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import { adminActionSessions } from "./admin-action.js";
import {
  AUTHORIZE_URL,
  BROKER,
  fetchMock,
  installDelegationFixtures,
  matrix,
  MATRIX_SESSION,
  minted,
  mintBody,
  mints,
  MINT_URL,
  plugin,
  SESSION,
  SLACK_THREAD,
  thread,
  THREAD,
  TOKEN,
} from "./admin-delegation.test-helpers.js";

installDelegationFixtures();
const ROOT = "https://fi.example.test/fi/api/a/admin-operations";
const EXECUTE_URL = `${ROOT}/build.rfi.reopen/default`;
const execute = { action: "execute", operation: "build.rfi.reopen", variant: "default", input: {} };
const row = (overrides: Record<string, unknown> = {}) => ({
  operation: "build.rfi.reopen",
  variant: "default",
  command: "cellect fi build rfi reopen",
  description: "Reopen an RFI",
  mutates: true,
  file: null,
  inputFiles: {},
  localFiles: [],
  outputFiles: [],
  requiredOutputs: [],
  ...overrides,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const catalog = (overrides: Record<string, unknown> = {}) =>
  json({ ok: true, operations: [row()], nextOffset: null, ...overrides });
const posts = () => fetchMock.mock.calls.filter(([url]) => url === EXECUTE_URL);
const catalogs = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith(`${ROOT}?`));

function respond(
  options: { catalog?: () => Response; post?: () => Response | Promise<Response> } = {},
) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === MINT_URL) return minted();
    if (url.startsWith(`${ROOT}?`)) return options.catalog?.() ?? catalog();
    if (url === EXECUTE_URL)
      return options.post?.() ?? json({ ok: true, result: { status: "open" } });
    if (url === AUTHORIZE_URL)
      return json({ ok: true, agentId: "cellect-fi-admin", orgId: "org-a" });
    throw new Error("Unexpected external boundary");
  });
}

function context(
  overrides: Partial<OpenClawPluginToolContext<2>> = {},
): OpenClawPluginToolContext<2> {
  return {
    runId: "run-1",
    agentId: "cellect-fi-admin",
    sessionKey: SESSION,
    sessionId: "session-1",
    messageChannel: "slack",
    requesterSenderId: "U0ADMIN001",
    assertInvocationCurrent: vi.fn(),
    ...overrides,
  };
}

async function ready(overrides: Partial<OpenClawPluginToolContext<2>> = {}) {
  const turn = plugin();
  await turn.arrive();
  await turn.start();
  const ctx = context(overrides);
  const tool = turn.tools(ctx).find((candidate) => candidate.name === "fi_admin_operation")!;
  return { turn, ctx, tool };
}

describe("registered Fi-admin structured operation transport", () => {
  it("discovers through the current requester's catalog and preserves its envelope", async () => {
    respond();
    const { tool } = await ready();
    const result = await tool.execute("call-1", { action: "discover", limit: 25, offset: 0 });
    expect(result.details).toMatchObject({
      httpStatus: 200,
      response: { ok: true, operations: [row()], nextOffset: null },
      typedExecution: [{ operation: "build.rfi.reopen", variant: "default", supported: true }],
    });
    expect(mintBody()).toEqual({ requesterSenderId: "U0ADMIN001", agentId: "cellect-fi-admin" });
    expect(catalogs()[0]![0]).toBe(`${ROOT}?limit=25&offset=0`);
    expect(posts()).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(BROKER);
  });

  it("executes structured data once, without interpreting shell syntax or replacing server receipts", async () => {
    const receipt = {
      ok: true,
      result: { status: "open" },
      requestId: "server-1",
      warnings: ["Retained warning"],
    };
    respond({ post: () => json(receipt) });
    const { tool } = await ready();
    const input = {
      comment: "Keep $HOME and `literal`\nAlex's review; no shell",
      actor: "other@example.com",
    };
    const result = await tool.execute("call-1", { ...execute, input, dryRun: true });
    expect(result.details).toEqual({ httpStatus: 200, response: receipt, dispatched: true });
    expect(posts()).toHaveLength(1);
    const request = posts()[0]![1] as RequestInit;
    expect(request.method).toBe("POST");
    expect(request.redirect).toBe("error");
    expect(new Headers(request.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse((request.body as FormData).get("input") as string)).toEqual(input);
    expect((request.body as FormData).get("dryRun")).toBe("true");
    // The server owns actor binding/rejection. The gateway never silently attributes a supplied actor.
    expect([...(request.body as FormData).keys()]).toEqual(["input", "dryRun"]);
  });

  it("uses the Matrix requester's selected environment", async () => {
    respond();
    vi.stubEnv("FIXTURE_DEV_BROKER", "fixture-dev-credential");
    const turn = plugin({
      matrixEnvironments: {
        admindev: { baseUrl: "https://dev.example.test/fi", brokerTokenEnv: "FIXTURE_DEV_BROKER" },
      },
    });
    await turn.arrive(matrix.arrive);
    await turn.start({ ...matrix.start, accountId: "admindev" });
    const tool = turn.tools(
      context({
        sessionKey: MATRIX_SESSION,
        messageChannel: "matrix",
        requesterSenderId: "@admin:matrix.example",
        agentAccountId: "admindev",
      }),
    )[0]!;
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("openclaw-user-delegation") ? minted() : catalog(),
    );
    await tool.execute("matrix-call", { action: "discover" });
    expect(fetchMock.mock.calls.at(-2)![0]).toBe(
      "https://dev.example.test/fi/api/openclaw-user-delegation",
    );
    expect(JSON.parse((fetchMock.mock.calls.at(-2)![1] as RequestInit).body as string)).toEqual({
      requesterMatrixUserId: "@admin:matrix.example",
      agentId: "cellect-fi-admin",
    });
    expect(fetchMock.mock.calls.at(-1)![0]).toBe(
      "https://dev.example.test/fi/api/a/admin-operations?",
    );
  });

  it("retains the native continuation and refuses it after revocation", async () => {
    respond();
    const turn = plugin();
    const current = vi.fn();
    const continuation = {
      channel: "slack",
      senderId: "U0ADMIN001",
      sourceTurnId: "source",
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: SESSION,
      agentId: "cellect-fi-admin",
      assertCurrent: current,
    };
    await turn.start({ requesterContinuation: continuation, sessionId: "session-1" });
    const tool = turn.tools(context())[0]!;
    await tool.execute("continued", { action: "discover" });
    expect(mints()).toHaveLength(1);
    current.mockImplementation(() => {
      throw new Error("revoked");
    });
    await expect(tool.execute("revoked", execute)).rejects.toThrow("verified");
    expect(mints()).toHaveLength(1);
    expect(posts()).toHaveLength(0);
  });

  it("uses the admitted Matrix reply when its source session is reported as Slack", async () => {
    respond();
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
    const turn = plugin();
    const senderId = "@admin:matrix.example";
    const roomId = "!projection:matrix.example";
    const eventId = "$reply";
    await turn.arrive({
      channel: "matrix",
      accountId: "adminprod",
      senderId,
      sessionKey: SLACK_THREAD,
      isGroup: true,
      messageId: eventId,
      channelContext: {
        sender: { id: senderId },
        chat: {
          id: roomId,
          eventId,
          sourceReplyAdmission: {
            version: 1,
            sessionKey: SLACK_THREAD,
            roomId,
            senderId,
            accountId: "adminprod",
            eventId,
            authorizedAt: Date.now(),
          },
        },
      },
    });
    await turn.start({
      channel: "matrix",
      senderId,
      sessionKey: SLACK_THREAD,
      accountId: "adminprod",
      chatId: roomId,
      channelContext: { sender: { id: senderId }, chat: { id: roomId, eventId } },
    });
    const tool = turn.tools(
      context({ sessionKey: SLACK_THREAD, messageChannel: "slack", requesterSenderId: senderId }),
    )[0]!;
    await tool.execute("projected", { action: "discover" });
    expect(mintBody()).toEqual({ requesterMatrixUserId: senderId, agentId: "cellect-fi-admin" });
  });

  it("refuses a Matrix environment changed while minting for the same person", async () => {
    respond();
    const environments = {
      adminprod: { baseUrl: "https://fi.example.test/fi", brokerTokenEnv: "FIXTURE_BROKER" },
    };
    const turn = plugin({ matrixEnvironments: environments });
    await turn.arrive(matrix.arrive);
    await turn.start(matrix.start);
    const tool = turn.tools(
      context({
        sessionKey: MATRIX_SESSION,
        messageChannel: "matrix",
        requesterSenderId: "@admin:matrix.example",
        agentAccountId: "adminprod",
      }),
    )[0]!;
    fetchMock.mockImplementation(async () => {
      environments.adminprod.baseUrl = "https://other.example.test/fi";
      return minted();
    });
    await expect(tool.execute("changed-environment", execute)).rejects.toThrow("changed");
    expect(catalogs()).toHaveLength(0);
    expect(posts()).toHaveLength(0);
  });

  it("uses an admitted voice speaker without manufacturing a text arrival", async () => {
    respond();
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
    const turn = plugin();
    await turn.start({
      ...thread().start,
      channelContext: {
        sender: { id: "@admin:matrix.example" },
        chat: { id: "!room:matrix.example", talkThreadRootEventId: "$root" },
      },
    });
    const tool = turn.tools(
      context({
        sessionKey: THREAD,
        messageChannel: "matrix",
        requesterSenderId: "@admin:matrix.example",
        agentAccountId: "adminprod",
      }),
    )[0]!;
    await tool.execute("voice", { action: "discover" });
    expect(mintBody()).toEqual({
      requesterMatrixUserId: "@admin:matrix.example",
      agentId: "cellect-fi-admin",
    });
  });

  it.each([
    { runId: "unknown-run" },
    { sessionKey: `${SESSION}9` },
    { requesterSenderId: "U0OTHER002" },
  ])("refuses mismatched native custody before minting: %j", async (overrides) => {
    respond();
    const { tool } = await ready(overrides);
    await expect(tool.execute("call-1", execute)).rejects.toThrow("verified");
    expect(mints()).toHaveLength(0);
    expect(posts()).toHaveLength(0);
  });

  it("refuses settled runs and approved-action sessions", async () => {
    respond();
    const { tool, turn } = await ready();
    await turn.settle();
    await expect(tool.execute("settled", execute)).rejects.toThrow("verified");
    const next = await ready();
    adminActionSessions.set(SESSION, {} as never);
    try {
      await expect(next.tool.execute("approved", execute)).rejects.toThrow("verified");
    } finally {
      adminActionSessions.delete(SESSION);
    }
    expect(mints()).toHaveLength(0);
  });

  it("rechecks native custody after minting before discovery or dispatch", async () => {
    const { tool, turn } = await ready();
    fetchMock.mockImplementation(async () => {
      await turn.settle();
      return minted();
    });
    await expect(tool.execute("changed", execute)).rejects.toThrow("changed");
    expect(catalogs()).toHaveLength(0);
    expect(posts()).toHaveLength(0);
  });

  it("rechecks invocation authority after discovery, before dispatch", async () => {
    const { tool, ctx } = await ready();
    respond({
      catalog: () => {
        ctx.assertInvocationCurrent = () => {
          throw new Error("retired");
        };
        return catalog();
      },
    });
    await expect(tool.execute("changed", execute)).rejects.toThrow("retired");
    expect(posts()).toHaveLength(0);
  });

  it("never requests credentials for an aborted call", async () => {
    const { tool } = await ready();
    await expect(tool.execute("aborted", execute, AbortSignal.abort())).rejects.toThrow();
    expect(mints()).toHaveLength(0);
  });

  it.each([
    ["another tenant", {}, { orgId: "other" }],
    ["an expired token", { expiresAt: 1 }, {}],
    ["a malformed token", { token: "not-a-token" }, {}],
  ])("refuses %s before discovery", async (_label, fi, user) => {
    const { tool } = await ready();
    fetchMock.mockResolvedValueOnce(minted(fi, user));
    await expect(tool.execute("invalid-delegation", execute)).rejects.toThrow();
    expect(catalogs()).toHaveLength(0);
    expect(posts()).toHaveLength(0);
  });

  it.each([
    { action: "execute", operation: "../other", variant: "default", input: {} },
    { ...execute, file: "/workspace/file.pdf" },
    { ...execute, tenant: "other" },
    { ...execute, headers: { authorization: "supplied" } },
    { action: "discover", variant: "default" },
  ])("refuses invalid transport arguments before minting: %j", async (input) => {
    const { tool } = await ready();
    await expect(tool.execute("invalid", input)).rejects.toThrow();
    expect(mints()).toHaveLength(0);
  });

  it.each([
    { inputFiles: { manifest: "json" } },
    { file: { default: "required" } },
    { localFiles: ["sourcePath"] },
    { outputFiles: ["output"] },
    { requiredOutputs: ["output"] },
    { inputFiles: undefined },
  ])("labels unsupported file transport and refuses before dispatch: %j", async (files) => {
    respond({ catalog: () => catalog({ operations: [row(files)] }) });
    const { tool } = await ready();
    const discovery = await tool.execute("discover", { action: "discover" });
    expect(discovery.details).toMatchObject({ typedExecution: [{ supported: false }] });
    await expect(
      tool.execute("execute", { ...execute, input: { sourcePath: "/etc/passwd" } }),
    ).rejects.toThrow(/file/i);
    expect(posts()).toHaveLength(0);
  });

  it.each([
    { operations: [] },
    { operations: [row(), row()] },
    { operations: [row({ operation: "other.operation" })] },
    { nextOffset: 1 },
  ])("refuses an ambiguous or stale execution catalog: %j", async (body) => {
    respond({ catalog: () => catalog(body) });
    const { tool } = await ready();
    await expect(tool.execute("execute", execute)).rejects.toThrow("exactly one");
    expect(posts()).toHaveLength(0);
  });

  it("preserves a current membership refusal without attempting execution or another credential", async () => {
    const refusal = {
      error: "Schedule dates are changed by an org owner or admin",
      code: "forbidden",
    };
    respond({ catalog: () => json(refusal, 403) });
    const { tool } = await ready();
    const result = await tool.execute("execute", execute);
    expect(result.details).toEqual({ httpStatus: 403, response: refusal, dispatched: false });
    expect(mints()).toHaveLength(1);
    expect(posts()).toHaveLength(0);
  });

  it.each([
    { ok: false, error: "invalid", execution: { state: "not-started" } },
    { ok: false, error: "partial", execution: { state: "not-started" }, result: { applied: true } },
    {
      ok: false,
      error: "output failed",
      completed: true,
      result: { applied: true },
      outputUnconfirmed: true,
      requestId: "server-2",
    },
    { ok: false, error: "unconfirmed" },
  ])("preserves failure receipts and never retries: %j", async (receipt) => {
    respond({ post: () => json(receipt, 400) });
    const { tool } = await ready();
    const result = await tool.execute("execute", execute);
    expect(result.details).toMatchObject({
      httpStatus: 400,
      response: receipt,
      dispatched: true,
      recovery: { automaticRetry: false },
    });
    const notStarted = receipt.execution?.state === "not-started" && !("result" in receipt);
    expect(result.details).toMatchObject({
      recovery: { outcome: notStarted ? "not-started" : "unconfirmed" },
    });
    expect(posts()).toHaveLength(1);
    expect(mints()).toHaveLength(1);
  });

  it.each([
    () => Promise.reject(new Error("transport lost")),
    () => new Response("<html>failure</html>", { status: 502 }),
    () => new Response("not JSON", { status: 200 }),
  ])("does not replay a dispatch with an unknown result", async (post) => {
    respond({ post });
    const { tool } = await ready();
    const result = await tool.execute("execute", execute);
    expect(result.details).toMatchObject({
      dispatched: true,
      recovery: { outcome: "unconfirmed", automaticRetry: false },
    });
    expect(posts()).toHaveLength(1);
  });
});
