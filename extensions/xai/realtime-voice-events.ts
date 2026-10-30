import {
  canonicalizeBase64,
  normalizeRealtimeVoiceResponseOutcome,
  type RealtimeVoiceSessionConnection,
} from "openclaw/plugin-sdk/realtime-voice-provider";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  XAI_REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX,
  XAI_REALTIME_NO_ACTIVE_RESPONSE_CANCEL_ERROR,
  readXaiRealtimeErrorDetail,
  type XaiRealtimeEvent,
} from "./realtime-voice-config.js";
import { XaiRealtimeVoiceProtocol } from "./realtime-voice-protocol.js";

export class XaiRealtimeMalformedAudioError extends Error {}

// Quiet period before committing recognized speech. A long assistant turn must
// not hold the utterance: the timeline send happens once this window passes,
// or sooner when the current response finishes. The window only runs once the
// server VAD has closed the item: Grok's cumulative snapshots arrive about once
// a second but leave gaps over two seconds mid-sentence, and a committed item
// accepts no later snapshot.
const XAI_REALTIME_INPUT_SETTLE_MS = 1_500;

export abstract class XaiRealtimeVoiceEvents extends XaiRealtimeVoiceProtocol {
  private assistantTranscriptBuffer = "";
  private assistantTranscriptFinalized = false;
  private pendingInputTranscript: { key: string; text: string; itemId?: string } | undefined;
  private finalizedInputTranscriptKeys = new Set<string>();
  private inputSpeechSequence = 0;
  // The input item the server VAD is still hearing; null while nobody speaks.
  // An item started without an id is tracked as "" and matches any snapshot.
  private openInputSpeechItemId: string | null = null;
  private inputResponseStarted = false;
  private outputResponse: { id?: string; ended: boolean } | undefined;
  private finalizedToolCallItems = new Set<string>();
  private inputTranscriptReplacements = new Map<string, string>();
  private inputSettleTimer: ReturnType<typeof setTimeout> | undefined;

  protected abstract acceptsEvent(connection: RealtimeVoiceSessionConnection): boolean;
  protected abstract onSessionUpdated(connection: RealtimeVoiceSessionConnection): void;

