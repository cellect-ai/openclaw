import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { ensureClientVoiceAgentSessionEntry } from "../talk/client-voice-session-write.js";
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
import { useRelayFixtures } from "./talk/relay/fixture.test-support.js";
import {
  closeRelaySession,
  prepareTalkRealtimeRelayAgentRunRegistration,
  submitTalkRealtimeRelayToolResult,
} from "./talk/relay/operations.js";
import { relaySessions } from "./talk/relay/state.js";

const createRelay = useRelayFixtures();
const runId = "matrix-consult-run";
const sessionKey = "agent:assistant:matrix:channel:!room:example.test:thread:$root";
const callId = "owner-call";
const answer = "Amber lighthouse seven. UTC 02:01.";

async function fixture() {
  const context = createDirectChatContext();
  const cfg = { agents: { entries: { assistant: {} } } };
  setRuntimeConfigSnapshot(cfg);
  context.getRuntimeConfig = () => cfg;
  await ensureClientVoiceAgentSessionEntry({ agentId: "assistant", sessionKey });
  const { relay } = await createRelay({
    cfg,
    key: sessionKey,
    connId: "owner",
    context,
    speakerMxid: "@speaker:example.test",
    matrixRoute: {
      channel: "matrix",
      roomId: "!room:example.test",
      threadRootEventId: "$root",
      accountId: "assistant",
    },
  });
  const providerResult = vi.spyOn(relay.bridge, "submitToolResult").mockImplementation(() => {});
  vi.spyOn(relay, "failSession").mockImplementation(() => {});
  relay.toolCalls.tryAdmit([callId, "provider-call"]);
  relay.providerToolCallIds.set(callId, "provider-call");
  relay.relayToolCallIdsByProviderId.set("provider-call", callId);
  const register = prepareTalkRealtimeRelayAgentRunRegistration({
    relaySessionId: relay.id,
    connId: relay.connId,
    sessionKey,
    callId,
  });
  await register(runId);
  const terminal = (state: "final" | "error" | "aborted" = "final", key = sessionKey, id = runId) =>
    broadcastChatTerminal({
      context,
      terminalEntry: undefined,
      runId: id,
      sessionKey: key,
      ...(state === "error"
        ? { state, errorMessage: "consult failed" }
        : { state, message: { role: "assistant", content: [{ type: "text", text: answer }] } }),
    });
  return { context, relay, providerResult, terminal, register };
}

afterEach(() => {
  clearAgentRunContext(runId);
  clearAgentRunContext("replacement-run");
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

describe("Matrix relay consumes its private chat terminal without browser transcript access", () => {
  it.each(["final", "error", "aborted"] as const)(
    "forwards dispatched %s exactly once and retains Matrix broadcast",
    async (state) => {
      const { context, relay, providerResult, terminal } = await fixture();
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

  it("speaks a display-hidden consult final without putting that text on the chat socket", async () => {
    const { context, providerResult } = await fixture();
    broadcastChatTerminal({
      context,
      terminalEntry: undefined,
      runId,
      sessionKey,
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: answer }],
        display: false,
      },
    });
    expect(providerResult).toHaveBeenCalledWith("provider-call", { result: answer }, undefined);
    const chatPayload = vi
      .mocked(context.broadcast)
      .mock.calls.find(([event]) => event === "chat")?.[1];
    expect(chatPayload).toBeDefined();
    if (!chatPayload || typeof chatPayload !== "object")
      throw new Error("Expected native chat frame");
    expect("message" in chatPayload ? chatPayload.message : undefined).toBeUndefined();
  });

  it("forwards native streamed completion even when no browser may receive chat events", async () => {
    const { context, providerResult } = await fixture();
    registerAgentRunContext(runId, {
      sessionKey,
      isControlUiVisible: false,
      projectSessionMessages: false,
      verboseLevel: "off",
    });
    registerChatRun(context.chatRunState, runId, sessionKey, runId);
    const handler = createAgentEventHandler({
      broadcast: context.broadcast,
      broadcastToConnIds: context.broadcastToConnIds,
      nodeSendToSession: context.nodeSendToSession,
      nodeHasSessionSubscribers: () => false,
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

  it("ignores another run/session and yielded turns before accepting the exact terminal", async () => {
    const { terminal, providerResult } = await fixture();
    terminal("final", sessionKey, "other-run");
    terminal("final", "other-session");
    publishChatTerminal({ runId, sessionKey, state: "final", yielded: true });
    expect(providerResult).not.toHaveBeenCalled();
    terminal();
    expect(providerResult).toHaveBeenCalledTimes(1);
  });

  it.each(["detached", "replaced", "cancelled", "remapped"] as const)(
    "does not forward after relay ownership is %s",
    async (state) => {
      const { relay, terminal, providerResult, register } = await fixture();
      if (state === "detached") {
        await closeRelaySession(relay, "completed");
      }
      if (state === "replaced") {
        relaySessions.set(relay.id, { ...relay, agentToolCallTerminalSubscriptions: new Map() });
      }
      if (state === "cancelled") {
        relay.toolCalls.markCancelled([callId], "voice-turn");
      }
      if (state === "remapped") {
        await register("replacement-run");
      }
      terminal();
      expect(providerResult).not.toHaveBeenCalled();
      if (state === "remapped") {
        expect(relay.agentToolCallTerminalSubscriptions?.size).toBe(1);
        terminal("final", sessionKey, "replacement-run");
        expect(providerResult).toHaveBeenCalledTimes(1);
      }
      expect(relay.agentToolCallTerminalSubscriptions?.size).toBe(0);
    },
  );

  it("shares one asynchronous submission with an old browser's duplicate result", async () => {
    const { providerResult, terminal, relay } = await fixture();
    const accepted = createDeferred();
    providerResult.mockReturnValue(accepted.promise);
    terminal();
    const duplicate = submitTalkRealtimeRelayToolResult({
      relaySessionId: relay.id,
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
    const { providerResult, terminal, relay } = await fixture();
    providerResult.mockRejectedValue(new Error("provider output rejected"));
    terminal();
    await vi.waitFor(() =>
      expect(relay.failSession).toHaveBeenCalledWith(
        expect.stringContaining("provider output rejected"),
      ),
    );
  });
});
