import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { publishChatTerminal } from "./chat-terminal-observer.js";
import {
  createDirectChatContext,
  emitAgentEvent,
  registerChatRun,
} from "./server-chat.agent-events.test-helpers.js";
import {
  createAgentEventHandler,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat.js";
import { broadcastChatTerminal } from "./server-methods/chat-broadcast.js";
import {
  closeRelaySession,
  registerTalkRealtimeRelayAgentRun,
  submitTalkRealtimeRelayToolResult,
} from "./talk/relay/operations.js";
import { relaySessions, type RelaySession } from "./talk/relay/state.js";
import { RelayToolCallLedger } from "./talk/relay/tool-call-ledger.js";

vi.mock("../talk/client-voice-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../talk/client-voice-session.js")>()),
  registerClientVoiceConsultRun: vi.fn(),
}));
vi.mock("./talk/relay/voice.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./talk/relay/voice.js")>()),
  closeRelayVoiceSession: async () => {},
}));
vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: () => ({}),
}));
vi.mock("./session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils.js")>()),
  loadGatewaySessionEntryReadOnly: () => ({ cfg: {}, store: {}, entry: undefined }),
}));

const relayId = "relay-terminal-test";
const runId = "matrix-consult-run";
const sessionKey = "agent:assistant:matrix:channel:!room:example.test:thread:$root";
const callId = "owner-call";
const answer = "Amber lighthouse seven. UTC 02:01.";

function fixture() {
  const context = createDirectChatContext();
  const providerResult = vi.fn<(...args: unknown[]) => void | Promise<void>>();
  const toolCalls = new RelayToolCallLedger({
    onOverflow: () => {
      throw new Error("overflow");
    },
  });
  toolCalls.tryAdmit([callId, "provider-call"]);
  const relay = {
    id: relayId,
    connId: "owner",
    sessionTarget: { agentId: "assistant", sessionKey, canonicalKey: sessionKey, storePath: "" },
    context,
    speakerMxid: "@speaker:example.test",
    matrixRoute: {
      channel: "matrix",
      roomId: "!room:example.test",
      threadRootEventId: "$root",
      accountId: "assistant",
    },
    expiresAtMs: Date.now() + 60_000,
    voiceSessionCreated: true,
    confirmationReadiness: { close: vi.fn() },
    harness: {
      close: vi.fn(),
      forcedConsults: { handles: () => [] },
      talk: { ensureTurn: () => ({ turnId: "voice-turn" }), emit: (event: unknown) => event },
    },
    outputOwnership: { phase: "owned" },
    bridge: {
      bridge: { supportsToolResultSuppression: true },
      submitToolResult: providerResult,
      close: vi.fn(),
    },
    activeAgentRuns: new Map(),
    activeAgentToolCalls: new Map(),
    toolCalls,
    providerToolCallIds: new Map([[callId, "provider-call"]]),
    relayToolCallIdsByProviderId: new Map([["provider-call", callId]]),
    pendingFinalToolResults: new Map(),
    pendingProviderToolResults: new Map(),
    pendingWorkingToolResults: new Map(),
    toolResultEpoch: 0,
    failSession: vi.fn(),
  } as unknown as RelaySession;
  relaySessions.set(relayId, relay);
  registerTalkRealtimeRelayAgentRun({
    relaySessionId: relayId,
    connId: "owner",
    sessionKey,
    runId,
    callId,
  });
  const terminal = (state: "final" | "error" | "aborted" = "final", key = sessionKey, id = runId) =>
    broadcastChatTerminal({
      context,
      runId: id,
      sessionKey: key,
      state,
      ...(state === "error"
        ? { errorMessage: "consult failed" }
        : { message: { role: "assistant", content: [{ type: "text", text: answer }] } }),
    });
  return { context, relay, providerResult, terminal };
}

afterEach(() => {
  const relay = relaySessions.get(relayId);
  if (relay) {
    closeRelaySession(relay, "completed");
  }
  relaySessions.delete(relayId);
  clearAgentRunContext(runId);
  vi.restoreAllMocks();
});

