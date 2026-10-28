import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  PluginAgentEventSubscriptionRegistration,
} from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fiUserPlugin from "./index.js";

type Factory = {
  create(context: OpenClawPluginToolContext<2>): AnyAgentTool | AnyAgentTool[] | null;
};
type Hook = (event: never, context: never) => unknown;
const room = "!room:matrix.test",
  root = "$root",
  sender = "@human:matrix.test";
const sessionKey = `agent:cellect-main:matrix:channel:${room}:thread:${root}`;
const hookContext = {
  runId: "native-run",
  agentId: "cellect-main",
  channel: "matrix",
  accountId: "operatorprod",
  senderId: sender,
  chatId: room,
  sessionKey,
  channelContext: { sender: { id: sender }, chat: { id: room, eventId: "$event" } },
};
const toolContext = (): OpenClawPluginToolContext<2> => ({
  runId: hookContext.runId,
  agentId: "cellect-main",
  messageChannel: "matrix",
  agentAccountId: "operatorprod",
  sessionKey,
  nativeChannelId: room,
  currentMessageId: "$event",
  requesterSenderId: sender,
  assertInvocationCurrent: vi.fn(),
});
const fetchMock = vi.fn();
function fixture() {
  const hooks = new Map<string, Hook[]>(),
    subscriptions: PluginAgentEventSubscriptionRegistration[] = [];
  let factory: Factory;
  const cfg = {
    talk: { agentId: "cellect-main" },
    plugins: {
      entries: {
        "fi-user": {
          enabled: true,
          config: {
            operatorAgentId: "cellect-main",
            baseUrl: "https://fi.test/fi",
            brokerTokenEnv: "WORKBOOK_TEST_BROKER",
          },
        },
      },
    },
  };
  fiUserPlugin.register?.(
    createTestPluginApi({
      id: "fi-user",
      config: cfg,
      runtime: {
        channel: { runtimeContexts: { register: vi.fn() } },
      } as unknown as OpenClawPluginApi["runtime"],
      on: (name, handler) => hooks.set(name, [...(hooks.get(name) ?? []), handler as never]),
      registerAgentEventSubscription: (entry) => subscriptions.push(entry),
      registerTool: (registration) => {
        factory = registration as Factory;
      },
    }),
  );
  return {
    async admit(extra = {}) {
      for (const h of hooks.get("before_agent_reply") ?? []) {
        const result = await h({} as never, { ...hookContext, ...extra } as never);
        if (result) {
          return result;
        }
      }
      return undefined;
    },
    tool(context = toolContext()) {
      const result = factory.create(context);
      return (Array.isArray(result) ? result : result ? [result] : []).find(
        (t) => t.name === "fi_workbook",
      );
    },
    async retire() {
      for (const s of subscriptions) {
        await s.handle(
          {
            runId: "native-run",
            stream: "lifecycle",
            data: { phase: "end", executionSettled: true },
          } as never,
          {} as never,
        );
      }
    },
  };
}
const allow = () =>
  new Response(
    JSON.stringify({
      ok: true,
      credentialClass: "operator",
      orgId: "admitted-org",
      agentId: "cellect-main",
    }),
  );
const workbook = () =>
  new Response(
    JSON.stringify({
      ok: true,
      orgId: "admitted-org",
      sheet: {
        fieldId: "workbook-field",
        workbook: { sheetOrder: ["existing"], sheets: { existing: { name: "Original" } } },
        collabRevision: 81,
      },
    }),
  );
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("WORKBOOK_TEST_BROKER", "fixture-broker");
  vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ operatorprod: "prod" }));
  fetchMock
    .mockReset()
    .mockImplementation(async (url: string) =>
      url.endsWith("/agent-authorize") ? allow() : workbook(),
    );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("offers the native API reader only after the genuine operator Matrix turn is admitted, retaining the Talk guard", async () => {
  const f = fixture();
  expect(f.tool()).toBeUndefined();
  await f.admit();
  const tool = f.tool();
  expect(tool).toBeDefined();
  const result = await tool!.execute("read", {
    action: "get",
    roomId: "data-room",
    fieldId: "workbook-field",
  });
  expect(result.details).toMatchObject({ ok: true, sheet: { collabRevision: 81 } });
  const [requestUrl, init] = fetchMock.mock.calls.find(([url]) => url.endsWith("/workbook"))!;
  expect(requestUrl).toBe("https://fi.test/fi/api/threads/workbook");
  expect(JSON.parse(init.body)).toEqual({
    action: "get",
    target: { roomId: "data-room", fieldId: "workbook-field" },
    proof: {
      roomId: room,
      eventId: "$event",
      threadRootEventId: root,
      senderMxid: sender,
      accountId: "operatorprod",
      runId: "native-run",
      sessionKey,
    },
  });
  expect(init.headers).toEqual({
    authorization: "Bearer fixture-broker",
    "content-type": "application/json",
  });
  expect(JSON.stringify(result)).not.toContain("fixture-broker");
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/openclaw-user-delegation"))).toBe(
    false,
  );
});
it.each([
  { runId: "different" },
  { sessionKey: sessionKey + "wrong" },
  { agentAccountId: "wrong" },
  { requesterSenderId: "@other:matrix.test" },
  { currentMessageId: "$old" },
  { nativeChannelId: "!other:matrix.test" },
  { messageChannel: "webchat" },
  { agentId: "cellect-fi-admin" },
])("does not offer the reader with mismatched native custody %j", async (mismatch) => {
  const f = fixture();
  await f.admit();
  expect(f.tool({ ...toolContext(), ...mismatch })).toBeUndefined();
});
it("refuses synthetic completion admission and retired tools without making a workbook request", async () => {
  const f = fixture();
  await f.admit({ inputProvenance: { kind: "internal_system", sourceTool: "exec" } });
  expect(f.tool()).toBeUndefined();
  await f.admit();
  const tool = f.tool()!;
  await f.retire();
  fetchMock.mockClear();
  await expect(
    tool.execute("stale", { action: "get", roomId: "data-room", fieldId: "workbook-field" }),
  ).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
});
it.each([
  { action: "save" },
  { action: "get", orgId: "other" },
  { action: "get", actor: "victim@example.com" },
  { action: "get", method: "PUT" },
  { action: "get", roomId: "../room" },
])("rejects unsupported operations and model authority %j", async (extra) => {
  const f = fixture();
  await f.admit();
  const tool = f.tool()!;
  fetchMock.mockClear();
  await expect(
    tool.execute("bad", {
      roomId: "data-room",
      fieldId: "workbook-field",
      ...extra,
    }),
  ).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
});
it.each(["internal_system", "inter_session"])(
  "does not offer a workbook tool for %s synthetic input",
  async (kind) => {
    const f = fixture();
    await f.admit({ inputProvenance: { kind, sourceTool: "heartbeat" } });
    expect(f.tool()).toBeUndefined();
  },
);
it("does not return a late result after native custody ends during the API read", async () => {
  const f = fixture();
  await f.admit();
  const tool = f.tool()!;
  fetchMock.mockImplementationOnce(async () => {
    await f.retire();
    return workbook();
  });
  await expect(
    tool.execute("late", { action: "get", roomId: "data-room", fieldId: "workbook-field" }),
  ).rejects.toThrow();
});
it("refuses an API answer for another admitted tenant", async () => {
  const f = fixture();
  await f.admit();
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({ ok: true, orgId: "other", sheet: { fieldId: "workbook-field" } }),
    ),
  );
  await expect(
    f.tool()!.execute("cross", { action: "get", roomId: "data-room", fieldId: "workbook-field" }),
  ).rejects.toThrow("does not match");
});

