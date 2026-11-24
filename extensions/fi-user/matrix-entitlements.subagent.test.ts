import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  PluginAgentEventSubscriptionRegistration,
  PluginRuntimeLifecycleRegistration,
} from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { PluginHookToolContext } from "openclaw/plugin-sdk/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fiUserPlugin from "./index.js";
import { registerMatrixEntitlements } from "./matrix-entitlements.js";
import {
  MATRIX_SUBAGENT_REFUSAL,
  matrixSubagentSpawnBlock,
  SUBAGENT_RUN_REFUSAL,
} from "./matrix-subagent-guard.js";

vi.mock("openclaw/plugin-sdk/retry-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/retry-runtime")>()),
  sleepWithAbort: async (_ms: number, signal?: AbortSignal) => signal?.throwIfAborted(),
}));

type Lineage = NonNullable<PluginHookToolContext["spawnedFrom"]>;
type Capture = (context: OpenClawPluginToolContext) =>
  | {
      assertCurrent: () => void;
    }
  | undefined;
type Resolver = {
  resolveSender: (requester: {
    sessionKey: string;
    accountId: string;
    senderId: string;
    workspaceId: string;
  }) => Promise<string | undefined>;
};

const agentId = "cellect-fi-user";
const senderId = "@alex:matrix.example";
const roomId = "!room:matrix.example";
const parentKey = `agent:${agentId}:matrix:channel:${roomId}:thread:$root`;
const childKey = `agent:${agentId}:subagent:7ecedfe5-40fe-4ab9-8af8-d96600e53cad`;

function fixture() {
  const hooks = new Map<string, Array<(event: never, context: never) => unknown>>();
  const subscriptions: PluginAgentEventSubscriptionRegistration[] = [];
  const lifecycles: PluginRuntimeLifecycleRegistration[] = [];
  const contexts = new Map<string, unknown>();
  const owner = registerMatrixEntitlements(
    createTestPluginApi({
      config: {
        plugins: {
          entries: {
            "fi-user": {
              config: {
                baseUrl: "https://fi.example",
                brokerTokenEnv: "FIXTURE_BROKER",
                tenantOrgId: "tenant-a",
              },
            },
          },
        },
      },
      runtime: {
        channel: {
          runtimeContexts: {
            register: (entry: { channelId: string; capability: string; context: unknown }) => {
              contexts.set(`${entry.channelId}/${entry.capability}`, entry.context);
              return { dispose: () => {} };
            },
          },
        },
      } as unknown as OpenClawPluginApi["runtime"],
      on: (name, handler) => hooks.set(name, [...(hooks.get(name) ?? []), handler as never]),
      registerAgentEventSubscription: (subscription) => subscriptions.push(subscription),
      registerRuntimeLifecycle: (lifecycle) => lifecycles.push(lifecycle),
    }),
  );
  const run = async (name: string, context: unknown, event: unknown = {}) => {
    for (const hook of hooks.get(name) ?? []) {
      const result = await hook(event as never, context as never);
      if (result) {
        return result;
      }
    }
    return undefined;
  };
  return {
    owner,
    reply: (context: unknown) => run("before_agent_reply", context),
    afterTool: (event: unknown, context: unknown) => run("after_tool_call", context, event),
    prompt: (context: unknown) => run("before_prompt_build", context),
    tool: (context: PluginHookToolContext) => owner.beforeToolCall(context),
    capture: (context: OpenClawPluginToolContext) =>
      (contexts.get("matrix/fi-admitted-turn") as { capture: Capture }).capture(context),
    slack: contexts.get("matrix/requester-slack-identity") as Resolver,
    settle: async (runId: string) => {
      for (const subscription of subscriptions) {
        await subscription.handle(
          { runId, stream: "lifecycle", data: { phase: "end", executionSettled: true } } as never,
          {} as never,
        );
      }
    },
    cleanup: async (event: { runId?: string; sessionKey?: string }) => {
      for (const lifecycle of lifecycles) {
        await lifecycle.cleanup?.(event as never);
      }
    },
    dispose: async () => {
      for (const lifecycle of lifecycles) {
        await lifecycle.dispose?.();
      }
    },
  };
}

