import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  PluginAgentEventSubscriptionRegistration,
  PluginRuntimeLifecycleRegistration,
} from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { PluginHookToolContext } from "openclaw/plugin-sdk/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertNotDeskBrief,
  DESK_BRIEF_TOOL_REFUSAL,
  registerMatrixEntitlements,
} from "./matrix-entitlements.js";

vi.mock("openclaw/plugin-sdk/retry-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/retry-runtime")>()),
  sleepWithAbort: async (_ms: number, signal?: AbortSignal) => signal?.throwIfAborted(),
}));

type Lineage = NonNullable<PluginHookToolContext["spawnedFrom"]>;
type Capture = (context: OpenClawPluginToolContext) => { authorship: { kind: string } } | undefined;

const agentId = "cellect-fi-user";
const senderId = "@alex:matrix.example";
const roomId = "!room:matrix.example";
const sessionKey = `agent:${agentId}:matrix:channel:${roomId}:thread:$root`;
const childKey = `agent:${agentId}:subagent:7ecedfe5-40fe-4ab9-8af8-d96600e53cad`;
const brief = {
  authorship: { kind: "desk_handoff", writtenBy: "agent", deskConversationId: "conv-1" },
};

function fixture() {
  const hooks = new Map<string, Array<(event: never, context: never) => unknown>>();
  const subscriptions: PluginAgentEventSubscriptionRegistration[] = [];
  const lifecycles: PluginRuntimeLifecycleRegistration[] = [];
  const contexts = new Map<string, unknown>();
  const api = createTestPluginApi({
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
          get: (key: { channelId: string; capability: string }) =>
            contexts.get(`${key.channelId}/${key.capability}`),
        },
      },
    } as unknown as OpenClawPluginApi["runtime"],
    on: (name, handler) => hooks.set(name, [...(hooks.get(name) ?? []), handler as never]),
    registerAgentEventSubscription: (subscription) => subscriptions.push(subscription),
    registerRuntimeLifecycle: (lifecycle) => lifecycles.push(lifecycle),
  });
  const owner = registerMatrixEntitlements(api);
  const run = async (name: string, context: unknown) => {
    for (const hook of hooks.get(name) ?? []) {
      const result = await hook({} as never, context as never);
      if (result) {
        return result;
      }
    }
    return undefined;
  };
  return {
    api,
    owner,
    reply: (context: unknown) => run("before_agent_reply", context),
    prompt: (context: unknown) =>
      run("before_prompt_build", context) as Promise<{ appendSystemContext?: string } | undefined>,
    capture: (context: OpenClawPluginToolContext) =>
      (contexts.get("matrix/fi-admitted-turn") as { capture: Capture }).capture(context),
    settle: async (runId: string) => {
      for (const subscription of subscriptions) {
        await subscription.handle(
          { runId, stream: "lifecycle", data: { phase: "end", executionSettled: true } } as never,
          {} as never,
        );
      }
    },
  };
}

const replyContext = (runId = "run-1", eventId = "$event") => ({
  runId,
  agentId,
  accountId: "mainprod",
  channel: "matrix",
  trigger: "user",
  senderId,
  chatId: `${roomId}:thread:$root`,
  sessionKey,
  sessionId: "session",
  channelContext: { sender: { id: senderId }, chat: { id: roomId, eventId } },
});
const toolContext = (runId = "run-1") =>
  ({
    runId,
    agentId,
    sessionKey,
    toolName: "fi_user_api",
    requester: { channel: "matrix", senderId, accountId: "mainprod" },
  }) as PluginHookToolContext;
const captureContext = (runId = "run-1", eventId = "$event") =>
  ({
    runId,
    agentId,
    sessionKey,
    messageChannel: "matrix",
    agentAccountId: "mainprod",
    nativeChannelId: roomId,
    requesterSenderId: senderId,
    currentMessageId: eventId,
  }) as unknown as OpenClawPluginToolContext;
const allow = (extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ ok: true, agentId, orgId: "tenant-a", ...extra }));

