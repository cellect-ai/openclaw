import { randomUUID } from "node:crypto";
import { retainGatewayRootWorkAdmissionContinuationScope } from "../../../process/gateway-work-admission.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../../../talk/agent-consult-tool.js";
import { buildRealtimeVoiceAgentCancelProviderResult } from "../../../talk/agent-run-control-shared.js";
import {
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceAudioClearReason,
  type RealtimeVoiceCloseReason,
} from "../../../talk/provider-types.js";
import { resolveRealtimeVoiceInterruptResponseOnInputAudio } from "../../../talk/realtime-session-policy.js";
import type { TalkEventInput } from "../../../talk/talk-session-controller.js";
import {
  VOICE_TRANSCRIPT_QUEUE_POLICY,
  isNoiseOnlyVoiceTranscript,
  voiceTranscriptEventId,
} from "../../../talk/voice-transcript.js";
import {
  assertTalkRelaySessionCapacity,
  closeExpiredTalkRelaySessions,
} from "../relay-session-lifecycle.js";
import { markTalkVoiceSessionReady } from "../voice-selection.js";
import {
  buildAlreadyDeliveredToolResult,
  isRealtimeCheckingBackchannel,
  scheduleForcedAgentConsult,
  submitRealtimeAgentConsultWorkingResponse,
} from "./forced-consults.js";
import { resolveTalkRealtimeRelayPresentation } from "./issues.js";
import {
  adoptTalkRealtimeRelaySession,
  cancelTalkRealtimeRelayProviderToolCall,
  cancelTalkRealtimeRelayTurn,
  closeRelaySession,
} from "./operations.js";
import { submitFinalProviderToolResult, suppressedToolResultOptions } from "./provider-results.js";
import { createRelaySessionConsult, createRelaySessionHarness } from "./session-consult.js";
import {
  RELAY_SESSION_TTL_MS,
  TalkRealtimeRelayOutputOwnership,
  adoptRelayProviderToolCallId,
  broadcastToOwner,
  drainingRelaySessions,
  ensureRelayTurn,
  relaySessions,
  resetTalkRealtimeRelayContinuity,
  type CreateTalkRealtimeRelaySessionParams,
  type RelaySession,
  type TalkRealtimeRelaySessionResult,
} from "./state.js";
import {
  MAX_RELAY_TOOL_CALL_IDENTITIES,
  MAX_RELAY_TOOL_CALL_IDENTITY_BYTES,
  RelayToolCallLedger,
} from "./tool-call-ledger.js";
import { enqueueRelayVoiceTranscript } from "./voice.js";

// The relay contract is 20 ms of 24 kHz mono PCM16 per browser event.
const RELAY_OUTPUT_AUDIO_FRAME_BYTES = 960;
// A provider-cancelled call accepts no tool result, so this is the model's only signal
// that the work it announced stopped. Cancellation aborts only the remaining steps, so
// earlier effects may have landed and the outcome stays unknown.
const PROVIDER_CANCELLED_CONSULT_PROMPT = [
  "The earlier OpenClaw request was interrupted before it reported back, so its outcome is unknown; some steps may already have happened.",
  "Do not say it finished or that nothing happened. Check what was done before running it again.",
].join(" ");