const parentContext = (overrides: Record<string, unknown> = {}) => ({
  runId: "run-1",
  agentId,
  accountId: "mainprod",
  channel: "matrix",
  trigger: "user",
  senderId,
  chatId: `${roomId}:thread:$root`,
  sessionKey: parentKey,
  sessionId: "parent-session",
  channelContext: { sender: { id: senderId }, chat: { id: roomId, eventId: "$event" } },
  ...overrides,
});

function lineage(overrides: Partial<Lineage> = {}): Lineage & { revoked: { value: boolean } } {
  const revoked = { value: false };
  return {
    parentRunId: "run-1",
    parentAgentId: agentId,
    parentSessionKey: parentKey,
    parentSessionId: "parent-session",
    childRunId: "child-1",
    childAgentId: agentId,
    childSessionKey: childKey,
    childSessionId: "child-session",
    completionTarget: "parent",
    expiresAt: Date.now() + 60_000,
    assertCurrent: () => {
      if (revoked.value) {
        throw new Error("revoked");
      }
    },
    revoked,
    ...overrides,
  };
}

const childContext = (
  spawnedFrom: Lineage | undefined,
  overrides: Record<string, unknown> = {},
) => ({
  runId: "child-1",
  agentId,
  accountId: "mainprod",
  channel: "matrix",
  sessionKey: childKey,
  sessionId: "child-session",
  ...(spawnedFrom ? { spawnedFrom } : {}),
  ...overrides,
});

const childTool = (spawnedFrom: Lineage | undefined, overrides: Record<string, unknown> = {}) =>
  ({
    runId: "child-1",
    agentId,
    sessionKey: childKey,
    sessionId: "child-session",
    toolName: "fi_user_api",
    requester: { channel: "matrix", accountId: "mainprod" },
    ...(spawnedFrom ? { spawnedFrom } : {}),
    ...overrides,
  }) as PluginHookToolContext;

const parentTool = (overrides: Record<string, unknown> = {}) =>
  ({
    runId: "run-1",
    agentId,
    sessionKey: parentKey,
    toolName: "fi_user_api",
    requester: { channel: "matrix", senderId, accountId: "mainprod" },
    ...overrides,
  }) as PluginHookToolContext;

const allow = (overrides: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ ok: true, agentId, orgId: "tenant-a", ...overrides }));
const privateAudience = {
  audience: {
    visibility: "private",
    requesterIsSoleHuman: true,
    humanCount: 1,
    mixedAudience: false,
  },
};
const refused = { handled: true, reply: { text: SUBAGENT_RUN_REFUSAL } };