it("refuses oversized upstream workbook output before publishing it to the model", async () => {
  const f = fixture();
  await f.admit();
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        ok: true,
        orgId: "admitted-org",
        sheet: { fieldId: "workbook-field", value: "x".repeat(33000) },
      }),
    ),
  );
  await expect(
    f.tool()!.execute("large", { action: "get", roomId: "data-room", fieldId: "workbook-field" }),
  ).rejects.toThrow("too large");
});

const importArguments = {
  action: "import-tabs",
  roomId: "data-room",
  fieldId: "workbook-field",
  sourceDocumentId: "00000000-0000-4000-8000-000000000001",
  sourceSha256: "a".repeat(64),
  collabSessionId: "00000000-0000-4000-8000-000000000002",
  expectedCollabRevision: 81,
  roomVersion: 865,
  operationId: "native-import-stable-operation-0001",
};
it("retains exact import identity on a preview and same-key retry, without exposing a snapshot or credentials", async () => {
  const f = fixture();
  await f.admit();
  const tool = f.tool()!;
  fetchMock.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          orgId: "admitted-org",
          sheet: { fieldId: "workbook-field" },
          operationId: importArguments.operationId,
          outcome: "preview",
          automaticRetry: false,
        }),
      ),
  );
  await tool.execute("preview", { ...importArguments, dryRun: true });
  await tool.execute("retry-preview", { ...importArguments, dryRun: true });
  const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));
  expect(bodies).toHaveLength(3); // Initial native admission plus two fixed API calls.
  expect(bodies.slice(-2).map((body) => body.operationId)).toEqual([
    importArguments.operationId,
    importArguments.operationId,
  ]);
  expect(bodies.at(-1)).toMatchObject({
    action: "import-tabs",
    sourceSha256: importArguments.sourceSha256,
    expectedCollabRevision: 81,
    roomVersion: 865,
    dryRun: true,
  });
  expect(bodies.at(-1)).not.toHaveProperty("actor");
  expect(bodies.at(-1)).not.toHaveProperty("orgId");
});
it("returns the explicit accepted receipt even when post-commit readback failed", async () => {
  const f = fixture();
  await f.admit();
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        ok: false,
        orgId: "admitted-org",
        sheet: { fieldId: "workbook-field" },
        operationId: importArguments.operationId,
        outcome: "accepted",
        automaticRetry: false,
        accepted: { revision: 82, unitId: "unit" },
        error: "append_accepted_readback_unavailable",
      }),
      { status: 503 },
    ),
  );
  const result = await f.tool()!.execute("import", importArguments);
  expect(result.details).toMatchObject({
    ok: false,
    outcome: "accepted",
    accepted: { revision: 82 },
    operationId: importArguments.operationId,
    automaticRetry: false,
  });
});
it("does not retry an uncertain publication and retains the exact operation key in its failure", async () => {
  const f = fixture();
  await f.admit();
  fetchMock.mockClear();
  fetchMock.mockRejectedValueOnce(new Error("network failed"));
  await expect(f.tool()!.execute("import", importArguments)).rejects.toThrow(
    `outcome unconfirmed for operation ${importArguments.operationId}`,
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it.each([
  { workbook: {} },
  { file: "/tmp/source.xlsx" },
  { actor: "victim@example.com" },
  { orgId: "other" },
  { dryRun: "true" },
  { operationId: "short" },
  { expectedCollabRevision: -1 },
])("refuses unsafe import overrides %j", async (extra) => {
  const f = fixture();
  await f.admit();
  fetchMock.mockClear();
  await expect(f.tool()!.execute("bad-import", { ...importArguments, ...extra })).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
});
