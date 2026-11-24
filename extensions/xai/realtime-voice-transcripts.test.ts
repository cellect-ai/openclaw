import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { FakeWebSocket, isProviderAuthProfileConfiguredAsyncMock, resolveApiKeyForProviderMock } =
  await vi.hoisted(() => import("./realtime-voice-socket.test-support.js"));

vi.mock("./ws-runtime.js", () => ({
  WebSocket: FakeWebSocket,
}));

// mock-isolation: Realtime tests control credential availability and pending resolution without host auth storage.
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: () => false,
  isProviderAuthProfileConfiguredAsync: isProviderAuthProfileConfiguredAsyncMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

import {
  createTestBridge as buildTestBridge,
  openRealtimeBridge,
  parseSent,
  type FakeWebSocketInstance,
  type TestBridgeOptions,
} from "./realtime-voice-provider.test-support.js";

const bridges: ReturnType<typeof buildTestBridge>[] = [];
function createTestBridge(options: Partial<TestBridgeOptions> = {}) {
  const bridge = buildTestBridge(options);
  bridges.push(bridge);
  return bridge;
}

// pragma: allowlist secret

function server(socket: FakeWebSocketInstance, type: string, data: object = {}) {
  socket.emitServer({ type, ...data });
}

function responseCreated(socket: FakeWebSocketInstance, id?: string) {
  server(socket, "response.created", id ? { response: { id } } : {});
}

function transcript(socket: FakeWebSocketInstance, event: string, data: object) {
  server(socket, `conversation.item.input_audio_transcription.${event}`, data);
}

function finalTranscripts(onTranscript: ReturnType<typeof vi.fn>) {
  return onTranscript.mock.calls.filter((call) => call[2]);
}

function snapshot(text: string) {
  return ["user", text, true, expect.objectContaining({ textMode: "snapshot" })];
}

function observers() {
  return {
    onAudio: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn(),
    onReady: vi.fn(),
    onTranscript: vi.fn(),
    onEvent: vi.fn(),
    onToolCall: vi.fn(),
    onResponseDone: vi.fn(),
  };
}

async function connect(options: Partial<TestBridgeOptions> = {}, conversationId?: string) {
  const bridge = createTestBridge(options);
  const socket = await openRealtimeBridge(bridge, FakeWebSocket.instances.length, conversationId);
  return { bridge, socket };
}

async function observe(...names: (keyof ReturnType<typeof observers>)[]) {
  const callbacks = observers();
  const selected: Partial<TestBridgeOptions> = {};
  for (const name of names) {
    selected[name] = callbacks[name];
  }
  return { ...callbacks, ...(await connect(selected)) };
}

function audio(
  socket: FakeWebSocketInstance,
  itemId?: string,
  delta = Buffer.alloc(8000).toString("base64"),
) {
  server(socket, "response.output_audio.delta", { item_id: itemId, delta });
}

function inputTranscript(socket: FakeWebSocketInstance, text: string, itemId?: string) {
  server(socket, "conversation.item.input_audio_transcription.completed", {
    item_id: itemId,
    transcript: text,
  });
}

function responseDone(socket: FakeWebSocketInstance, id?: string, status = "completed") {
  server(socket, "response.done", { response: { id, status } });
}

function userMessageEvent(text: string) {
  return {
    type: "conversation.item.create",
    item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  };
}

