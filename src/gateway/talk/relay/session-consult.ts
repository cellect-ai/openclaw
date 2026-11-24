import { createClientVoiceTranscriptReadiness } from "../../../talk/client-voice-transcript-readiness.js";
import type { RealtimeVoiceSessionHarness } from "../../../talk/realtime-session-harness.js";
import { createRealtimeVoiceSessionHarness } from "../../../talk/realtime-session-harness.js";
import { createTalkClientAgentConsultRunner } from "../client-agent-consult.js";
import { createTalkRealtimeRunControlOwner } from "../realtime-run-control.js";
import { bindTalkRealtimeRelayAgentConsult } from "./agent-consult.js";
import {
  prepareTalkRealtimeRelayAgentControl,
  registerTalkRealtimeRelayAgentRun,
} from "./operations.js";
import {
  pruneInactiveRelayAgentRuns,
  RELAY_TRANSCRIPT_ECHO_LOOKBACK_MS,
  type CreateTalkRealtimeRelaySessionParams,
  type RelaySession,
} from "./state.js";
export function createRelaySessionHarness(
  params: CreateTalkRealtimeRelaySessionParams,
  relaySessionId: string,
) {
  const harness = createRealtimeVoiceSessionHarness({
    talk: {
      sessionId: relaySessionId,
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: params.provider.id,
      // Keep the pre-harness steering window; other harness consumers use the shared default.
      maxRecentEvents: 20,
    },
    talkPayloads: {
      turnStarted: () => ({}),
      turnEnded: (reason) => ({ reason }),
      inputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
      outputAudioStarted: () => ({}),
      outputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
      outputAudioDone: (reason) => ({ reason }),
    },
    transcriptLookbackMs: RELAY_TRANSCRIPT_ECHO_LOOKBACK_MS,
    captureBridgeEvents: false,
  });

  return harness;
}
export function createRelaySessionConsult({
  params,
  relaySessionId,
  harness,
  pendingTranscriptQuestions,
  getActiveRelay,
  bridgeRef,
}: {
  params: CreateTalkRealtimeRelaySessionParams;
  relaySessionId: string;
  harness: RealtimeVoiceSessionHarness;
  pendingTranscriptQuestions: Map<string, string>;
  getActiveRelay: () => RelaySession | undefined;
  bridgeRef: { current?: ReturnType<RealtimeVoiceSessionHarness["createBridge"]> };
}) {
  const { canonicalKey } = params.sessionTarget;
  const transcriptReadiness = createClientVoiceTranscriptReadiness({
    agentId: params.sessionTarget.agentId,
    voiceSessionId: relaySessionId,
    flushTranscript: async () => {
      await getActiveRelay()?.voiceTranscriptQueue.flush();
    },
  });
  const consultRunner = createTalkClientAgentConsultRunner({
    config: params.cfg ?? params.context.getRuntimeConfig(),
    context: params.context,
    sessionTarget: params.sessionTarget,
    ownerConnId: params.connId,
    // Only the app-attested binding identifies a Matrix speaker. The hosting
    // Gateway connection is an operator, not the human making this request.
    authority:
      params.matrixRoute && params.speakerMxid
        ? {
            ...params.consultAuthority,
            senderIsOwner: false,
            replyCaller: undefined,
            operatorAuthority: undefined,
            senderId: params.speakerMxid,
            trigger: "user",
            deliveryContext: {
              channel: params.matrixRoute.channel,
              accountId: params.matrixRoute.accountId,
              to: `room:${params.matrixRoute.roomId}`,
              threadId: params.matrixRoute.threadRootEventId,
            },
            channelContext: {
              sender: { id: params.speakerMxid },
              chat: {
                id: params.matrixRoute.roomId,
                talkThreadRootEventId: params.matrixRoute.threadRootEventId,
              },
            },
          }
        : params.consultAuthority,
    runAuthority: params.runAuthority,
    getVoiceSessionId: () => relaySessionId,
    initialItems: params.initialItems ?? [],
    sessionCapsule: params.sessionCapsule,
    runIdPrefix: "talk-realtime-relay-consult",
    surface: "a gateway-relay Talk session",
    registerRun: async ({ runId, assertCurrent }) => {
      if (!getActiveRelay()) {
        throw new Error("Realtime gateway-relay session is closed");
      }
      const registration = await registerTalkRealtimeRelayAgentRun({
        relaySessionId,
        connId: params.connId,
        sessionKey: canonicalKey,
        runId,
        assertCurrent,
      });
      if (!getActiveRelay() || !registration.isCurrent()) {
        registration.release();
        throw new Error("Realtime gateway-relay session is closed");
      }
      return registration;
    },
  });
  const runAgentConsult = bindTalkRealtimeRelayAgentConsult(
    Object.assign((request: Parameters<typeof consultRunner.runPrompt>[0]) => {
      // Provider-owned delegation bypasses onToolCall. Once admitted, it owns
      // this utterance even when its prompt differs from the ASR transcript.
      pendingTranscriptQuestions.clear();
      harness.forcedConsults.clearPending();
      return consultRunner.runPrompt(request);
    }, consultRunner.runPrompt),
    () => getActiveRelay() !== undefined,
    (signal) => transcriptReadiness.wait(signal),
  );
  const runControl = createTalkRealtimeRunControlOwner({
    controlSource: params.controlSource,
    supportsToolCalls: params.capabilities?.supportsToolCalls,
    hasActiveRun: () => {
      const relay = getActiveRelay();
      return Boolean(relay && pruneInactiveRelayAgentRuns(relay) > 0);
    },
    prepare: (args) => {
      const relay = getActiveRelay();
      if (!relay || !args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error("Realtime relay control session is closed");
      }
      const text = (args as { text?: unknown }).text;
      if (typeof text !== "string") {
        throw new Error("Realtime relay control text is required");
      }
      return prepareTalkRealtimeRelayAgentControl({
        relaySessionId,
        connId: params.connId,
        text,
      });
    },
    speak: (message) => {
      if (getActiveRelay()) {
        bridgeRef.current?.sendUserMessage?.(message);
      }
    },
    warn: (message) => {
      if (getActiveRelay()) {
        params.context.logGateway.warn(message);
      }
    },
  });

  return { consultRunner, runAgentConsult, runControl, transcriptReadiness };
}
