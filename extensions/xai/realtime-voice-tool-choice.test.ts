// Talk announcements ask for a response without tools. Grok through LiteLLM
// accepts tool_choice "none" on response.create and still calls tools (checked
// live 2026-10-31), so the bridge both sends it and refuses such a call itself.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { FakeWebSocket } = await vi.hoisted(() => import("./realtime-voice-socket.test-support.js"));

vi.mock("./ws-runtime.js", () => ({
  WebSocket: FakeWebSocket,
}));

import { buildLiteLlmRealtimeVoiceProvider } from "./realtime-voice-provider.js";
import {
  createTestBridge,
  type FakeWebSocketInstance,
  openRealtimeBridge,
  parseSent,
  waitForRealtimeState,
} from "./realtime-voice-provider.test-support.js";

const bridges: Array<{ close(): Promise<void> | void }> = [];

async function connect(
  options: {
    model?: string;
    onToolCall?: ReturnType<typeof vi.fn>;
    onEvent?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const bridge = buildLiteLlmRealtimeVoiceProvider().createBridge({
    providerConfig: { apiKey: "litellm-test", model: options.model ?? "grok-voice-think-fast-2.0" }, // pragma: allowlist secret
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
    ...(options.onToolCall ? { onToolCall: options.onToolCall } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });
  bridges.push(bridge);
  const index = FakeWebSocket.instances.length;
  const connecting = bridge.connect();
  await waitForRealtimeState(() => expect(FakeWebSocket.instances).toHaveLength(index + 1));
  const socket = FakeWebSocket.instances[index]!;
  socket.open();
  socket.emitServer({ type: "session.updated" });
  await connecting;
  return { bridge, socket };
}

function responseCreates(socket: FakeWebSocketInstance) {
  return parseSent(socket).filter((event) => event.type === "response.create");
}

describe("LiteLLM / xAI realtime response tool choice", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const bridge of bridges.splice(0)) {
      await bridge.close();
    }
  });

  it("asks for a response without tools when the announcement says so", async () => {
    const { bridge, socket } = await connect();

    bridge.sendUserMessage?.("I have an answer.", { toolChoice: "none" });
    expect(responseCreates(socket)).toEqual([
      { type: "response.create", response: { tool_choice: "none" } },
    ]);
  });

  it("does not send tool_choice to Gemini Live", async () => {
    const { bridge, socket } = await connect({ model: "gemini-3.8-live" });

    bridge.sendUserMessage?.("I have an answer.", { toolChoice: "none" });
    expect(responseCreates(socket)).toEqual([{ type: "response.create" }]);
  });

  it("keeps a deferred none when a plain request queues behind it, and the reverse", async () => {
    const { bridge, socket } = await connect();
    socket.emitServer({ type: "response.created", response: { id: "busy" } });

    bridge.sendUserMessage?.("announce", { toolChoice: "none" });
    bridge.sendUserMessage?.("plain");
    socket.emitServer({ type: "response.done", response: { id: "busy", status: "completed" } });
    expect(responseCreates(socket)).toEqual([
      { type: "response.create", response: { tool_choice: "none" } },
    ]);

    socket.emitServer({ type: "response.created", response: { id: "second" } });
    bridge.sendUserMessage?.("plain first");
    bridge.sendUserMessage?.("announce later", { toolChoice: "none" });
    socket.emitServer({ type: "response.done", response: { id: "second", status: "completed" } });
    expect(responseCreates(socket).at(-1)).toEqual({
      type: "response.create",
      response: { tool_choice: "none" },
    });
  });

  it("retries a rejected create with the tool choice it carried", async () => {
    const { bridge, socket } = await connect();

    bridge.sendUserMessage?.("announce", { toolChoice: "none" });
    socket.emitServer({
      type: "error",
      error: { message: "Conversation already has an active response in progress: resp_1" },
    });
    socket.emitServer({ type: "response.done", response: { status: "completed" } });

    expect(responseCreates(socket)).toEqual([
      { type: "response.create", response: { tool_choice: "none" } },
      { type: "response.create", response: { tool_choice: "none" } },
    ]);
  });

  it("refuses a tool call in a tool-free response without starting another", async () => {
    const onToolCall = vi.fn();
    const onEvent = vi.fn();
    const { bridge, socket } = await connect({ onToolCall, onEvent });

    bridge.sendUserMessage?.("announce", { toolChoice: "none" });
    socket.emitServer({ type: "response.created", response: { id: "announce" } });
    socket.emitServer({
      type: "response.done",
      response: {
        id: "announce",
        status: "completed",
        output: [
          {
            id: "item-call",
            type: "function_call",
            status: "completed",
            call_id: "call-1",
            name: "openclaw_agent_consult",
            arguments: '{"question":"How much did we invoice?"}',
          },
        ],
      },
    });

    expect(onToolCall).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tool_call.refused",
        detail: "reason=tool_choice_none name=openclaw_agent_consult",
      }),
    );
    const sent = parseSent(socket);
    expect(sent.filter((event) => event.item?.type === "function_call_output")).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call-1",
          output: JSON.stringify({ error: "Tools are unavailable while announcing an answer." }),
        },
      },
    ]);
    expect(responseCreates(socket)).toHaveLength(1);
  });

  it("still dispatches tool calls in an ordinary response after an announcement", async () => {
    const onToolCall = vi.fn();
    const { bridge, socket } = await connect({ onToolCall });

    bridge.sendUserMessage?.("announce", { toolChoice: "none" });
    socket.emitServer({ type: "response.created", response: { id: "announce" } });
    socket.emitServer({ type: "response.done", response: { id: "announce", status: "completed" } });
    // A server-VAD response: nobody asked for it, so it carries no tool choice.
    socket.emitServer({ type: "response.created", response: { id: "vad" } });
    socket.emitServer({
      type: "response.done",
      response: {
        id: "vad",
        status: "completed",
        output: [
          {
            id: "item-call-2",
            type: "function_call",
            status: "completed",
            call_id: "call-2",
            name: "openclaw_agent_consult",
            arguments: "{}",
          },
        ],
      },
    });

    expect(onToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "call-2", name: "openclaw_agent_consult" }),
    );
  });

  it("keeps the tool choice of a message queued during an xAI session reconnect", async () => {
    vi.useFakeTimers();
    const bridge = createTestBridge({
      providerConfig: { apiKey: "xai-test", sessionResumption: true }, // pragma: allowlist secret
    });
    bridges.push(bridge);
    const socket = await openRealtimeBridge(
      bridge,
      FakeWebSocket.instances.length,
      "conv_announce",
    );
    const index = FakeWebSocket.instances.length;
    socket.close(1006, "connection lost");
    bridge.sendUserMessage?.("announce", { toolChoice: "none" });
    await vi.advanceTimersByTimeAsync(1_000);
    await waitForRealtimeState(() => expect(FakeWebSocket.instances).toHaveLength(index + 1));
    const replacement = FakeWebSocket.instances[index]!;
    replacement.open();
    replacement.emitServer({ type: "session.updated" });

    expect(responseCreates(replacement)).toEqual([
      { type: "response.create", response: { tool_choice: "none" } },
    ]);
  });
});