/** Creates a realtime voice relay session and returns the browser audio contract. */
export function createTalkRealtimeRelaySession(
  params: CreateTalkRealtimeRelaySessionParams,
): TalkRealtimeRelaySessionResult {
  closeExpiredTalkRelaySessions({
    sessions: relaySessions.values(),
    closeSession: (session) => void closeRelaySession(session, "completed"),
  });
  assertTalkRelaySessionCapacity(
    [...relaySessions.values(), ...drainingRelaySessions],
    params.connId,
    "realtime relay",
  );
  const { publicModel, publicError, voice, ...voiceSelection } =
    resolveTalkRealtimeRelayPresentation(params);
  const relaySessionId = randomUUID();
  const expiresAtMs = Date.now() + RELAY_SESSION_TTL_MS;
  const harness = createRelaySessionHarness(params, relaySessionId);
  const eventOwner = {
    id: relaySessionId,
    context: params.context,
    connId: params.connId,
    harness,
  };
  const emit = (event: Parameters<typeof broadcastToOwner>[1], talkEvent?: TalkEventInput) =>
    broadcastToOwner(eventOwner, event, talkEvent);
  const realtimeRelayIssue = (message: string, phase: string) => ({
    code: "realtime_unavailable" as const,
    message,
    provider: params.provider.id,
    ...(publicModel ? { model: publicModel } : {}),
    transport: "gateway-relay" as const,
    phase,
  });
  const emitError = (issue: { message: string }) =>
    emit({ type: "error", ...issue }, { type: "session.error", payload: issue, final: true });
  let currentOutputItemId: string | undefined;
  let playbackTurnId: string | undefined;
  const pendingTranscriptQuestions = new Map<string, string>();
  let ready = false;
  let continuityResetActive = false;
  let failureEmitted = false;
  let sessionFailureRequested = false;
  const constructionTerminal: {
    current?: { kind: "error"; error: Error } | { kind: "close"; reason: RealtimeVoiceCloseReason };
  } = {};
  const relayRef: { current?: RelaySession } = {};
  const getActiveRelay = (): RelaySession | undefined => {
    const relay = relayRef.current;
    return relay && relaySessions.get(relay.id) === relay ? relay : undefined;
  };
  const clearPlayback = (reason?: RealtimeVoiceAudioClearReason) => {
    // Released clients match clear to the audio sent, which can outlive response completion
    // and remain queued after a newer response starts without sending audio.
    const turnId = playbackTurnId;
    playbackTurnId = undefined;
    emit(
      { type: "clear", ...(reason ? { reason } : {}) },
      turnId
        ? { type: "output.audio.done", turnId, payload: { reason: reason ?? "clear" }, final: true }
        : undefined,
    );
  };
  const bridgeRef: { current?: ReturnType<typeof harness.createBridge> } = {};
  const outputOwnership = new TalkRealtimeRelayOutputOwnership(
    () => harness.talk.activeTurnId,
    () => harness.ensureTurn(),
    (message, diagnostics) => {
      const relay = getActiveRelay();
      if (diagnostics) {
        const providerModel =
          typeof params.providerConfig.model === "string"
            ? params.providerConfig.model
            : params.model;
        // Diagnostics must never break the failure path itself.
        params.context.logGateway?.warn(
          `talk relay provider event ownership failure: provider=${params.provider.id}${
            providerModel ? ` model=${providerModel}` : ""
          } diagnostics=${JSON.stringify(diagnostics)}`,
        );
      }
      relay?.failSession(message);
      if (!relay) {
        constructionTerminal.current ??= { kind: "error", error: new Error(message) };
      }
    },
    () => bridgeRef.current?.bridge.outputAudioMode === "continuous",
  );
  const relayAgentId = params.sessionTarget.agentId;
  const { consultRunner, runAgentConsult, runControl, transcriptReadiness } =
    createRelaySessionConsult({
      params,
      relaySessionId,
      harness,
      pendingTranscriptQuestions,
      getActiveRelay,
      bridgeRef,
    });
  const bridgeRequest: Parameters<typeof harness.createBridge>[0] = {
    provider: outputOwnership.bind(params.provider, runAgentConsult),
    capabilities: params.capabilities,
    cfg: params.cfg,
    agentId: relayAgentId,
    providerConfig: params.providerConfig,
    audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
    instructions: params.instructions,
    language: params.language,
    transcriptionHints: params.transcriptionHints,
    autoRespondToAudio: params.forceAgentConsultOnFinalTranscript !== true,
    // Forced consults suppress automatic audio turns, but barge-in stays provider-owned:
    // consult replies are long, so interruption matters more here, not less.
    interruptResponseOnInputAudio: resolveRealtimeVoiceInterruptResponseOnInputAudio(
      params.providerConfig.interruptResponseOnInputAudio,
    ),
    tools: params.tools,
    ...(runControl.handleDelegationInput
      ? {
          handleDelegationInput: (text, respond) => {
            const relay = getActiveRelay();
            if (!relay) {
              return "control";
            }
            return runControl.handleDelegationInput!(text, (message) => {
              if (getActiveRelay() === relay) {
                respond(message);
              }
            });
          },
        }
      : {}),
    markStrategy: "transport",
    audioSink: {
      isOpen: () => Boolean(getActiveRelay()),
      sendAudio: (audio) => {
        if (!getActiveRelay() || outputOwnership.suppressingOutput) {
          return;
        }
        const outputTurnId = outputOwnership.resolve(true, "audio");
        if (!outputTurnId) {
          return;
        }
        for (let offset = 0; offset < audio.byteLength; offset += RELAY_OUTPUT_AUDIO_FRAME_BYTES) {
          const frame = audio.subarray(
            offset,
            Math.min(offset + RELAY_OUTPUT_AUDIO_FRAME_BYTES, audio.byteLength),
          );
          playbackTurnId = outputTurnId;
          emit(
            {
              type: "audio",
              audioBase64: frame.toString("base64"),
              ...(currentOutputItemId ? { itemId: currentOutputItemId } : {}),
              ...(outputOwnership.responseId ? { responseId: outputOwnership.responseId } : {}),
            },
            {
              type: "output.audio.delta",
              turnId: outputTurnId,
              payload: { byteLength: frame.byteLength },
            },
          );
        }
      },
      clearAudio: clearPlayback,
      sendMark: (markName, acknowledge) => {
        const relay = getActiveRelay();
        if (!relay) {
          return;
        }
        const outputTurnId = outputOwnership.resolve(false, "mark");
        if (!outputTurnId) {
          if (outputOwnership.phase !== "owned") {
            bridgeRef.current?.acknowledgeMark(markName);
          }
          return;
        }
        // A playback checkpoint is not the end of the provider's response.
        emit({ type: "mark", markName });
        acknowledge?.();
      },
    },
    onEvent: (event) => {
      const relay = getActiveRelay();
      if (!relay) {
        return;
      }
      if (event.direction === "client" && event.type === "session.continuity.reset") {
        if (continuityResetActive) {
          return;
        }
        continuityResetActive = true;
        ready = false;
        currentOutputItemId = undefined;
        outputOwnership.resetContinuity();
        const activeTurnId = relay.harness.talk.activeTurnId;
        // Queued audio A and active turn B need distinct clears. Emit A before cancelling B
        // so the Talk event sequence and client cancellation fence retain their ordering.
        if (!activeTurnId || (playbackTurnId && playbackTurnId !== activeTurnId)) {
          clearPlayback();
        }
        const talkEvent = resetTalkRealtimeRelayContinuity(relay, event.type);
        if (!getActiveRelay()) {
          return;
        }
        playbackTurnId = undefined;
        if (talkEvent) {
          emit({
            type: "clear",
            talkEvent,
          });
        }
        return;
      }
      if (event.direction !== "server") {
        return;
      }
      if (event.type === "conversation.item.input_audio_transcription.failed") {
        // One utterance lost its caption and saved transcript; the provider still
        // heard it. Record the reason instead of failing the voice session.
        params.context.logGateway?.info(
          `talk relay input transcription failed: provider=${params.provider.id} item=${
            event.itemId ?? "unknown"
          } reason=${event.detail ?? "unspecified"}`,
        );
        return;
      }
      if (event.type === "response.created") {
        if (outputOwnership.takeSuperseded()) {
          currentOutputItemId = undefined;
          clearPlayback("barge-in");
        }
        // Response admission owns work status; asynchronous input transcripts do not.
        const turnId = outputOwnership.resolve(false, "response-created");
        if (turnId) {
          emit({ type: "responseStarted", turnId });
        }
        return;
      }
      if (event.type === "session.created") {
        continuityResetActive = false;
      }
      if (event.type === "input_audio_buffer.speech_started") {
        const activeTurnId = relay.harness.talk.activeTurnId;
        if (activeTurnId && outputOwnership.phase === "owned") {
          const providerOwnsBargeIn =
            relay.capabilities?.handlesInputAudioBargeIn === true &&
            params.forceAgentConsultOnFinalTranscript !== true;
          void cancelTalkRealtimeRelayTurn({
            relaySessionId,
            connId: params.connId,
            reason: "barge-in",
            turnId: activeTurnId,
            ...(providerOwnsBargeIn ? { providerOwnsBargeIn: true } : {}),
          }).catch(() => {
            getActiveRelay()?.failSession("Realtime provider cancellation failed. Reconnecting.");
          });
        }
        if (event.itemId) {
          broadcastToOwner(relay, {
            type: "inputAudioStart",
            itemId: event.itemId,
          });
        }
      }
      if (
        (event.type === "response.done" || event.type === "response.cancelled") &&
        outputOwnership.finish(event.responseId, true) === "cancelled"
      ) {
        currentOutputItemId = undefined;
        return;
      }
      if (event.type === "tool.call.cancelled" && event.itemId) {
        const relayCallId = cancelTalkRealtimeRelayProviderToolCall(relay, event.itemId);
        if (relayCallId) {
          emit({
            type: "toolCallCancelled",
            callId: relayCallId,
          });
          bridgeRef.current?.sendUserMessage?.(PROVIDER_CANCELLED_CONSULT_PROMPT);
        }
        return;
      }
      if (
        event.type === "conversation.output_audio.delta" ||
        event.type === "response.audio.delta" ||
        event.type === "response.output_audio.delta"
      ) {
        currentOutputItemId = event.itemId ?? currentOutputItemId;
        outputOwnership.responseId = event.responseId ?? outputOwnership.responseId;
      }
    },
    onResponseDone: (outcome) => {
      if (!getActiveRelay()) {
        return;
      }
      const responseId = outcome.responseId ?? outputOwnership.responseId;
      const disposition = outputOwnership.finish(responseId, false, outcome.status === "completed");
      if (disposition === "ignore") {
        return;
      }
      if (disposition === "cancelled") {
        currentOutputItemId = undefined;
        return;
      }
      const terminalTalkEvent = harness.talk.recentEvents.at(-1);
      emit({
        type: "audioDone",
        ...(currentOutputItemId ? { itemId: currentOutputItemId } : {}),
        ...(responseId ? { responseId } : {}),
        ...(terminalTalkEvent &&
        (terminalTalkEvent.type === "turn.ended" || terminalTalkEvent.type === "turn.cancelled")
          ? { talkEvent: terminalTalkEvent }
          : {}),
      });
      currentOutputItemId = undefined;
      if (outcome.status === "failed" || outcome.status === "incomplete") {
        const issue = realtimeRelayIssue(publicError(outcome.error ?? outcome).message, "response");
        const errorTalkEvent = harness.talk.recentEvents.findLast(
          (event) => event.type === "session.error" && event.payload === outcome,
        );
        emit({
          type: "error",
          ...issue,
          ...(errorTalkEvent ? { talkEvent: { ...errorTalkEvent, payload: issue } } : {}),
        });
      }
    },
    onTranscript: (role, text, final, update) => {
      const relay = getActiveRelay() ?? (relayRef.current?.closing ? relayRef.current : undefined);
      if (!relay || relay.voiceSessionClose) {
        return;
      }
      if (role === "user" && isNoiseOnlyVoiceTranscript(text)) {
        if (final && !relay.closing) {
          transcriptReadiness.observeUserTranscript("", true);
        }
        return;
      }
      if (role === "assistant" && outputOwnership.suppressingOutput) {
        return;
      }
      if (!relay.closing && role === "user" && text.trim()) {
        // A new utterance supersedes any backchannel recovery candidate from
        // the previous turn. Some providers emit only a final transcript, so
        // clear stale recovery state on either transcript shape. This also
        // cancels a scheduled consult that has not yet been admitted.
        pendingTranscriptQuestions.clear();
        relay.harness.forcedConsults.clearPending();
      }
      if (!relay.closing && role === "user" && !final) {
        transcriptReadiness.observeUserTranscript(text, false);
      }
      const previousTranscriptSeq = relay.voiceTranscriptSeq;
      const enqueueTranscript = () => enqueueRelayVoiceTranscript(relay, role, text, update);
      if (
        final &&
        !(relay.closing?.runTranscript
          ? relay.closing.runTranscript(enqueueTranscript)
          : enqueueTranscript())
      ) {
        return;
      }
      const transcriptIdentity =
        relay.voiceTranscriptSeq > previousTranscriptSeq
          ? {
              transcriptId: voiceTranscriptEventId(relay.id, String(relay.voiceTranscriptSeq)),
            }
          : {};
      const transcriptEvent = {
        type: "transcript" as const,
        role,
        text,
        final,
        ...update,
        ...transcriptIdentity,
      };
      if (relay.closing) {
        emit(transcriptEvent);
        return;
      }
      const outputTurnId =
        role === "assistant" ? outputOwnership.resolve(true, "assistant-transcript") : undefined;
      if (role === "assistant" && !outputTurnId) {
        return;
      }
      const turnId = outputTurnId ?? ensureRelayTurn(relay);
      const eventType =
        role === "assistant"
          ? final
            ? "output.text.done"
            : "output.text.delta"
          : final
            ? "transcript.done"
            : "transcript.delta";
      const payload = role === "assistant" ? { text } : { role, text };
      emit(transcriptEvent, { type: eventType, turnId, payload, final });
      if (role === "user" && final && text.trim()) {
        const question = text.trim();
        if (relay.harness.isLikelyAssistantEchoTranscript(question)) {
          return;
        }
        if (runControl.handleSpoken(question)) {
          return;
        }
        if (params.forceAgentConsultOnFinalTranscript === true) {
          scheduleForcedAgentConsult(relay, question);
        } else {
          pendingTranscriptQuestions.set(turnId, question);
          while (pendingTranscriptQuestions.size > 12) {
            const oldestTurnId = pendingTranscriptQuestions.keys().next().value;
            if (oldestTurnId === undefined) {
              break;
            }
            pendingTranscriptQuestions.delete(oldestTurnId);
          }
        }
      }
      if (
        role === "assistant" &&
        final &&
        outputTurnId !== undefined &&
        params.forceAgentConsultOnFinalTranscript !== true &&
        isRealtimeCheckingBackchannel(text)
      ) {
        const question = pendingTranscriptQuestions.get(outputTurnId);
        pendingTranscriptQuestions.delete(outputTurnId);
        if (question && !relay.harness.forcedConsults.findRecent(question)) {
          scheduleForcedAgentConsult(relay, question, "checking-backchannel");
        }
      } else if (role === "assistant" && final && outputTurnId) {
        // A complete provider answer is terminal for its transcript turn; do not
        // let a later response reuse stale user text as the subject of a check.
        pendingTranscriptQuestions.delete(outputTurnId);
      }
    },
    onToolCall: (toolCall) => {
      const relay = getActiveRelay();
      if (!relay || outputOwnership.suppressingOutput) {
        return;
      }
      const outputTurnId = outputOwnership.resolveToolCall();
      if (!outputTurnId) {
        return;
      }
      const providerCallId = toolCall.callId;
      const relayCallId = adoptRelayProviderToolCallId(relay, providerCallId);
      if (!relayCallId) {
        return;
      }
      let shouldSubmitWorkingResult = false;
      if (toolCall.name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
        pendingTranscriptQuestions.delete(outputTurnId);
        const forcedConsult = relay.harness.forcedConsults.recordNativeConsult(
          toolCall.args,
          providerCallId,
        );
        if (forcedConsult.kind === "in_flight" || forcedConsult.kind === "already_delivered") {
          if (forcedConsult.kind === "already_delivered") {
            const result = relay.harness.forcedConsults.isCancelled(forcedConsult.handle)
              ? buildRealtimeVoiceAgentCancelProviderResult(
                  "OpenClaw cancelled this consult before completion. Do not restart it.",
                )
              : buildAlreadyDeliveredToolResult();
            return submitFinalProviderToolResult({
              session: relay,
              callId: providerCallId,
              result,
              options: suppressedToolResultOptions(relay),
            });
          }
          if (relay.forcedTerminalProviderResults.has(forcedConsult.handle.id)) {
            return relay.pendingFinalToolResults.get(forcedConsult.handle.id);
          }
          return submitRealtimeAgentConsultWorkingResponse(relay, relayCallId);
        }
        shouldSubmitWorkingResult = true;
      }
      emit(
        {
          type: "toolCall",
          itemId: toolCall.itemId,
          callId: relayCallId,
          name: toolCall.name,
          args: toolCall.args,
        },
        {
          type: "tool.call",
          itemId: toolCall.itemId,
          callId: relayCallId,
          turnId: outputTurnId,
          payload: { name: toolCall.name, args: toolCall.args },
        },
      );
      if (shouldSubmitWorkingResult) {
        return submitRealtimeAgentConsultWorkingResponse(relay, relayCallId, outputTurnId);
      }
    },
    onReady: () => {
      if (!getActiveRelay()) {
        return;
      }
      ready = true;
      markTalkVoiceSessionReady(relaySessionId, params.connId, relayAgentId);
      continuityResetActive = false;
      emit({ type: "ready" }, { type: "session.ready", payload: null });
    },
    onError: (error) => {
      const active = getActiveRelay();
      if (!active) {
        if (!relayRef.current) {
          constructionTerminal.current ??= { kind: "error", error };
        }
        return;
      }
      const issue = realtimeRelayIssue(publicError(error).message, ready ? "stream" : "connect");
      failureEmitted = true;
      emitError(issue);
    },
    onClose: (reason) => {
      void runControl.close();
      const active = getActiveRelay() ?? relayRef.current;
      if (!active) {
        constructionTerminal.current ??= { kind: "close", reason };
        return;
      }
      if (!active.closing && !ready && !failureEmitted) {
        const issue = realtimeRelayIssue(
          "Realtime provider closed before the session became ready.",
          "connect",
        );
        emitError(issue);
      }
      void closeRelaySession(active, reason);
    },
  };
  let bridge: ReturnType<typeof harness.createBridge>;
  try {
    bridge = harness.createBridge(bridgeRequest);
  } catch (error) {
    transcriptReadiness.close();
    throw publicError(error);
  }
  bridgeRef.current = bridge;
  const earlyTerminal = constructionTerminal.current;
  if (earlyTerminal) {
    transcriptReadiness.close();
    harness.close();
    const reportCloseFailure = () =>
      params.context.logGateway.warn(
        "failed to close realtime relay bridge after provider terminated during creation: Realtime provider error.",
      );
    try {
      void Promise.resolve(bridge.close()).catch(reportCloseFailure);
    } catch {
      reportCloseFailure();
    }
    if (earlyTerminal.kind === "error") {
      throw publicError(earlyTerminal.error);
    }
    throw new Error(`Realtime provider closed during session creation: ${earlyTerminal.reason}`);
  }
  const failSession = (message: string) => {
    const active = relaySessions.get(relaySessionId);
    if (!active || sessionFailureRequested) {
      return;
    }
    sessionFailureRequested = true;
    if (!failureEmitted) {
      failureEmitted = true;
      emitError({ message });
    }
    void closeRelaySession(active, "error");
  };
  const relay: RelaySession = {
    cleanupAdmission: retainGatewayRootWorkAdmissionContinuationScope() ?? undefined,
    getToolAuthorityOverlay: consultRunner.getToolAuthorityOverlay,
    id: relaySessionId,
    connId: params.connId,
    context: params.context,
    bridge,
    harness,
    capabilities: params.capabilities,
    outputOwnership,
    sessionTarget: params.sessionTarget,
    ...(params.speakerMxid ? { speakerMxid: params.speakerMxid } : {}),
    ...(params.matrixRoute ? { matrixRoute: params.matrixRoute } : {}),
    expiresAtMs,
    cleanupTimer: setTimeout(() => {
      const active = relaySessions.get(relaySessionId);
      if (active) {
        void closeRelaySession(active, "completed");
      }
    }, RELAY_SESSION_TTL_MS),
    activeAgentRuns: new Map(),
    provider: params.provider.id,
    activeAgentToolCalls: new Map(),
    toolCalls: new RelayToolCallLedger({
      onOverflow: () =>
        failSession(
          `Realtime relay tool-call session limit exceeded (${MAX_RELAY_TOOL_CALL_IDENTITIES} identities or ${MAX_RELAY_TOOL_CALL_IDENTITY_BYTES} UTF-8 bytes)`,
        ),
    }),
    providerToolCallIds: new Map(),
    relayToolCallIdsByProviderId: new Map(),
    pendingFinalToolResults: new Map(),
    pendingProviderToolResults: new Map(),
    pendingWorkingToolResults: new Map(),
    forcedTerminalProviderResults: new Map(),
    toolResultEpoch: 0,
    ...(params.cfg ? { voiceConfig: params.cfg } : {}),
    voiceSessionCreated: false,
    voiceTranscriptSeq: 0,
    voiceTranscriptQueue: VOICE_TRANSCRIPT_QUEUE_POLICY.createQueue(),
    transcriptReadiness,
    runAuthority: params.runAuthority,
    failSession,
  };
  relayRef.current = relay;
  adoptTalkRealtimeRelaySession(relay, {
    ...voiceSelection,
    voiceChangeId: params.voiceChangeId,
    providerReady: ready,
  });
  bridge.connect().catch((error: unknown) => {
    const active = relaySessions.get(relaySessionId);
    if (active !== relay) {
      return;
    }
    const issue = realtimeRelayIssue(publicError(error).message, "connect");
    failureEmitted = true;
    emitError(issue);
    void closeRelaySession(active, "error");
  });

  return {
    provider: params.provider.id,
    transport: "gateway-relay",
    relaySessionId,
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz,
      outputEncoding: "pcm16",
      outputSampleRateHz: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz,
    },
    ...(publicModel ? { model: publicModel } : {}),
    ...(voice ? { voice } : {}),
    expiresAt: Math.floor(expiresAtMs / 1000),
  };
}
