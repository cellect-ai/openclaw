// Recorded LiteLLM / grok-voice-think-fast-2.0 input-transcription sequence
// (2026-10-30, ids shortened, audio deltas omitted). Grok's cumulative snapshots
// for one spoken item arrived 2.1 s apart while the speaker was still talking.
// The settle window committed "No, wait, stop." mid-sentence and dropped every
// later snapshot of the item, so the rest of the speech never reached the relay.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { FakeWebSocket } = await vi.hoisted(() => import("./realtime-voice-socket.test-support.js"));

vi.mock("./ws-runtime.js", () => ({
  WebSocket: FakeWebSocket,
}));

import { buildLiteLlmRealtimeVoiceProvider } from "./realtime-voice-provider.js";
import { waitForRealtimeState } from "./realtime-voice-provider.test-support.js";

const ITEM = "a30f086c";
const FULL = "No, wait, stop. I meant for the month of September only.";

const RECORDED: Array<[number, Record<string, unknown>]> = [
  [0, { type: "input_audio_buffer.speech_started", item_id: ITEM }],
  [
    125,
    {
      type: "conversation.item.input_audio_transcription.updated",
      item_id: ITEM,
      transcript: "No, wait, stop.",
    },
  ],
  [
    125,
    {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: ITEM,
      transcript: "No, wait, stop.",
    },
  ],
  [
    2256,
    {
      type: "conversation.item.input_audio_transcription.updated",
      item_id: ITEM,
      transcript: "No, wait, stop. I meant for the month of",
    },
  ],
  [
    2257,
    {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: ITEM,
      transcript: "No, wait, stop. I meant for the month of",
    },
  ],
  [
    3376,
    {
      type: "conversation.item.input_audio_transcription.updated",
      item_id: ITEM,
      transcript: FULL,
    },
  ],
  [
    3376,
    {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: ITEM,
      transcript: FULL,
    },
  ],
  [3990, { type: "input_audio_buffer.speech_stopped", item_id: ITEM }],
  [
    4191,
    {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: ITEM,
      transcript: FULL,
    },
  ],
  [4197, { type: "response.created", response: { id: "6e541d24", status: "in_progress" } }],
  [4420, { type: "input_audio_buffer.committed", item_id: ITEM }],
  [
    4420,
    {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: ITEM,
      transcript: FULL,
    },
  ],
  [
    6363,
    {
      type: "response.output_audio_transcript.done",
      item_id: "a736bdc8",
      response_id: "6e541d24",
      transcript: "Let me get the exact figure for September.",
    },
  ],
  [6365, { type: "response.done", response: { id: "6e541d24", status: "completed" } }],
];

async function replay(events: Array<[number, Record<string, unknown>]>) {
  const finals: Array<[string, string]> = [];
  const previews: string[] = [];
  const onError = vi.fn();
  const bridge = buildLiteLlmRealtimeVoiceProvider().createBridge({
    providerConfig: { apiKey: "litellm-test", model: "grok-voice-think-fast-2.0" }, // pragma: allowlist secret
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
    onError,
    onTranscript: (role, text, final) => {
      if (final) {
        finals.push([role, text]);
      } else if (role === "user") {
        previews.push(text);
      }
    },
  });
  const connecting = bridge.connect();
  await waitForRealtimeState(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.instances[0]!;
  socket.open();
  socket.emitServer({ type: "session.updated" });
  await connecting;
  vi.useFakeTimers();
  let now = 0;
  for (const [at, event] of events) {
    await vi.advanceTimersByTimeAsync(at - now);
    now = at;
    socket.emitServer(event);
  }
  await vi.advanceTimersByTimeAsync(3_000);
  return { bridge, finals, previews, onError };
}

describe("LiteLLM grok input transcription across snapshot gaps", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the utterance open until the server VAD stops it", async () => {
    const { bridge, finals, previews, onError } = await replay(RECORDED);
    expect(previews.at(-1)).toBe(FULL);
    expect(finals).toEqual([
      ["user", FULL],
      ["assistant", "Let me get the exact figure for September."],
    ]);
    expect(onError).not.toHaveBeenCalled();
    vi.useRealTimers();
    await bridge.close();
    expect(finals.filter(([role]) => role === "user")).toHaveLength(1);
  });

  it("commits a stopped utterance after the quiet period when no response follows", async () => {
    const stoppedOnly = RECORDED.filter(([at]) => at <= 4191);
    const { bridge, finals } = await replay(stoppedOnly);
    expect(finals).toEqual([["user", FULL]]);
    vi.useRealTimers();
    await bridge.close();
    expect(finals).toHaveLength(1);
  });
});
