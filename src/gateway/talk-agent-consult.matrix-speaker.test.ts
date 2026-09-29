import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  preAdmission: vi.fn(),
  register: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("./session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils.js")>()),
  loadSessionEntry: mocks.load,
}));
vi.mock("./server-methods/chat-send-pre-admission.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-methods/chat-send-pre-admission.js")>()),
  runChatSendPreAdmission: mocks.preAdmission,
}));
vi.mock("./server-methods/chat-send-agent-dispatch.js", () => ({
  startChatDispatch: mocks.dispatch,
}));
vi.mock("./talk/relay/index.js", () => ({
  prepareTalkRealtimeRelayAgentRunRegistration: () => mocks.register,
}));

import { createChatAbortContext } from "./server-methods/chat.abort.test-helpers.js";
import { startTalkRealtimeAgentConsult } from "./talk/agent-consult.js";
import { relaySessions, type RelaySession } from "./talk/relay/state.js";
import { RelayToolCallLedger } from "./talk/relay/tool-call-ledger.js";

const sessionKey = "agent:cellect-fi-user:matrix:channel:!private:example.test:thread:$root";
const route = {
  channel: "matrix" as const,
  roomId: "!private:example.test",
  threadRootEventId: "$root",
  accountId: "fi-user",
};
const cfg = { agents: { entries: { "cellect-fi-user": {} } }, session: {} };

function params() {
  return {
    context: createChatAbortContext({
      getRuntimeConfig: () => cfg,
      addChatRun: vi.fn(),
      logGateway: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }),
    client: {
      connId: "browser-owner",
      pairedClientId: "openclaw-control-ui",
      allowedAgentIds: ["cellect-fi-user"],
      connect: {
        scopes: ["operator.write"],
        client: { id: "openclaw-control-ui", mode: "webchat", version: "test", platform: "web" },
      },
    },
    isWebchatConnect: () => true,
    requestId: "request",
    req: { id: "request", type: "req", method: "talk.client.toolCall" },
    sessionKey,
    callId: "provider-call",
    args: { question: "What is the budget of 82 Sussex?" },
    relaySessionId: "owned-relay",
    connId: "browser-owner",
    matrixRoute: route,
  } as unknown as Parameters<typeof startTalkRealtimeAgentConsult>[0] & {
    callId: string;
    args: unknown;
    relaySessionId: string;
    connId: string;
    matrixRoute: typeof route;
  };
}

// 2026.9.6 splits the consult into the handler request and a prepared session target.
function consult(input: ReturnType<typeof params>) {
  return startTalkRealtimeAgentConsult(input, {
    sessionTarget: {
      agentId: "cellect-fi-user",
      sessionKey,
      canonicalKey: sessionKey,
      storePath: "/test/sessions.json",
    },
    callId: input.callId,
    args: input.args,
    relaySessionId: input.relaySessionId,
    connId: input.connId,
    matrixRoute: input.matrixRoute,
  });
}

function relay(speakerMxid?: string): RelaySession {
  const toolCalls = new RelayToolCallLedger({
    onOverflow: () => {
      throw new Error("overflow");
    },
  });
  toolCalls.tryAdmit(["provider-call"]);
  return {
    id: "owned-relay",
    connId: "browser-owner",
    sessionTarget: {
      agentId: "cellect-fi-user",
      sessionKey,
      canonicalKey: sessionKey,
      storePath: "",
    },
    matrixRoute: route,
    ...(speakerMxid ? { speakerMxid } : {}),
    expiresAtMs: Date.now() + 60_000,
    toolCalls,
  } as RelaySession;
}

async function dispatchedContext() {
  const result = await consult(params());
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  return mocks.dispatch.mock.calls[0]?.[0]?.turn.ctx as Record<string, unknown>;
}

describe("Matrix voice consult requester", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.load.mockReturnValue({
      cfg,
      storePath: "/test/sessions.json",
      entry: { sessionId: "existing" },
      canonicalKey: sessionKey,
    });
    mocks.register.mockReturnValue("registered");
    mocks.preAdmission.mockResolvedValue(true);
  });
  afterEach(() => {
    relaySessions.delete("owned-relay");
  });

  it("runs as the speaker the app server attested for the binding", async () => {
    relaySessions.set("owned-relay", relay("@member:threads.example"));
    const ctx = await dispatchedContext();
    expect(ctx).toMatchObject({
      OriginatingChannel: "matrix",
      SenderId: "@member:threads.example",
    });
  });

  it("carries no requester when the relay has no attested speaker", async () => {
    relaySessions.set("owned-relay", relay());
    const ctx = await dispatchedContext();
    expect(ctx.OriginatingChannel).toBe("matrix");
    expect(ctx.SenderId).toBeUndefined();
  });
});
