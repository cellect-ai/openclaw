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
function fixture(agentId = "cellect-main", channel: "matrix" | "slack" = "matrix") {
  const nativeSession =
    channel === "matrix"
      ? `agent:${agentId}:matrix:channel:${room}:thread:${root}`
      : `agent:${agentId}:slack:channel:c0channel1:thread:1792190933.152459`;
  const senderId = channel === "matrix" ? sender : "U0ADMIN001";
  const nativeHookContext = {
    ...hookContext,
    agentId,
    sessionKey: nativeSession,
    channel,
    senderId,
    trigger: "user",
    channelContext: {
      sender: { id: senderId },
      chat: {
        id: channel === "matrix" ? room : "C0CHANNEL1",
        eventId: channel === "matrix" ? "$event" : "1792190933.152459",
      },
    },
  };
  const nativeToolContext = () => ({
    ...toolContext(),
    agentId,
    sessionKey: nativeSession,
    messageChannel: channel,
    requesterSenderId: senderId,
  });
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
            ...(agentId === "cellect-main"
              ? { operatorAgentId: "cellect-main" }
              : { tenantOrgId: "admitted-org" }),
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
    config: cfg,
    async arriveSlack() {
      const event = {
        content: "Edit workbook",
        channel: "slack",
        sessionKey: nativeSession,
        senderId,
        isGroup: true,
        messageId: "1792190933.152459",
        senderAuthentication: "verified",
      };
      for (const name of ["message_received", "before_dispatch"]) {
        for (const h of hooks.get(name) ?? []) {
          await h(event as never, { channelId: "slack", sessionKey: nativeSession } as never);
        }
      }
    },
    async admit(extra = {}) {
      for (const h of hooks.get("before_agent_reply") ?? []) {
        const result = await h({} as never, { ...nativeHookContext, ...extra } as never);
        if (result) {
          return result;
        }
      }
      return undefined;
    },
    tools(context = nativeToolContext()) {
      const result = factory.create(context);
      return Array.isArray(result) ? result : result ? [result] : [];
    },
    tool(context = nativeToolContext()) {
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
const allow = (agentId = "cellect-main") =>
  new Response(
    JSON.stringify({
      ok: true,
      credentialClass: agentId === "cellect-main" ? "operator" : "tenant",
      orgId: "admitted-org",
      agentId,
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
    .mockImplementation(async (url: string, init?: RequestInit) =>
      url.endsWith("/agent-authorize") ? allow(JSON.parse(String(init?.body)).agentId) : workbook(),
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
      agentId: "cellect-main",
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

it.each(["cellect-fi-admin", "cellect-fi-user"])(
  "offers the native workbook API to admitted tenant agent %s",
  async (agentId) => {
    const f = fixture(agentId);
    expect(f.tool()).toBeUndefined();
    await f.admit();
    expect(f.tool()).toBeDefined();
    if (agentId === "cellect-fi-user") {
      expect(f.tools().map((tool) => tool.name)).toContain("fi_user_api");
    }
    await f
      .tool()!
      .execute("read", { action: "get", roomId: "data-room", fieldId: "workbook-field" });
    const request = JSON.parse(
      fetchMock.mock.calls.find(([url]) => url.endsWith("/workbook"))![1].body,
    );
    expect(request.proof).toMatchObject({
      agentId,
      sessionKey: `agent:${agentId}:matrix:channel:${room}:thread:${root}`,
      senderMxid: sender,
    });
  },
);
const editArguments = {
  action: "edit",
  roomId: "data-room",
  fieldId: "workbook-field",
  collabSessionId: importArguments.collabSessionId,
  expectedCollabRevision: 81,
  roomVersion: 865,
  operationId: "native-edit-stable-operation-0001",
  mutations: [
    {
      id: "sheet.mutation.set-range-values",
      params: { unitId: "unit", subUnitId: "existing", cellValue: { 0: { 0: { s: { bl: 1 } } } } },
    },
  ],
};
it("withdraws an admitted tenant workbook tool when the configured tenant changes", async () => {
  const f = fixture("cellect-fi-admin");
  await f.admit();
  const tool = f.tool()!;
  Object.assign(f.config.plugins.entries["fi-user"].config, { tenantOrgId: "another-org" });
  fetchMock.mockClear();
  await expect(tool.execute("edit", editArguments)).rejects.toThrow("Access verification");
  expect(fetchMock).not.toHaveBeenCalled();
});
it("passes native formatting mutations unchanged and retains write receipts for the tenant admin", async () => {
  const f = fixture("cellect-fi-admin");
  await f.admit();
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        ok: true,
        orgId: "admitted-org",
        sheet: { fieldId: "workbook-field" },
        operationId: editArguments.operationId,
        outcome: "preview",
        automaticRetry: false,
      }),
    ),
  );
  const result = await f.tool()!.execute("edit", { ...editArguments, dryRun: true });
  const request = JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
  expect(request.mutations).toEqual(editArguments.mutations);
  expect(request).toMatchObject({
    action: "edit",
    operationId: editArguments.operationId,
    expectedCollabRevision: 81,
    dryRun: true,
  });
  expect(result.details).toMatchObject({
    outcome: "preview",
    operationId: editArguments.operationId,
  });
});
it("does not retry a native edit after uncertain dispatch", async () => {
  const f = fixture("cellect-fi-admin");
  await f.admit();
  fetchMock.mockClear();
  fetchMock.mockRejectedValueOnce(new Error("disconnected"));
  await expect(f.tool()!.execute("edit", editArguments)).rejects.toThrow(editArguments.operationId);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("creates through the fixed API and accepts only the server assigned workbook identity", async () => {
  const f = fixture("cellect-fi-admin");
  await f.admit();
  const input = {
    action: "create",
    roomId: "data-room",
    displayName: "New workbook",
    roomVersion: 865,
    operationId: "native-create-operation-0001",
  };
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        ok: true,
        orgId: "admitted-org",
        sheet: { fieldId: "server-created" },
        operationId: input.operationId,
        outcome: "accepted",
        automaticRetry: false,
      }),
    ),
  );
  const result = await f.tool()!.execute("create", input);
  expect(result.details).toMatchObject({ sheet: { fieldId: "server-created" } });
  expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toMatchObject({
    action: "create",
    target: { roomId: "data-room" },
    displayName: "New workbook",
  });
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        ok: true,
        orgId: "other",
        sheet: { fieldId: "server-created" },
        operationId: input.operationId,
        outcome: "accepted",
        automaticRetry: false,
      }),
    ),
  );
  await expect(f.tool()!.execute("create", input)).rejects.toThrow("does not match");
});
it.each([
  { mutations: [] },
  { mutations: Array(101).fill(editArguments.mutations[0]) },
  { mutations: [{ id: "some", params: null }] },
  { method: "PUT" },
  { actor: "other@example.test" },
])("rejects malformed or authority-bearing native edit input case %#", async (extra) => {
  const f = fixture();
  await f.admit();
  fetchMock.mockClear();
  await expect(f.tool()!.execute("edit", { ...editArguments, ...extra })).rejects.toThrow(
    "Invalid workbook operation",
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

it("preserves an explicit create refusal before a workbook identity exists", async () => {
  const f = fixture("cellect-fi-admin");
  await f.admit();
  const input = {
    action: "create",
    roomId: "data-room",
    displayName: "New workbook",
    roomVersion: 865,
    operationId: "native-create-operation-0001",
  };
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        ok: false,
        orgId: "admitted-org",
        sheet: { fieldId: null },
        operationId: input.operationId,
        outcome: "rejected",
        automaticRetry: false,
        error: "room_version_changed",
      }),
      { status: 409 },
    ),
  );
  const result = await f.tool()!.execute("create", input);
  expect(result.details).toMatchObject({
    outcome: "rejected",
    error: "room_version_changed",
    operationId: input.operationId,
  });
});

