import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn(), preAdmission: vi.fn(), register: vi.fn() }));
vi.mock("./session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils.js")>()),
  loadSessionEntry: mocks.load,
}));
vi.mock("./server-methods/chat-send-pre-admission.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-methods/chat-send-pre-admission.js")>()),
  runChatSendPreAdmission: mocks.preAdmission,
}));
vi.mock("./talk/relay/index.js", () => ({
  prepareTalkRealtimeRelayAgentRunRegistration: () => mocks.register,
}));

import { handleChatSend } from "./server-methods/chat-send-handler.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { startTalkRealtimeAgentConsult } from "./talk/agent-consult.js";
import { relaySessions, type RelaySession } from "./talk/relay/state.js";
import { RelayToolCallLedger } from "./talk/relay/tool-call-ledger.js";

const sessionKey = "agent:admin:matrix:channel:!private:example.test:thread:$root";
const route = {
  channel: "matrix" as const,
  roomId: "!private:example.test",
  threadRootEventId: "$root",
  accountId: "admin",
};
const cfg = { agents: { entries: { admin: {} } }, session: {} };

function params() {
  return {
    context: { getRuntimeConfig: () => cfg, logGateway: { warn: vi.fn(), info: vi.fn() } },
    client: {
      connId: "browser-owner",
      pairedClientId: "openclaw-control-ui",
      allowedAgentIds: ["admin"],
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
    args: { question: "Read the current time" },
    relaySessionId: "owned-relay",
    connId: "browser-owner",
    matrixRoute: route,
  } as unknown as GatewayRequestHandlerOptions & {
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
      agentId: "admin",
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

describe("Matrix voice consult crosses the real browser chat authorization boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const toolCalls = new RelayToolCallLedger({
      onOverflow: () => {
        throw new Error("overflow");
      },
    });
    toolCalls.tryAdmit(["provider-call"]);
    relaySessions.set("owned-relay", {
      id: "owned-relay",
      connId: "browser-owner",
      sessionTarget: { agentId: "assistant", sessionKey, canonicalKey: sessionKey, storePath: "" },
      matrixRoute: route,
      expiresAtMs: Date.now() + 60_000,
      toolCalls,
    } as RelaySession);
    mocks.load.mockReturnValue({
      cfg,
      storePath: "/test/sessions.json",
      entry: { sessionId: "existing" },
      canonicalKey: sessionKey,
    });
    mocks.register.mockReturnValue("registered");
    // Stop at the downstream work boundary: no model or durable side effects in this test.
    mocks.preAdmission.mockImplementation(async ({ respond, request }) => {
      respond(true, { status: "started", runId: request.p.idempotencyKey });
      return false;
    });
  });
  afterEach(() => {
    relaySessions.delete("owned-relay");
  });

  it("admits an owned, live Matrix voice consult without dropping browser identity", async () => {
    const input = params();
    const result = await consult(input);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    // The chat path derives its own client view; browser identity and ceilings must survive.
    expect(mocks.preAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        client: expect.objectContaining({
          connId: "browser-owner",
          pairedClientId: "openclaw-control-ui",
          allowedAgentIds: ["admin"],
        }),
      }),
    );
  });

  it("still rejects raw browser chat with the same known Matrix key", async () => {
    const input = params();
    const respond = vi.fn();
    await handleChatSend({
      ...input,
      respond,
      params: { sessionKey, message: "inject", idempotencyKey: "raw" },
    } as unknown as GatewayRequestHandlerOptions);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "Matrix conversations require an authorized conversation binding",
      }),
    );
    expect(mocks.preAdmission).not.toHaveBeenCalled();
  });

  it("does not widen the paired device agent ceiling", async () => {
    const input = params();
    input.client!.allowedAgentIds = ["other-agent"];
    expect(await consult(input)).toMatchObject({ ok: false });
    expect(mocks.preAdmission).not.toHaveBeenCalled();
  });

  it.each([
    "closed",
    "wrong-connection",
    "wrong-route",
    "cancelled",
    "expired",
    "canonical-target-changed",
  ])("rejects %s authority before work", async (failure) => {
    const input = params();
    const relay = relaySessions.get("owned-relay")!;
    if (failure === "closed") {
      relaySessions.delete("owned-relay");
    }
    if (failure === "wrong-connection") {
      input.client!.connId = "other-browser";
    }
    if (failure === "wrong-route") {
      input.matrixRoute = { ...route, threadRootEventId: "$other" };
    }
    if (failure === "cancelled") {
      relay.toolCalls.markAgentCompleted(["provider-call"]);
    }
    if (failure === "expired") {
      relay.expiresAtMs = Date.now() - 1;
    }
    if (failure === "canonical-target-changed") {
      mocks.load.mockReturnValue({
        cfg,
        storePath: "/test/sessions.json",
        entry: { sessionId: "other" },
        canonicalKey: sessionKey + "-other",
      });
    }
    expect(await consult(input)).toMatchObject({ ok: false });
    expect(mocks.preAdmission).not.toHaveBeenCalled();
  });
});