// Every gated call, with the variant of the same tool that stays allowed.
const GATED: Array<[string, Record<string, unknown>, Record<string, unknown> | undefined]> = [
  ["fi_user_gmail", { action: "send", confirmSend: true }, { action: "draft" }],
  ["fi_user_esign", { action: "send", confirmSend: true }, { action: "list" }],
  ["fi_user_esign", { action: "resend", submissionId: 1 }, { action: "status", submissionId: 1 }],
  ["fi_user_esign", { action: "send_envelope", confirmRoute: "abc" }, { action: "send_envelope" }],
  ["fi_user_deliver_file", { action: "deliver", artifactId: "ga_x" }, { action: "register" }],
  ["fi_user_deliver_file", { documentId: "doc", project: "p" }, { action: "prepare" }],
  [
    "fi_admin_operation",
    { action: "execute", operation: "a.b.c", variant: "v", input: {} },
    { action: "execute", operation: "a.b.c", variant: "v", input: {}, dryRun: true },
  ],
  ["m365_mail", { action: "send_draft", draftId: "d" }, { action: "draft" }],
  ["m365_mail", { action: "send_draft", draftId: "d" }, { action: "reply_draft", messageId: "m" }],
  ["m365_mail", { action: "send_draft", draftId: "d" }, { action: "calendar_read" }],
  // requester_gmail drafts only today; a send added later is held without a change here.
  ["requester_gmail", { action: "send" }, { action: "draft" }],
  ["sessions_send", { sessionKey: "agent:x:main", message: "hi" }, undefined],
  ["conversations_send", { conversationRef: "c", message: "hi" }, undefined],
  ["conversations_turn", { conversationRef: "c", message: "hi" }, undefined],
  ["message", { action: "send", target: "!other:matrix.example" }, { action: "send" }],
  [
    "message",
    { action: "send", channel: "slack", target: "C123" },
    { action: "send", target: `room:${roomId}` },
  ],
  [
    "message",
    { action: "send", targets: [roomId, "@bob:matrix.example"] },
    { action: "read", target: "!other:matrix.example" },
  ],
  ["message", { action: "broadcast", message: "hi" }, { action: "react", emoji: "+1" }],
];