describe("buildXaiRealtimeVoiceProvider", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    isProviderAuthProfileConfiguredAsyncMock.mockReset();
    isProviderAuthProfileConfiguredAsyncMock.mockResolvedValue(false);
    resolveApiKeyForProviderMock.mockReset();
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: undefined });
    delete process.env.XAI_API_KEY;
    vi.unstubAllEnvs();
  });

  afterEach(async () => {
    for (const bridge of bridges.splice(0)) {
      await bridge.close();
    }
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("treats xAI input transcription updates as replacements until completed", async () => {
    const onTranscript = vi.fn();
    const bridge = createTestBridge({
      onTranscript,
    });

    const socket = await openRealtimeBridge(bridge);

    socket.emitServer({
      type: "conversation.item.input_audio_transcription.updated",
      item_id: "item_1",
      transcript: "open",
    });
    socket.emitServer({
      type: "conversation.item.input_audio_transcription.updated",
      item_id: "item_1",
      transcript: "open claw",
    });
    socket.emitServer({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_1",
      transcript: "OpenClaw",
    });
    socket.emitServer({ type: "response.done", response: { status: "completed" } });
    await bridge.close();

    expect(onTranscript.mock.calls).toEqual([
      ["user", "OpenClaw", false, { itemId: "item_1", textMode: "snapshot" }],
      ["user", "OpenClaw", true, { itemId: "item_1", textMode: "snapshot" }],
    ]);
  });

  it("replaces a completed input snapshot when a later correction arrives", async () => {
    const onTranscript = vi.fn();
    const bridge = createTestBridge({
      onTranscript,
    });
    const socket = await openRealtimeBridge(bridge);

    socket.emitServer({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_1",
      transcript: "short",
    });
    socket.emitServer({
      type: "conversation.item.input_audio_transcription.updated",
      item_id: "item_1",
      transcript: "the full utterance",
    });
    await bridge.close();

    expect(onTranscript.mock.calls).toEqual([
      ["user", "short", false, { itemId: "item_1", textMode: "snapshot" }],
      ["user", "the full utterance", false, { itemId: "item_1", textMode: "snapshot" }],
      ["user", "the full utterance", true, { itemId: "item_1", textMode: "snapshot" }],
    ]);
  });

  it("forwards standard incremental input-transcription events", async () => {
    const { socket, onTranscript } = await observe("onTranscript");
    transcript(socket, "delta", { item_id: "item_speech", delta: "open claw" });
    expect(onTranscript).toHaveBeenCalledWith("user", "open claw", false);
  });

  it("reports input transcription failures as events and discards their stale replacement text", async () => {
    const onTranscript = vi.fn();
    const onError = vi.fn();
    const onEvent = vi.fn();
    const { socket } = await connect({ onTranscript, onError, onEvent });
    socket.emitServer({
      type: "conversation.item.input_audio_transcription.updated",
      item_id: "item_speech",
      transcript: "stale speech",
    });
    socket.emitServer({
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "item_speech",
      error: { code: "decoder_failure", message: "speech decoder exploded" },
    });
    socket.emitServer({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_speech",
    });
    // A failed item is reported through the bridge event, not as a stream error.
    expect(onError).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith({
      direction: "server",
      type: "conversation.item.input_audio_transcription.failed",
      itemId: "item_speech",
      detail: "speech decoder exploded",
    });
  });

  it("buffers assistant transcript deltas and finalizes them when done has no text", async () => {
    const onTranscript = vi.fn();
    const bridge = createTestBridge({
      onTranscript,
    });

    const socket = await openRealtimeBridge(bridge);

    socket.emitServer({ type: "response.created" });
    socket.emitServer({ type: "response.output_audio_transcript.delta", delta: "Hello " });
    socket.emitServer({ type: "response.output_audio_transcript.delta", delta: "OpenClaw" });
    socket.emitServer({
      type: "response.output_audio_transcript.done",
      item_id: "item_audio",
    });
    socket.emitServer({ type: "response.done" });
    await bridge.close();

    expect(onTranscript).toHaveBeenNthCalledWith(1, "assistant", "Hello ", false);
    expect(onTranscript).toHaveBeenNthCalledWith(2, "assistant", "OpenClaw", false);
    expect(onTranscript).toHaveBeenNthCalledWith(3, "assistant", "Hello OpenClaw", true, {
      itemId: "item_audio",
      textMode: "snapshot",
    });
    expect(onTranscript).toHaveBeenCalledTimes(3);
  });

  it("preserves corrected final text from legacy realtime text events", async () => {
    const onTranscript = vi.fn();
    const { socket } = await connect({ onTranscript });
    socket.emitServer({ type: "response.created" });
    socket.emitServer({ type: "response.text.delta", delta: "draft assistant" });
    socket.emitServer({
      type: "response.text.done",
      item_id: "item_assistant",
      text: "corrected assistant",
    });
    socket.emitServer({ type: "response.done" });
    expect(onTranscript.mock.calls).toEqual([
      ["assistant", "draft assistant", false],
      [
        "assistant",
        "corrected assistant",
        true,
        { itemId: "item_assistant", textMode: "snapshot" },
      ],
    ]);
  });

  it.each([
    {
      name: "non-array output",
      output: { unexpected: true },
      expectedTranscript: undefined,
    },
    {
      name: "a null output item beside a valid message",
      output: [
        null,
        {
          id: "msg_valid",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Valid terminal text" }],
        },
      ],
      expectedTranscript: "Valid terminal text",
    },
    {
      name: "null message content beside a valid part",
      output: [
        {
          id: "msg_valid",
          type: "message",
          role: "assistant",
          content: [null, { type: "output_audio", transcript: "Valid terminal audio" }],
        },
      ],
      expectedTranscript: "Valid terminal audio",
    },
  ])("continues after malformed terminal output: $name", async ({ output, expectedTranscript }) => {
    const onTranscript = vi.fn();
    const { bridge, socket } = await connect({ onTranscript });
    socket.emitServer({ type: "response.created" });
    bridge.sendUserMessage?.("Continue.");
    socket.emitServer({ type: "response.done", response: { status: "completed", output } });
    expect(parseSent(socket).slice(-2)).toEqual([
      userMessageEvent("Continue."),
      { type: "response.create" },
    ]);
    expect(onTranscript.mock.calls).toEqual(
      expectedTranscript
        ? [["assistant", expectedTranscript, true, { itemId: "msg_valid", textMode: "snapshot" }]]
        : [],
    );
  });

  it("previews snapshots immediately and retains corrections after audio starts", async () => {
    const { socket, onTranscript } = await observe("onTranscript");
    server(socket, "input_audio_buffer.speech_started");
    responseCreated(socket, "response-1");
    inputTranscript(socket, "How");
    expect(onTranscript).toHaveBeenLastCalledWith("user", "How", false, { textMode: "snapshot" });
    audio(socket, undefined, "AAA=");
    inputTranscript(socket, "How big is Earth?");
    responseDone(socket, "response-1");
    inputTranscript(socket, "How big is Earth?");
    expect(finalTranscripts(onTranscript)).toEqual([snapshot("How big is Earth?")]);
  });

  it("preserves distinct late input items and repeated words in separate utterances", async () => {
    const { socket, onTranscript } = await observe("onTranscript");
    server(socket, "input_audio_buffer.speech_started");
    inputTranscript(socket, "Again", "late-A");
    inputTranscript(socket, "Again", "B");
    responseCreated(socket, "response-B");
    responseDone(socket, "response-B");
    expect(onTranscript.mock.calls.filter((call) => call[2])).toEqual([
      ["user", "Again", true, { itemId: "late-A", textMode: "snapshot" }],
      ["user", "Again", true, { itemId: "B", textMode: "snapshot" }],
    ]);
  });

  it("preserves pending spoken input when the response fails without duplicating it on close", async () => {
    const { bridge, socket, onTranscript } = await observe("onTranscript");
    inputTranscript(socket, "Check the sensor");
    responseCreated(socket, "response-1");
    responseDone(socket, "response-1", "failed");
    expect(finalTranscripts(onTranscript)).toEqual([snapshot("Check the sensor")]);
    await bridge.close();
    expect(finalTranscripts(onTranscript)).toHaveLength(1);
  });

  it("keeps a pending snapshot when a different input item fails transcription", async () => {
    const { socket, onError, onTranscript } = await observe("onError", "onTranscript");
    server(socket, "input_audio_buffer.speech_started");
    responseCreated(socket, "one");
    inputTranscript(socket, "Read the gauge", "b");
    transcript(socket, "failed", {
      item_id: "a",
      error: { message: "recognition failed" },
    });
    expect(onError).not.toHaveBeenCalled();
    responseDone(socket, "one");
    expect(finalTranscripts(onTranscript)).toEqual([snapshot("Read the gauge")]);
  });

  it("settles input recognized after the response finished once it stops changing", async () => {
    const { socket, onTranscript } = await observe("onTranscript");
    server(socket, "input_audio_buffer.speech_started");
    responseCreated(socket, "one");
    responseDone(socket, "one");
    vi.useFakeTimers();
    inputTranscript(socket, "Check the", "u1");
    vi.advanceTimersByTime(1_000);
    inputTranscript(socket, "Check the sensor", "u1");
    vi.advanceTimersByTime(1_000);
    expect(finalTranscripts(onTranscript)).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(onTranscript.mock.calls.filter((call) => call[2])).toEqual([
      ["user", "Check the sensor", true, { itemId: "u1", textMode: "snapshot" }],
    ]);
    vi.useRealTimers();
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