it.each(["cellect-fi-admin", "cellect-fi-user"])(
  "uses the existing requester delegation for a genuine Slack %s workbook edit",
  async (agentId) => {
    const f = fixture(agentId, "slack");
    if (agentId === "cellect-fi-admin") {
      expect(f.tool()).toBeUndefined();
    }
    await f.arriveSlack();
    await f.admit();
    const tool = f.tool();
    expect(tool).toBeDefined();
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/openclaw-user-delegation")
        ? new Response(
            JSON.stringify({
              user: {
                orgId: "admitted-org",
                orgSlug: "shape",
                email: "verified@example.test",
                role: "admin",
              },
              fi: { token: "private-delegation", expiresAt: 9999999999 },
            }),
          )
        : new Response(
            JSON.stringify({
              ok: true,
              orgId: "admitted-org",
              sheet: { fieldId: "workbook-field" },
              operationId: editArguments.operationId,
              outcome: "preview",
              automaticRetry: false,
            }),
          ),
    );
    const result = await tool!.execute("slack-edit", { ...editArguments, dryRun: true });
    expect(
      JSON.parse(
        fetchMock.mock.calls.find(([url]) => url.endsWith("/openclaw-user-delegation"))![1].body,
      ),
    ).toEqual({ requesterSenderId: "U0ADMIN001", agentId });
    const [requestUrl, request] = fetchMock.mock.calls.find(([url]) =>
      url.endsWith("/shape/workbook"),
    )!;
    expect(requestUrl).toBe("https://fi.test/fi/api/shape/workbook");
    expect(request.headers.authorization).toBe("Bearer private-delegation");
    expect(JSON.parse(request.body)).not.toHaveProperty("proof");
    expect(JSON.parse(request.body).mutations).toEqual(editArguments.mutations);
    expect(JSON.stringify(result)).not.toContain("private-delegation");
  },
);
it("does not expose a workbook transport for a Slack operator without a requester owner", async () => {
  const f = fixture("cellect-main", "slack");
  await f.arriveSlack();
  await f.admit();
  expect(f.tool()).toBeUndefined();
});
it("does not dispatch a Slack edit when requester custody ends during delegation", async () => {
  const f = fixture("cellect-fi-admin", "slack");
  await f.arriveSlack();
  await f.admit();
  const tool = f.tool()!;
  fetchMock.mockClear();
  fetchMock.mockImplementationOnce(async () => {
    await f.retire();
    return new Response(
      JSON.stringify({
        user: { orgId: "admitted-org", orgSlug: "shape" },
        fi: { token: "private-delegation", expiresAt: 9999999999 },
      }),
    );
  });
  await expect(tool.execute("stale-slack", editArguments)).rejects.toThrow("scope unavailable");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]![0]).toContain("openclaw-user-delegation");
});
it("names the missing field of a near-valid get instead of an opaque refusal", async () => {
  const f = fixture();
  await f.admit();
  fetchMock.mockClear();
  const error = await f
    .tool()!
    .execute("no-field", { action: "get", roomId: "data-room" })
    .catch((caught: Error) => caught);
  expect(String(error)).toContain("Invalid workbook operation (fieldId: required, missing)");
  expect(String(error)).toContain("get needs roomId and fieldId");
  expect(fetchMock).not.toHaveBeenCalled();
  const tooMany = await f
    .tool()!
    .execute("rows", {
      action: "get",
      roomId: "data-room",
      fieldId: "workbook-field",
      range: { sheetId: "s1", startRow: 0, startColumn: 0, rows: 40, columns: 5 },
    })
    .catch((caught: Error) => caught);
  expect(String(error)).not.toBe(String(tooMany));
  expect(String(tooMany)).toMatch(/range\.rows: .* \(got 40\)/);
});
it("suggests a smaller range when the workbook API refuses a read as too large", async () => {
  const f = fixture();
  await f.admit();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
    url.endsWith("/agent-authorize")
      ? allow(JSON.parse(String(init?.body)).agentId)
      : new Response("too large", { status: 413 }),
  );
  await expect(
    f.tool()!.execute("big", {
      action: "get",
      roomId: "data-room",
      fieldId: "workbook-field",
      range: { sheetId: "s1", startRow: 0, startColumn: 0, rows: 20, columns: 20 },
    }),
  ).rejects.toThrow(/too large \(413\); request a smaller range/);
});