  protected handleEvent(event: XaiRealtimeEvent, connection: RealtimeVoiceSessionConnection): void {
    const responseId = event.response_id ?? event.response?.id;
    // A terminal retires all output from that response. Fence late deltas and
    // duplicate terminals before they reach the relay or mutate the next response.
    if (
      event.type.startsWith("response.") &&
      event.type !== "response.created" &&
      this.outputResponse &&
      (this.outputResponse.ended ||
        (responseId && this.outputResponse.id && responseId !== this.outputResponse.id))
    ) {
      return;
    }
    if (event.type === "response.created" && this.acceptsEvent(connection)) {
      // Publish the response owner before observers can interrupt its first PCM.
      this.inputResponseStarted = true;
      // Cancellation before response.created belongs to that pending response.
      // Only an identified successor can retire an older live response's fence.
      if (
        this.outputResponse &&
        !this.outputResponse.ended &&
        responseId &&
        this.outputResponse.id &&
        responseId !== this.outputResponse.id
      ) {
        this.responseCancelInFlight = false;
      }
      this.outputResponse = { id: responseId, ended: false };
      // The fence drops a retired response's late terminal, including its buffer
      // cleanup, so the successor must not inherit the predecessor's tool calls.
      this.toolCallBuffers.clear();
      this.finalizedToolCallItems.clear();
      this.outputAudioGeneration += 1;
      this.responseActive = true;
      this.responseCreateInFlight = false;
      this.markQueue = [];
      this.assistantAudioItem = null;
      this.resetAssistantTranscript();
    }
    const audioGeneration = this.outputAudioGeneration;
    const bridgeEvent = {
      direction: "server",
      type: event.type,
      detail: this.describeServerEvent(event),
      ...(event.item_id ? { itemId: event.item_id } : {}),
      ...((event.response_id ?? event.response?.id)
        ? { responseId: event.response_id ?? event.response?.id }
        : {}),
    } as const;
    const emitBridgeEvent = () => this.config.onEvent?.(bridgeEvent);
    if (event.type !== "response.done" || !this.acceptsEvent(connection)) {
      emitBridgeEvent();
    }
    if (!this.acceptsEvent(connection)) {
      return;
    }
    switch (event.type) {
      case "session.created":
        // LiteLLM currently normalizes Gemini Live's setupComplete response to
        // session.created even when it acknowledges our session.update. Treat
        // that event as setup-complete only for the proxy adapter; native xAI
        // sessions still wait for the explicit session.updated event.
        if (this.config.providerId === "litellm") {
          this.onSessionUpdated(connection);
        }
        return;
      case "conversation.created": {
        const conversationId = normalizeOptionalString(event.conversation?.id);
        if (conversationId) {
          this.conversationId = conversationId;
        }
        return;
      }
      case "conversation.item.created":
      case "conversation.item.added": {
        const item = event.item;
        const callId = normalizeOptionalString(item?.call_id);
        if (item?.type === "function_call_output" && callId) {
          this.pendingToolResultAcks.delete(callId);
          return;
        }
        if (event.type === "conversation.item.created") {
          // Session resumption replays already-finalized conversation items without
          // another response.done; deliver that completed history at its replay boundary.
          this.emitCompletedToolCall(item, event);
        }
        return;
      }
      case "session.updated":
        this.onSessionUpdated(connection);
        return;
      case "response.output_audio.delta": {
        const audioDelta = event.delta ?? event.data;
        if (
          !audioDelta ||
          this.responseCancelInFlight ||
          audioGeneration !== this.outputAudioGeneration
        ) {
          return;
        }
        const canonicalAudio = canonicalizeBase64(audioDelta);
        if (!canonicalAudio) {
          throw new XaiRealtimeMalformedAudioError(
            `${this.config.providerLabel ?? "xAI realtime voice"} stream returned malformed base64 audio data`,
          );
        }
        const audio = Buffer.from(canonicalAudio, "base64");
        if (event.item_id && event.item_id !== this.assistantAudioItem?.itemId) {
          this.assistantAudioItem = {
            itemId: event.item_id,
            bytes: audio.byteLength,
            startTimestamp: this.latestMediaTimestamp,
          };
        } else if (this.assistantAudioItem) {
          this.assistantAudioItem.bytes += audio.byteLength;
        }
        this.responseActive = true;
        const markName = this.createPlaybackMark();
        this.config.onAudio(audio, event.item_id ? { itemId: event.item_id } : undefined);
        if (audioGeneration === this.outputAudioGeneration && this.acceptsEvent(connection)) {
          this.config.onMark?.(markName, () => {
            if (this.acceptsEvent(connection)) {
              this.acknowledgeMark(markName);
            }
          });
        }
        return;
      }
      case "input_audio_buffer.speech_started":
        this.flushPendingInputTranscript();
        this.inputSpeechSequence += 1;
        this.inputResponseStarted = false;
        this.openInputSpeechItemId = event.item_id ?? "";
        this.handleServerVadBargeIn();
        return;
      case "input_audio_buffer.speech_stopped":
      case "input_audio_buffer.committed":
        if (this.isInputSpeechOpen(event.item_id)) {
          this.openInputSpeechItemId = null;
          // Recognition may already be complete; settle it unless a later
          // snapshot or the response boundary arrives first.
          if (this.pendingInputTranscript) {
            this.armInputSettleTimer();
          }
        }
        return;
      case "response.text.delta":
      case "response.output_text.delta":
      case "response.output_audio_transcript.delta":
        if (event.delta) {
          this.appendAssistantTranscriptDelta(event.delta);
        }
        return;
      case "response.text.done":
      case "response.output_text.done":
      case "response.output_audio_transcript.done":
        if (this.isCurrentInputResponse(event)) {
          this.flushPendingInputTranscript();
          if (!this.acceptsEvent(connection)) {
            return;
          }
        }
        this.flushAssistantTranscript(event.transcript ?? event.text, event.item_id);
        return;
      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) {
          this.config.onTranscript?.("user", event.delta, false);
        }
        return;
      case "conversation.item.input_audio_transcription.updated":
        if (event.transcript) {
          const key = this.inputTranscriptKey(event);
          this.inputTranscriptReplacements.set(key, event.transcript);
          const pending = this.pendingInputTranscript;
          // Completed snapshots can land before the corrected utterance. Replace
          // the pending commit so speech_started does not lock in the short text.
          if (pending?.key === key && pending.text !== event.transcript) {
            this.pendingInputTranscript = { ...pending, text: event.transcript };
            this.config.onTranscript?.("user", event.transcript, false, {
              ...(pending.itemId ? { itemId: pending.itemId } : {}),
              textMode: "snapshot",
            });
          }
        }
        return;
      case "conversation.item.input_audio_transcription.completed": {
        const key = this.inputTranscriptKey(event);
        const transcript = event.transcript ?? this.inputTranscriptReplacements.get(key);
        this.inputTranscriptReplacements.delete(key);
        if (!transcript || this.finalizedInputTranscriptKeys.has(key)) {
          return;
        }
        if (this.pendingInputTranscript && this.pendingInputTranscript.key !== key) {
          this.flushPendingInputTranscript();
          if (!this.acceptsEvent(connection)) {
            return;
          }
        }
        this.pendingInputTranscript = {
          key,
          text: transcript,
          ...(event.item_id ? { itemId: event.item_id } : {}),
        };
        this.config.onTranscript?.("user", transcript, false, {
          ...(event.item_id ? { itemId: event.item_id } : {}),
          textMode: "snapshot",
        });
        // xAI's completed events are cumulative snapshots, not utterance
        // boundaries. Commit after a quiet period so a later correction can
        // replace the pending text, without waiting for a long spoken reply.
        // A response that finishes first flushes immediately and clears this.
        // While the speaker is still talking, the item's speech_stopped arms it.
        if (this.isInputSpeechOpen(event.item_id)) {
          clearTimeout(this.inputSettleTimer);
          this.inputSettleTimer = undefined;
        } else {
          this.armInputSettleTimer();
        }
        return;
      }
      case "conversation.item.input_audio_transcription.failed": {
        // One item's recognition failed; the model still heard the audio and the
        // stream is healthy. The bridge event above carries the reason to the
        // relay, which logs it, instead of failing the voice session.
        const key = this.inputTranscriptKey(event);
        if (this.pendingInputTranscript?.key === key) {
          this.pendingInputTranscript = undefined;
        }
        this.inputTranscriptReplacements.delete(key);
        return;
      }
      case "response.done": {
        // A trailing terminal from an interrupted response must not settle new speech.
        if (this.isCurrentInputResponse(event)) {
          this.flushPendingInputTranscript();
          if (!this.acceptsEvent(connection)) {
            return;
          }
        }
        const output = Array.isArray(event.response?.output)
          ? event.response.output.filter(isRecord)
          : [];
        const outcome = normalizeRealtimeVoiceResponseOutcome({
          providerLabel: this.config.providerLabel ?? "xAI realtime voice",
          response: event.response,
          responseId: event.response_id,
        });
        // Non-completed responses discard their output. Retire those marks without
        // claiming playback so they cannot block the next response indefinitely.
        if (outcome.status !== "completed") {
          this.markQueue = [];
          this.assistantAudioItem = null;
        }
        let callbackError: unknown;
        const invoke = (callback: () => void) => {
          try {
            callback();
          } catch (error) {
            callbackError ??= error;
          }
        };
        try {
          // Deliver output before completion retires its response owner. Tool callbacks
          // may close the connection, so remaining output must recheck that owner.
          invoke(() => {
            if (outcome.status === "completed") {
              for (const [itemId, toolCall] of this.toolCallBuffers) {
                if (!this.acceptsEvent(connection)) {
                  return;
                }
                this.emitToolCallOnce({
                  itemId,
                  callId: toolCall.callId,
                  name: toolCall.name,
                  rawArgs: toolCall.args,
                });
              }
              for (const item of output) {
                if (!this.acceptsEvent(connection)) {
                  return;
                }
                this.emitCompletedToolCall(item, event);
              }
            }
            if (!this.acceptsEvent(connection)) {
              return;
            }
            const assistantMessages = output.filter(
              (item) => item.type === "message" && item.role === "assistant",
            );
            const terminalTranscript = assistantMessages
              .flatMap((item) => (Array.isArray(item.content) ? item.content.filter(isRecord) : []))
              .map((content) =>
                typeof content.transcript === "string"
                  ? content.transcript
                  : typeof content.text === "string"
                    ? content.text
                    : "",
              )
              .join("");
            const terminalItem = assistantMessages.find(
              (item) => typeof item.id === "string" && item.id.length > 0,
            );
            const terminalItemId =
              typeof terminalItem?.id === "string" ? terminalItem.id : undefined;
            this.flushAssistantTranscript(terminalTranscript, terminalItemId);
          });
          if (this.outputResponse) {
            this.outputResponse.ended = true;
          }
          invoke(() => this.config.onResponseDone?.(outcome));
          invoke(emitBridgeEvent);
        } finally {
          // Keep the response active through terminal tool discovery: callbacks can
          // submit results synchronously and must not start the next response early.
          this.responseActive = false;
          this.responseCreateInFlight = false;
          this.responseCancelInFlight = false;
          this.toolCallBuffers.clear();
          this.finalizedToolCallItems.clear();
          this.flushPendingResponseCreate();
        }
        if (callbackError) {
          throw callbackError instanceof Error
            ? callbackError
            : new Error(
                `${this.config.providerLabel ?? "xAI realtime voice"} response callback failed`,
                {
                  cause: callbackError,
                },
              );
        }
        return;
      }
      case "response.function_call_arguments.delta": {
        const key = event.item_id ?? "unknown";
        const existing = this.toolCallBuffers.get(key);
        if (existing && event.delta) {
          existing.args += event.delta;
        } else if (event.item_id) {
          this.toolCallBuffers.set(event.item_id, {
            name: event.name ?? "",
            callId: event.call_id ?? "",
            args: event.delta ?? "",
          });
        }
        return;
      }
      case "response.function_call_arguments.done": {
        const key = event.item_id ?? "unknown";
        if (this.finalizedToolCallItems.has(key)) {
          return;
        }
        const buffered = this.toolCallBuffers.get(key);
        // Keep finalized arguments for diagnostics only. response.done with a completed
        // response is the authoritative execution boundary for provider tool calls.
        if (event.item_id) {
          this.finalizedToolCallItems.add(event.item_id);
          this.toolCallBuffers.set(event.item_id, {
            name: buffered?.name || event.name || "",
            callId: buffered?.callId || event.call_id || "",
            args: event.arguments ?? buffered?.args ?? "",
          });
        }
        return;
      }
      case "response.output_item.done":
        this.bufferCompletedToolCall(event.item, event);
        return;
      case "error":
        this.handleErrorEvent(event.error);
      default:
    }
  }

  protected resetInputTranscripts(): void {
    this.flushPendingInputTranscript();
    this.inputTranscriptReplacements.clear();
    this.finalizedInputTranscriptKeys.clear();
    this.openInputSpeechItemId = null;
    this.inputResponseStarted = false;
    this.outputResponse = undefined;
    this.finalizedToolCallItems.clear();
  }

  private isCurrentInputResponse(event: XaiRealtimeEvent): boolean {
    const responseId = event.response_id ?? event.response?.id;
    return (
      this.inputResponseStarted &&
      (!responseId || !this.outputResponse?.id || responseId === this.outputResponse.id)
    );
  }

  private isInputSpeechOpen(itemId: string | undefined): boolean {
    const open = this.openInputSpeechItemId;
    return open !== null && (open === "" || !itemId || open === itemId);
  }

  private armInputSettleTimer(): void {
    clearTimeout(this.inputSettleTimer);
    this.inputSettleTimer = setTimeout(() => {
      this.inputSettleTimer = undefined;
      this.flushPendingInputTranscript();
    }, XAI_REALTIME_INPUT_SETTLE_MS);
    this.inputSettleTimer.unref?.();
  }

  private flushPendingInputTranscript(): void {
    clearTimeout(this.inputSettleTimer);
    this.inputSettleTimer = undefined;
    const pending = this.pendingInputTranscript;
    this.pendingInputTranscript = undefined;
    if (!pending) {
      return;
    }
    const replacement = this.inputTranscriptReplacements.get(pending.key);
    this.inputTranscriptReplacements.delete(pending.key);
    const text = replacement ?? pending.text;
    this.finalizedInputTranscriptKeys.add(pending.key);
    if (this.finalizedInputTranscriptKeys.size > 1_024) {
      const oldest = this.finalizedInputTranscriptKeys.values().next().value;
      if (oldest !== undefined) {
        this.finalizedInputTranscriptKeys.delete(oldest);
      }
    }
    this.config.onTranscript?.("user", text, true, {
      ...(pending.itemId ? { itemId: pending.itemId } : {}),
      textMode: "snapshot",
    });
  }

  private emitCompletedToolCall(item: XaiRealtimeEvent["item"], event: XaiRealtimeEvent): void {
    if (item?.type === "function_call" && (!item.status || item.status === "completed")) {
      // Completed items and resumed replay are authoritative; added items can
      // still be in progress and must not dispatch incomplete arguments.
      this.emitToolCallOnce({
        itemId: item.id ?? event.item_id,
        callId: item.call_id,
        name: item.name,
        rawArgs: item.arguments,
      });
    }
  }

  private bufferCompletedToolCall(item: XaiRealtimeEvent["item"], event: XaiRealtimeEvent): void {
    if (item?.type !== "function_call" || (item.status && item.status !== "completed")) {
      return;
    }
    const itemId = item.id ?? event.item_id;
    if (!itemId) {
      return;
    }
    this.toolCallBuffers.set(itemId, {
      name: item.name ?? "",
      callId: item.call_id ?? "",
      args: item.arguments ?? "",
    });
  }

  private appendAssistantTranscriptDelta(delta: string): void {
    if (this.assistantTranscriptFinalized) {
      this.assistantTranscriptBuffer = "";
      this.assistantTranscriptFinalized = false;
    }
    this.assistantTranscriptBuffer += delta;
    this.config.onTranscript?.("assistant", delta, false);
  }

  private flushAssistantTranscript(finalTranscript?: string, itemId?: string): void {
    if (this.assistantTranscriptFinalized) {
      return;
    }
    const transcript = finalTranscript || this.assistantTranscriptBuffer;
    if (transcript) {
      this.config.onTranscript?.(
        "assistant",
        transcript,
        true,
        ...(itemId ? [{ itemId, textMode: "snapshot" as const }] : []),
      );
      this.assistantTranscriptFinalized = true;
    }
    this.assistantTranscriptBuffer = "";
  }

  private resetAssistantTranscript(): void {
    this.assistantTranscriptBuffer = "";
    this.assistantTranscriptFinalized = false;
  }

  private inputTranscriptKey(event: XaiRealtimeEvent): string {
    return event.item_id ?? event.response_id ?? `speech-${this.inputSpeechSequence}`;
  }

  private handleErrorEvent(error: unknown): void {
    const detail = readXaiRealtimeErrorDetail(
      error,
      this.config.providerLabel ?? "xAI realtime voice",
    );
    if (detail.startsWith(XAI_REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX)) {
      this.responseActive = true;
      this.responseCreateInFlight = false;
      this.responseCreatePending = true;
      return;
    }
    if (detail === XAI_REALTIME_NO_ACTIVE_RESPONSE_CANCEL_ERROR) {
      // A late error for an older response.cancel must not retire a successor
      // response or flush another response.create. The successor's
      // response.created clears this flag; only an in-flight cancellation may
      // settle the cancellation error.
      if (!this.responseCancelInFlight) {
        return;
      }
      this.responseActive = false;
      this.responseCancelInFlight = false;
      this.flushPendingResponseCreate();
      return;
    }
    this.config.onError?.(new Error(detail));
  }

  private describeServerEvent(event: XaiRealtimeEvent): string | undefined {
    if (
      event.type === "error" ||
      event.type === "conversation.item.input_audio_transcription.failed"
    ) {
      return readXaiRealtimeErrorDetail(
        event.error,
        this.config.providerLabel ?? "xAI realtime voice",
      );
    }
    if (event.type !== "response.done") {
      return undefined;
    }
    const status = event.response?.status;
    const details =
      event.response?.status_details === undefined
        ? undefined
        : JSON.stringify(event.response.status_details);
    return (
      [status ? `status=${status}` : undefined, details].filter(Boolean).join(" ") || undefined
    );
  }
}
