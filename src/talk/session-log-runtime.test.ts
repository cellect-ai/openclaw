// Talk session log runtime tests cover persisted voice session log records.
import { describe, expect, it } from "vitest";
import {
  createAssistantSpeechEchoState,
  getRealtimeVoiceBridgeEventHealth,
  getRealtimeVoiceTranscriptHealth,
  isPrefixOfAssistantSpeech,
  isUnpublishedAssistantSpeechEcho,
  observeAssistantSpeechEcho,
  recordRealtimeVoiceBridgeEvent,
  recordRealtimeVoiceTranscript,
  type RealtimeVoiceBridgeEventLogEntry,
  type RealtimeVoiceTranscriptEntry,
} from "./session-log-runtime.js";

describe("realtime voice session log runtime", () => {
  it("records bounded transcript health", () => {
    const transcript: RealtimeVoiceTranscriptEntry[] = [];
    recordRealtimeVoiceTranscript(transcript, "user", "hello", 1);
    recordRealtimeVoiceTranscript(transcript, "assistant", "hi", 1);

    expect(getRealtimeVoiceTranscriptHealth(transcript)).toEqual({
      realtimeTranscriptLines: 1,
      lastRealtimeTranscriptAt: transcript[0]?.at,
      lastRealtimeTranscriptRole: "assistant",
      lastRealtimeTranscriptText: "hi",
      recentRealtimeTranscript: transcript,
    });
  });

  it("skips noisy audio append events and records bridge health", () => {
    const events: RealtimeVoiceBridgeEventLogEntry[] = [];
    recordRealtimeVoiceBridgeEvent(events, {
      direction: "client",
      type: "input_audio_buffer.append",
    });
    recordRealtimeVoiceBridgeEvent(events, {
      direction: "server",
      type: "response.done",
      detail: "ok",
    });

    expect(getRealtimeVoiceBridgeEventHealth(events)).toEqual({
      lastRealtimeEventAt: events[0]?.at,
      lastRealtimeEventType: "server:response.done",
      lastRealtimeEventDetail: "ok",
      recentRealtimeEvents: events,
    });
  });

  it("keeps a stopped answer off the caller's side", () => {
    expect(isPrefixOfAssistantSpeech("I don't have a calendar yet", "I don't have a")).toBe(true);
    expect(isPrefixOfAssistantSpeech("I don't have a calendar yet", "yes")).toBe(false);
    expect(isPrefixOfAssistantSpeech("I don't have a calendar yet", "I don't")).toBe(false);

    const state = createAssistantSpeechEchoState();
    observeAssistantSpeechEcho(state, "user", "When are you going to be there?", true);
    observeAssistantSpeechEcho(state, "assistant", "I ", false, "delta");
    observeAssistantSpeechEcho(state, "assistant", "don't ", false, "delta");
    observeAssistantSpeechEcho(state, "assistant", "have a", false, "delta");
    expect(isUnpublishedAssistantSpeechEcho(state, "I don't have a")).toBe(true);
    expect(isUnpublishedAssistantSpeechEcho(state, "When are you going to be there?")).toBe(false);

    observeAssistantSpeechEcho(state, "assistant", "I don't have a calendar yet", true, "snapshot");
    expect(isUnpublishedAssistantSpeechEcho(state, "I don't have a")).toBe(true);
    expect(isUnpublishedAssistantSpeechEcho(state, "What about Thursday?")).toBe(false);

    observeAssistantSpeechEcho(state, "assistant", "Thursday works.", false, "delta");
    expect(isUnpublishedAssistantSpeechEcho(state, "I don't have a")).toBe(false);
  });
});