describe("Matrix sub-agent children", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubEnv("FIXTURE_BROKER", "fixture-token");
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ mainprod: "prod" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => allow());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const body = (index: number) => JSON.parse(fetchMock.mock.calls[index]?.[1].body);
  const admitParent = async (h: ReturnType<typeof fixture>, overrides = {}) => {
    expect(await h.reply(parentContext(overrides))).toBeUndefined();
  };

  it("admits a child for exactly its parent's person, room and event, and rechecks its tools", async () => {
    const h = fixture();
    await admitParent(h);
    const from = lineage();
    expect(await h.reply(childContext(from))).toBeUndefined();
    const parentBody = { roomId, agentId, eventId: "$event" };
    expect(body(0)).toEqual(parentBody);
    expect(body(1)).toEqual(parentBody);
    expect(await h.tool(childTool(from))).toBeUndefined();
    expect(body(2)).toEqual(parentBody);
    expect(
      h.capture({
        runId: "child-1",
        agentId,
        sessionKey: childKey,
        messageChannel: "matrix",
        agentAccountId: "mainprod",
      }),
    ).toBeDefined();
  });

  it("refuses a child without lineage, or whose lineage is forged or names another run", async () => {
    const h = fixture();
    await admitParent(h);
    expect(await h.reply(childContext(undefined))).toEqual(refused);
    for (const forged of [
      lineage({ childRunId: "child-2" }),
      lineage({ childSessionKey: `agent:${agentId}:subagent:other` }),
      lineage({ childAgentId: "cellect-fi-admin" }),
      lineage({ parentAgentId: "cellect-fi-admin" }),
      lineage({ parentSessionKey: `agent:${agentId}:matrix:channel:!other:matrix.example` }),
      lineage({ parentRunId: "run-unknown" }),
      lineage({
        assertCurrent: () => {
          throw new Error("revoked");
        },
      }),
    ]) {
      expect(await h.reply(childContext(forged))).toEqual(refused);
    }
    // A different agent cannot borrow the parent's admission.
    expect(
      await h.reply(
        childContext(lineage({ childAgentId: "cellect-fi-admin" }), {
          agentId: "cellect-fi-admin",
          sessionKey: "agent:cellect-fi-admin:subagent:x",
        }),
      ),
    ).toEqual(refused);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a child whose parent is not an admitted current text turn", async () => {
    const unadmitted = fixture();
    expect(await unadmitted.reply(childContext(lineage()))).toEqual(refused);

    const denied = fixture();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await denied.reply(parentContext());
    expect(await denied.reply(childContext(lineage()))).toEqual(refused);

    const retired = fixture();
    await admitParent(retired);
    await retired.settle("run-1");
    expect(await retired.reply(childContext(lineage()))).toEqual(refused);

    const disposed = fixture();
    await admitParent(disposed);
    await disposed.dispose();
    expect(await disposed.reply(childContext(lineage()))).toEqual(refused);

    const voice = fixture();
    await voice.reply(
      parentContext({
        chatId: roomId,
        channelContext: {
          sender: { id: senderId },
          chat: { id: roomId, talkThreadRootEventId: "$root" },
        },
      }),
    );
    expect(await voice.reply(childContext(lineage()))).toEqual(refused);
  });

  it("refuses nesting: a child cannot be the parent of another child", async () => {
    const h = fixture();
    await admitParent(h);
    expect(await h.reply(childContext(lineage()))).toBeUndefined();
    const grandchild = lineage({
      parentRunId: "child-1",
      parentSessionKey: childKey,
      childRunId: "grandchild-1",
      childSessionKey: `agent:${agentId}:subagent:grandchild`,
    });
    expect(
      await h.reply(
        childContext(grandchild, {
          runId: "grandchild-1",
          sessionKey: `agent:${agentId}:subagent:grandchild`,
        }),
      ),
    ).toEqual(refused);
  });

  it("takes the org from the parent: Fi answering for another tenant refuses the child", async () => {
    const h = fixture();
    await admitParent(h);
    fetchMock.mockResolvedValueOnce(allow({ orgId: "tenant-b" }));
    expect(await h.reply(childContext(lineage()))).toEqual({
      handled: true,
      reply: { text: expect.stringContaining("temporarily unavailable") },
    });
  });

  it("never captures a child's turn for another message, room or sender", async () => {
    const h = fixture();
    await admitParent(h);
    await h.reply(childContext(lineage()));
    const base = { runId: "child-1", agentId, sessionKey: childKey, agentAccountId: "mainprod" };
    expect(h.capture({ ...base, currentMessageId: "$other" })).toBeUndefined();
    expect(h.capture({ ...base, nativeChannelId: "!other:matrix.example" })).toBeUndefined();
    expect(h.capture({ ...base, requesterSenderId: "@mallory:matrix.example" })).toBeUndefined();
    expect(h.capture({ ...base, messageChannel: "slack" })).toBeUndefined();
    expect(
      h.capture({ ...base, currentMessageId: "$event", nativeChannelId: roomId }),
    ).toBeDefined();
  });

  it("blocks a child's tool call whose lineage projection or requester disagrees", async () => {
    const h = fixture();
    await admitParent(h);
    const from = lineage();
    await h.reply(childContext(from));
    const calls = fetchMock.mock.calls.length;
    for (const context of [
      childTool(undefined),
      childTool(lineage({ childRunId: "child-2" })),
      childTool(from, { requester: { channel: "matrix", senderId: "@mallory:matrix.example" } }),
      childTool(from, { requester: { channel: "matrix", accountId: "otherprod" } }),
      childTool(from, { agentId: "cellect-fi-admin" }),
    ]) {
      expect(await h.tool(context)).toMatchObject({ block: true });
    }
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

  it("keeps the child no more private than its parent", async () => {
    const shared = fixture();
    await admitParent(shared);
    fetchMock.mockResolvedValueOnce(allow(privateAudience));
    await shared.reply(childContext(lineage()));
    expect(await shared.prompt(childContext(lineage()))).toEqual({
      appendSystemContext: expect.stringContaining('"requester_is_sole_human":false'),
    });

    const privateParent = fixture();
    fetchMock
      .mockResolvedValueOnce(allow(privateAudience))
      .mockResolvedValueOnce(allow(privateAudience));
    await admitParent(privateParent);
    await privateParent.reply(childContext(lineage()));
    expect(await privateParent.prompt(childContext(lineage()))).toEqual({
      appendSystemContext: expect.stringContaining('"requester_is_sole_human":true'),
    });
  });

  it("ends the child's authority when the parent is revoked or Fi refuses either of them", async () => {
    const revoked = fixture();
    await admitParent(revoked);
    await revoked.reply(childContext(lineage()));
    await revoked.cleanup({ runId: "run-1" });
    expect(await revoked.tool(childTool(lineage()))).toMatchObject({ block: true });

    const parentDenied = fixture();
    await admitParent(parentDenied);
    await parentDenied.reply(childContext(lineage()));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect(await parentDenied.tool(parentTool())).toMatchObject({ block: true });
    fetchMock.mockResolvedValue(allow());
    expect(await parentDenied.tool(childTool(lineage()))).toMatchObject({ block: true });

    const childDenied = fixture();
    await admitParent(childDenied);
    await childDenied.reply(childContext(lineage()));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect(await childDenied.tool(childTool(lineage()))).toMatchObject({ block: true });
    expect(await childDenied.tool(childTool(lineage()))).toMatchObject({ block: true });
  });

  it("ends the child's authority when it settles, its lineage is revoked, or its bound passes", async () => {
    const settled = fixture();
    await admitParent(settled);
    await settled.reply(childContext(lineage()));
    await settled.settle("child-1");
    expect(await settled.tool(childTool(lineage()))).toMatchObject({ block: true });

    const hostRevoked = fixture();
    await admitParent(hostRevoked);
    const from = lineage();
    await hostRevoked.reply(childContext(from));
    from.revoked.value = true;
    expect(await hostRevoked.tool(childTool(from))).toMatchObject({ block: true });

    vi.useFakeTimers({ toFake: ["Date"] });
    const expired = fixture();
    await admitParent(expired);
    const bounded = lineage({ expiresAt: Date.now() + 1_000 });
    await expired.reply(childContext(bounded));
    expect(await expired.tool(childTool(bounded))).toBeUndefined();
    vi.setSystemTime(Date.now() + 1_001);
    expect(await expired.tool(childTool(bounded))).toMatchObject({ block: true });
  });

  it("keeps a settled parent only as its children's custody, without tools of its own", async () => {
    const h = fixture();
    await admitParent(h);
    await h.reply(childContext(lineage()));
    await h.settle("run-1");
    expect(await h.tool(parentTool())).toMatchObject({ block: true });
    expect(h.owner.spawnParent(parentTool())).toBeUndefined();
    expect(await h.tool(childTool(lineage()))).toBeUndefined();
    // The last child ending releases the parent: no new child can be admitted under it.
    await h.settle("child-1");
    expect(
      await h.reply(childContext(lineage({ childRunId: "child-2" }), { runId: "child-2" })),
    ).toEqual(refused);
  });

  it("admits a child that starts only after its parent has replied and settled", async () => {
    const h = fixture();
    await admitParent(h);
    expect(await h.tool(parentTool({ toolName: "sessions_spawn" }))).toBeUndefined();
    await h.settle("run-1");
    expect(await h.tool(parentTool())).toMatchObject({ block: true });
    expect(await h.reply(childContext(lineage()))).toBeUndefined();
    expect(await h.tool(childTool(lineage()))).toBeUndefined();
    await h.settle("child-1");
    expect(
      await h.reply(childContext(lineage({ childRunId: "child-2" }), { runId: "child-2" })),
    ).toEqual(refused);
  });

  it("gates a child of a Matrix turn whatever channel its own run carries", async () => {
    const h = fixture();
    await admitParent(h);
    expect(await h.reply(childContext(lineage(), { channel: undefined }))).toBeUndefined();
    expect(await h.tool(childTool(lineage(), { requester: undefined }))).toBeUndefined();

    // No lineage, but the host recorded a Matrix parent: refused on any channel, tools too.
    const unbound = fixture();
    await admitParent(unbound);
    const provenanceOnly = { spawnedFromChannel: "matrix" };
    expect(
      await unbound.reply(childContext(undefined, { channel: undefined, ...provenanceOnly })),
    ).toEqual(refused);
    expect(
      await unbound.tool(childTool(undefined, { requester: undefined, ...provenanceOnly })),
    ).toEqual({ block: true, blockReason: SUBAGENT_RUN_REFUSAL });
    // Two admissions and one tool check for the first child, the second parent's admission.
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // A child of a Slack turn is not this gate's to decide.
    const slack = fixture();
    expect(
      await slack.reply(
        childContext(lineage({ parentRunId: "slack-run" }), {
          channel: "slack",
          spawnedFromChannel: "slack",
        }),
      ),
    ).toBeUndefined();
  });

  it("refuses a child whose result would not return to its parent", async () => {
    const h = fixture();
    await admitParent(h);
    expect(await h.reply(childContext(lineage({ completionTarget: undefined })))).toEqual(refused);
  });

  it("drops a child's late result for a parent that settled without yielding, posting nothing", async () => {
    const h = fixture();
    await admitParent(h);
    expect(await h.tool(parentTool({ toolName: "sessions_spawn" }))).toBeUndefined();
    await h.settle("run-1");
    expect(await h.reply(childContext(lineage()))).toBeUndefined();
    await h.settle("child-1");
    const calls = fetchMock.mock.calls.length;
    // The host's private completion turn into the parent session: no message, no continuation.
    const announce = {
      runId: "announce-run",
      agentId,
      accountId: "mainprod",
      channel: "matrix",
      sessionKey: parentKey,
      sessionId: "parent-session",
      inputProvenance: {
        kind: "inter_session",
        sourceTool: "subagent_announce",
        sourceSessionKey: childKey,
      },
    };
    // Handled without a reply: the room sees nothing, not an access error.
    expect(await h.reply(announce)).toEqual({ handled: true });
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

  it("stops waiting for a spawn the host did not accept", async () => {
    const h = fixture();
    await admitParent(h);
    expect(await h.tool(parentTool({ toolName: "sessions_spawn" }))).toBeUndefined();
    await h.afterTool(
      {
        toolName: "sessions_spawn",
        params: {},
        runId: "run-1",
        result: { details: { status: "forbidden" } },
      },
      parentTool({ toolName: "sessions_spawn" }),
    );
    await h.settle("run-1");
    expect(await h.reply(childContext(lineage()))).toEqual(refused);
  });

  it("keeps children out of Slack identity, voice and operator admission", async () => {
    const h = fixture();
    await admitParent(h);
    await h.reply(childContext(lineage()));
    const calls = fetchMock.mock.calls.length;
    expect(
      await h.slack.resolveSender({
        sessionKey: childKey,
        accountId: "mainprod",
        senderId,
        workspaceId: "T12345678",
      }),
    ).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    const tool = childTool(lineage(), {
      requester: { channel: "matrix", senderId, accountId: "mainprod" },
    });
    expect(h.owner.admittedVoiceTurn(tool)).toBeUndefined();
    expect(h.owner.admittedOperatorCommand(tool)).toBeUndefined();
    expect(h.owner.spawnParent(tool)).toBe("child");
  });

  it("re-admits the parent's continuation once a child's announce wakes it", async () => {
    const h = fixture();
    await admitParent(h);
    await h.reply(childContext(lineage()));
    await h.settle("child-1");
    const continuation = {
      runId: "run-2",
      agentId,
      sessionKey: parentKey,
      sessionId: "parent-session",
      sourceTurnId: "turn-1",
      chatId: roomId,
      eventId: "$event",
      channel: "matrix",
      senderId,
      accountId: "mainprod",
      assertCurrent: () => {},
    };
    expect(
      await h.reply({
        runId: "run-2",
        agentId,
        accountId: "mainprod",
        channel: "matrix",
        sessionKey: parentKey,
        sessionId: "parent-session",
        requesterContinuation: continuation,
      }),
    ).toBeUndefined();
    expect(body(fetchMock.mock.calls.length - 1)).toEqual({ roomId, agentId, eventId: "$event" });
  });
});

describe("Matrix sub-agent spawn guard", () => {
  const matrix = { agentId, sessionKey: parentKey, requester: { channel: "matrix" } };
  const oneOff = { task: "t", completionTarget: "parent" };
  it("lets an admitted text turn spawn a one-off child of its own agent that reports back", () => {
    expect(matrixSubagentSpawnBlock("sessions_spawn", matrix, oneOff, "text")).toBeUndefined();
    expect(
      matrixSubagentSpawnBlock(
        "sessions_spawn",
        matrix,
        { ...oneOff, agentId, mode: "run" },
        "text",
      ),
    ).toBeUndefined();
  });
  it.each([
    ["an unadmitted parent", {}, undefined],
    ["a voice parent", {}, "voice"],
    ["a child spawning a child", {}, "child"],
    ["another agent", { agentId: "cellect-fi-admin" }, "text"],
    ["a session-mode child", { mode: "session" }, "text"],
    ["a thread-bound child", { thread: true }, "text"],
    ["an ACP child", { runtime: "acp" }, "text"],
    ["a visible child", { visible: true }, "text"],
    ["a collector", { collect: true }, "text"],
    // tools.swarm.defaultAgentId retargets an agentId-less collector to another agent.
    [
      "an agentId-less collector open to swarm retargeting",
      { collect: true, agentId: undefined },
      "text",
    ],
    ["a collector option without collect", { groupId: "g" }, "text"],
    ["an output schema", { outputSchema: { type: "object" } }, "text"],
    ["a fast-mode option", { fastMode: "auto" }, "text"],
    ["a child whose result goes to the room", { completionTarget: undefined }, "text"],
    ["a fire-and-forget child", { expectsCompletionMessage: false }, "text"],
  ] as const)("refuses %s", (_name, params, parent) => {
    expect(
      matrixSubagentSpawnBlock("sessions_spawn", matrix, { ...oneOff, ...params }, parent),
    ).toEqual({
      block: true,
      blockReason: MATRIX_SUBAGENT_REFUSAL,
    });
  });
  it("refuses a code-mode collector launch, which carries host-only symbol keys", () => {
    const params: Record<PropertyKey, unknown> = { ...oneOff };
    Object.defineProperty(params, Symbol.for("openclaw.swarmCodeModeIdempotencyKey"), {
      value: "k",
    });
    expect(
      matrixSubagentSpawnBlock("sessions_spawn", matrix, params as Record<string, unknown>, "text"),
    ).toMatchObject({ block: true });
  });
  it("refuses a spawn from a sub-agent session whatever it is told", () => {
    expect(
      matrixSubagentSpawnBlock(
        "sessions_spawn",
        { ...matrix, sessionKey: childKey },
        oneOff,
        "text",
      ),
    ).toMatchObject({ block: true });
  });
});

describe("the plugin's spawn guard", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubEnv("FIXTURE_BROKER", "fixture-token");
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ mainprod: "prod" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => allow());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it("lets an admitted text turn spawn only a one-off child that reports back", async () => {
    const hooks = new Map<string, Array<(event: never, context: never) => unknown>>();
    fiUserPlugin.register?.(
      createTestPluginApi({
        id: "fi-user",
        name: "Fi User Delegation",
        config: {
          plugins: {
            entries: {
              "fi-user": {
                config: {
                  baseUrl: "https://fi.example",
                  brokerTokenEnv: "FIXTURE_BROKER",
                  tenantOrgId: "tenant-a",
                },
              },
            },
          },
        },
        runtime: {
          channel: { runtimeContexts: { register: vi.fn() } },
        } as unknown as OpenClawPluginApi["runtime"],
        on: (name, handler) => hooks.set(name, [...(hooks.get(name) ?? []), handler as never]),
        registerAgentEventSubscription: () => {},
        registerRuntimeLifecycle: () => {},
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
    await hook("before_agent_reply", {}, parentContext());
    const spawn = (extra: object) =>
      hook(
        "before_tool_call",
        {
          toolName: "sessions_spawn",
          params: { task: "t", completionTarget: "parent", ...extra },
        },
        parentTool({ toolName: "sessions_spawn" }),
      );
    expect(await spawn({})).not.toMatchObject({ block: true });
    for (const extra of [
      { agentId: "cellect-fi-admin" },
      { thread: true },
      { collect: true },
      { completionTarget: undefined },
    ]) {
      expect(await spawn(extra)).toMatchObject({
        block: true,
        blockReason: MATRIX_SUBAGENT_REFUSAL,
      });
    }
    // Fi saw the admission and the allowed spawn's recheck, nothing for the refused ones.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