describe("Desk brief authorship", () => {
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

  it("keeps the old behaviour when Fi sends no authorship", async () => {
    const h = fixture();
    expect(await h.reply(replyContext())).toBeUndefined();
    expect((await h.prompt(replyContext()))?.appendSystemContext).not.toContain("authorship");
    for (const [toolName, params] of GATED) {
      expect(h.owner.briefToolBlock({ toolName, params }, toolContext())).toBeUndefined();
    }
    expect(h.capture(captureContext())?.authorship).toEqual({ kind: "person" });
    expect(() => assertNotDeskBrief(h.api, captureContext())).not.toThrow();
  });

  it("treats an unknown kind as the person, and logs it", async () => {
    const h = fixture();
    fetchMock.mockImplementation(async () => allow({ authorship: { kind: "robot" } }));
    expect(await h.reply(replyContext())).toBeUndefined();
    expect(h.capture(captureContext())?.authorship).toEqual({ kind: "person" });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("authorship_unknown"));
  });

  it("tells the model and blocks each gated call of a brief, while the allowed variants pass", async () => {
    const h = fixture();
    fetchMock.mockImplementation(async () => allow(brief));
    expect(await h.reply(replyContext())).toBeUndefined();
    const prompt = await h.prompt(replyContext());
    expect(prompt?.appendSystemContext).toContain(
      "Fi verified this message as a brief written by Desk's agent, not the person's own words.",
    );
    for (const [toolName, params, allowed] of GATED) {
      expect(h.owner.briefToolBlock({ toolName, params }, toolContext()), toolName).toEqual({
        block: true,
        blockReason: DESK_BRIEF_TOOL_REFUSAL,
      });
      if (allowed) {
        expect(
          h.owner.briefToolBlock({ toolName, params: allowed }, toolContext()),
          `${toolName} ${JSON.stringify(allowed)}`,
        ).toBeUndefined();
      }
    }
    expect(
      h.owner.briefToolBlock(
        { toolName: "fi_user_desk_handoff", params: { action: "list" } },
        toolContext(),
      ),
    ).toBeUndefined();
    expect(h.capture(captureContext())?.authorship).toMatchObject({ kind: "desk_handoff" });
    expect(() => assertNotDeskBrief(h.api, captureContext())).toThrow(DESK_BRIEF_TOOL_REFUSAL);
  });

  it("refuses every tool and action a brief does not allow, unknown ones included", async () => {
    const h = fixture();
    fetchMock.mockImplementation(async () => allow(brief));
    await h.reply(replyContext());
    const blocked: Array<[string, Record<string, unknown>]> = [
      ["some_new_tool", {}],
      ["fi_user_dataroom", { action: "add_document", documentId: "d" }],
      ["fi_user_dataroom", { action: "update_document", documentId: "d" }],
      ["fi_user_dataroom", { action: "create" }],
      ["fi_user_mail_items", { action: "control", operation: "note" }],
      ["fi_user_mail_items", { action: "control", operation: "resume" }],
      ["requester_gdrive", { action: "share" }],
      ["requester_gdrive", {}],
      ["automations", { action: "add" }],
      ["automations", { action: "update" }],
      ["automations", { action: "run" }],
      ["automations", { action: "remove" }],
      ["cron", { action: "add" }],
      ["fi_user_desk_handoff", { action: "start", input: { task: "t" } }],
      ["m365_mail", { action: "mark_read" }],
      ["m365_mail", { action: "move" }],
      ["m365_mail", { action: "trash" }],
      ["m365_mail", { action: "calendar_create" }],
      ["request_admin_action", { task: "room_admin" }],
      ["fi_workbook", { action: "edit" }],
      ["fi_user_work_items", { action: "transition" }],
      ["fi_user_budget_import", { mode: "apply" }],
      ["fi_admin_operation", { action: "execute", dryRun: false }],
      ["subagents", { action: "steer" }],
      ["message", { action: "kick", target: roomId }],
      ["message", { action: "sendAttachment" }],
    ];
    for (const [toolName, params] of blocked) {
      expect(
        h.owner.briefToolBlock({ toolName, params }, toolContext()),
        `${toolName} ${JSON.stringify(params)}`,
      ).toEqual({ block: true, blockReason: DESK_BRIEF_TOOL_REFUSAL });
    }
    const allowed: Array<[string, Record<string, unknown>]> = [
      ["automations", { action: "list" }],
      ["automations", { action: "status" }],
      ["fi_user_desk_handoff", { action: "list" }],
      ["fi_user_dataroom", { action: "list" }],
      ["fi_user_mail_items", { action: "list" }],
      ["requester_gdrive", { action: "read", fileId: "f" }],
      ["exec", { command: "ls" }],
      ["sessions_spawn", { task: "t", completionTarget: "parent" }],
      ["sessions_yield", {}],
      ["read", { path: "a" }],
      ["web_search", { query: "q" }],
      ["fi_user_api", { path: "projects" }],
      ["fi_user_budget_import", {}],
      ["fi_admin_operation", { action: "discover" }],
      ["ask_user", { question: "send it?" }],
    ];
    for (const [toolName, params] of allowed) {
      expect(
        h.owner.briefToolBlock({ toolName, params }, toolContext()),
        `${toolName} ${JSON.stringify(params)}`,
      ).toBeUndefined();
    }
  });

  it("knows a brief run, and queues Matrix messages behind any live gated turn", async () => {
    const h = fixture();
    const matrixMessage = { channel: "matrix", sessionKey };
    expect(h.owner.steerQueue(matrixMessage)).toBe(false);
    fetchMock.mockImplementationOnce(async () => allow(brief));
    await h.reply(replyContext());
    expect(h.owner.briefRun({ runId: "run-1" })).toBe(true);
    expect(h.owner.steerQueue(matrixMessage)).toBe(true);
    expect(h.owner.steerQueue({ channel: "slack", sessionKey })).toBe(false);
    await h.settle("run-1");
    expect(h.owner.steerQueue(matrixMessage)).toBe(false);
    await h.reply(replyContext("run-2", "$own"));
    expect(h.owner.briefRun({ runId: "run-2" })).toBe(false);
    // A person's live run holds a possible brief out of it too.
    expect(h.owner.steerQueue(matrixMessage)).toBe(true);
  });

  it("a malformed desk_handoff stays a brief", async () => {
    const h = fixture();
    fetchMock.mockImplementation(async () => allow({ authorship: { kind: "desk_handoff" } }));
    await h.reply(replyContext());
    expect(
      h.owner.briefToolBlock(
        { toolName: "fi_user_gmail", params: { action: "send" } },
        toolContext(),
      ),
    ).toMatchObject({ block: true });
  });

  it("a recheck answering person does not lift the brief within the run", async () => {
    const h = fixture();
    fetchMock.mockImplementationOnce(async () => allow(brief));
    await h.reply(replyContext());
    fetchMock.mockImplementation(async () => allow({ authorship: { kind: "person" } }));
    expect(await h.owner.beforeToolCall(toolContext())).toBeUndefined();
    expect(
      h.owner.briefToolBlock(
        { toolName: "fi_user_gmail", params: { action: "send" } },
        toolContext(),
      ),
    ).toMatchObject({ block: true });
  });

  it("a recheck answering brief makes a person's turn a brief", async () => {
    const h = fixture();
    await h.reply(replyContext());
    fetchMock.mockImplementation(async () => allow(brief));
    expect(await h.owner.beforeToolCall(toolContext())).toBeUndefined();
    expect(
      h.owner.briefToolBlock(
        { toolName: "fi_user_gmail", params: { action: "send" } },
        toolContext(),
      ),
    ).toMatchObject({ block: true });
  });

  it("the person's own next message is not blocked, and withdraws the notice", async () => {
    const h = fixture();
    fetchMock.mockImplementationOnce(async () => allow(brief));
    await h.reply(replyContext());
    await h.prompt(replyContext());
    await h.settle("run-1");
    fetchMock.mockImplementation(async () => allow({ authorship: { kind: "person" } }));
    expect(await h.reply(replyContext("run-2", "$own"))).toBeUndefined();
    expect(
      h.owner.briefToolBlock(
        { toolName: "fi_user_gmail", params: { action: "send" } },
        toolContext("run-2"),
      ),
    ).toBeUndefined();
    expect((await h.prompt(replyContext("run-2", "$own")))?.appendSystemContext).toContain(
      "Fi verified this message as the person's own words.",
    );
  });

  it("a continuation of the brief keeps the block whatever Fi answers", async () => {
    const h = fixture();
    fetchMock.mockImplementationOnce(async () => allow(brief));
    await h.reply(replyContext());
    await h.settle("run-1");
    fetchMock.mockImplementation(async () => allow());
    const continuation = {
      runId: "run-2",
      agentId,
      sessionKey,
      sessionId: "session",
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
        sessionKey,
        sessionId: "session",
        requesterContinuation: continuation,
      }),
    ).toBeUndefined();
    expect(
      h.owner.briefToolBlock(
        { toolName: "fi_user_esign", params: { action: "resend" } },
        toolContext("run-2"),
      ),
    ).toMatchObject({ block: true });
  });

  it.each([
    ["on a Matrix run", { channel: "matrix" }],
    ["with no channel, by parent-channel provenance", { spawnedFromChannel: "matrix" }],
    ["with no channel, by lineage alone", {}],
  ] as const)("a child of a brief turn is blocked too, %s", async (_name, channel) => {
    const h = fixture();
    fetchMock.mockImplementationOnce(async () => allow(brief));
    await h.reply(replyContext());
    // Fi answers person for the child's own admission and rechecks: the parent's brief still holds.
    fetchMock.mockImplementation(async () => allow({ authorship: { kind: "person" } }));
    const lineage: Lineage = {
      parentRunId: "run-1",
      parentAgentId: agentId,
      parentSessionKey: sessionKey,
      parentSessionId: "session",
      childRunId: "child-1",
      childAgentId: agentId,
      childSessionKey: childKey,
      childSessionId: "child-session",
      completionTarget: "parent",
      expiresAt: Date.now() + 60_000,
      assertCurrent: () => {},
    };
    expect(
      await h.reply({
        runId: "child-1",
        agentId,
        accountId: "mainprod",
        sessionKey: childKey,
        sessionId: "child-session",
        spawnedFrom: lineage,
        ...channel,
      }),
    ).toBeUndefined();
    const tool = {
      runId: "child-1",
      agentId,
      sessionKey: childKey,
      sessionId: "child-session",
      toolName: "fi_user_deliver_file",
      requester: { accountId: "mainprod" },
      spawnedFrom: lineage,
    } as PluginHookToolContext;
    expect(await h.owner.beforeToolCall(tool)).toBeUndefined();
    expect(
      h.owner.briefToolBlock(
        { toolName: "fi_user_deliver_file", params: { action: "deliver" } },
        tool,
      ),
    ).toMatchObject({ block: true });
    expect(
      h.owner.briefToolBlock({ toolName: "fi_user_gmail", params: { action: "draft" } }, tool),
    ).toBeUndefined();
    expect(
      h.capture({
        runId: "child-1",
        agentId,
        sessionKey: childKey,
      } as OpenClawPluginToolContext)?.authorship,
    ).toMatchObject({ kind: "desk_handoff" });
    expect(
      (await h.prompt({ runId: "child-1", agentId, sessionKey: childKey }))?.appendSystemContext,
    ).toContain("brief written by Desk's agent");
  });
});
