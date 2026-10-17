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

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createChatAbortContext } from "./server-methods/chat.abort.test-helpers.js";
import { startTalkRealtimeAgentConsult } from "./talk/agent-consult.js";
import { relaySessions, type RelaySession } from "./talk/relay/state.js";
import { RelayToolCallLedger } from "./talk/relay/tool-call-ledger.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";

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
  // The 10.4 projection guard requires an entry-carrying load to capture its
  // physical source. Seed a GENUINE captured source from a real temporary
  // agent database so the guard exercises its real retain/assert path.
  let stateDir = "";
  beforeEach(() => {
    vi.clearAllMocks();
    stateDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-speaker-"));
    const agentDbPath = path.join(stateDir, "agent.sqlite");
    const database = openOpenClawAgentDatabase({ agentId: "cellect-fi-user", path: agentDbPath });
    const { identity, birthtime } = readOpenClawAgentDatabaseIdentity(database);
    const capturedReadSource: CapturedSessionEntryReadSource = {
      agentId: "cellect-fi-user",
      path: agentDbPath,
      databaseIdentity: identity,
      ...(birthtime ? { databaseBirthtime: birthtime } : {}),
    };
    mocks.load.mockReturnValue({
      cfg,
      storePath: "/test/sessions.json",
      entry: { sessionId: "existing" },
      canonicalKey: sessionKey,
      capturedReadSource,
      capturedReadSources: [capturedReadSource],
    });
    mocks.register.mockReturnValue("registered");
    mocks.preAdmission.mockResolvedValue(true);
  });
  afterEach(() => {
    relaySessions.delete("owned-relay");
    closeOpenClawAgentDatabasesForTest();
    if (stateDir) {
      rmSync(stateDir, { recursive: true, force: true });
      stateDir = "";
    }
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