describe("Matrix relay consumes its private chat terminal without browser transcript access", () => {
  it.each(["final", "error", "aborted"] as const)(
    "forwards dispatched %s exactly once and retains Matrix broadcast",
    (state) => {
      const { context, relay, providerResult, terminal } = fixture();
      terminal(state);
      terminal(state);
      expect(providerResult).toHaveBeenCalledTimes(1);
      expect(providerResult).toHaveBeenCalledWith(
        "provider-call",
        state === "final"
          ? { result: answer }
          : { error: state === "error" ? "consult failed" : "Agent run cancelled" },
        undefined,
      );
      expect(context.broadcast).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ runId, state }),
        expect.anything(),
      );
      expect(context.broadcastToConnIds).toHaveBeenCalledWith(
        "talk.event",
        expect.objectContaining({
          callId,
          talkEvent: expect.objectContaining({ type: "tool.result", final: true }),
        }),
        new Set(["owner"]),
        { dropIfSlow: false },
      );
      expect(relay.activeAgentToolCalls.size).toBe(0);
      expect(relay.agentToolCallTerminalSubscriptions?.size).toBe(0);
    },
  );

  it("forwards native streamed completion even when no browser may receive chat events", async () => {
    const { context, providerResult } = fixture();
    registerAgentRunContext(runId, { sessionKey, isControlUiVisible: false, verboseLevel: "off" });
    registerChatRun(context.chatRunState, runId, sessionKey, runId);
    const handler = createAgentEventHandler({
      broadcast: context.broadcast,
      broadcastToConnIds: context.broadcastToConnIds,
      nodeSendToSession: context.nodeSendToSession,
      agentRunSeq: context.agentRunSeq,
      chatRunState: context.chatRunState,
      resolveSessionKeyForRun: () => sessionKey,
      clearAgentRunContext: vi.fn(),
      toolEventRecipients: context.chatRunState.toolEventRecipients,
      sessionEventSubscribers: createSessionEventSubscriberRegistry(),
      sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
      loadGatewaySessionLifecycleSnapshotForEvent: () => ({ row: null }),
      persistGatewaySessionLifecycleEventForEvent: async () => {},
    });
    emitAgentEvent(handler, runId, "assistant", { text: answer }, { seq: 1 });
    emitAgentEvent(handler, runId, "lifecycle", { phase: "end" }, { seq: 2 });
    await vi.waitFor(() =>
      expect(providerResult).toHaveBeenCalledWith("provider-call", { result: answer }, undefined),
    );
    expect(vi.mocked(context.broadcast).mock.calls.filter(([event]) => event === "chat")).toEqual(
      [],
    );
    expect(
      vi.mocked(context.broadcastToConnIds).mock.calls.filter(([event]) => event === "chat"),
    ).toEqual([]);
  });

  it("ignores another run/session and yielded turns before accepting the exact terminal", () => {
    const { terminal, providerResult } = fixture();
    terminal("final", sessionKey, "other-run");
    terminal("final", "other-session");
    publishChatTerminal({ runId, sessionKey, state: "final", yielded: true });
    expect(providerResult).not.toHaveBeenCalled();
    terminal();
    expect(providerResult).toHaveBeenCalledTimes(1);
  });

  it.each(["detached", "replaced", "cancelled", "remapped"] as const)(
    "does not forward after relay ownership is %s",
    (state) => {
      const { relay, terminal, providerResult } = fixture();
      if (state === "detached") {
        closeRelaySession(relay, "completed");
      }
      if (state === "replaced") {
        relaySessions.set(relayId, { ...relay, agentToolCallTerminalSubscriptions: new Map() });
      }
      if (state === "cancelled") {
        relay.toolCalls.markCancelled([callId], "voice-turn");
      }
      if (state === "remapped") {
        relay.activeAgentToolCalls.set(callId, "replacement-run");
      }
      terminal();
      expect(providerResult).not.toHaveBeenCalled();
      expect(relay.agentToolCallTerminalSubscriptions?.size).toBe(0);
    },
  );

  it("shares one asynchronous submission with an old browser's duplicate result", async () => {
    const { providerResult, terminal, relay } = fixture();
    const accepted = createDeferred();
    providerResult.mockReturnValue(accepted.promise);
    terminal();
    const duplicate = submitTalkRealtimeRelayToolResult({
      relaySessionId: relayId,
      connId: "owner",
      callId,
      result: { result: answer },
    });
    expect(providerResult).toHaveBeenCalledTimes(1);
    accepted.resolve();
    await duplicate;
    expect(relay.toolCalls.isAgentCompleted(callId)).toBe(true);
  });

  it("turns provider result delivery failure into an owner-visible relay failure", async () => {
    const { providerResult, terminal, relay } = fixture();
    providerResult.mockRejectedValue(new Error("provider output rejected"));
    terminal();
    await vi.waitFor(() =>
      expect(relay.failSession).toHaveBeenCalledWith(
        expect.stringContaining("provider output rejected"),
      ),
    );
  });
});
