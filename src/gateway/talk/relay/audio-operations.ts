import { decodeTalkRelayAudioBase64 } from "../relay-audio-base64.js";
import { requireActiveTalkRelaySession } from "../relay-session-lifecycle.js";
import { closeRelaySession } from "./session-lifecycle.js";
import {
  MAX_AUDIO_BASE64_BYTES,
  broadcastToOwner,
  ensureRelayTurn,
  relaySessions,
  type RelaySession,
} from "./state.js";

export function getRelaySession(relaySessionId: string, connId: string): RelaySession {
  return requireActiveTalkRelaySession({
    sessions: relaySessions,
    sessionId: relaySessionId,
    connId,
    closeSession: (session) => void closeRelaySession(session, "completed"),
    unknownSessionMessage: "Unknown realtime relay session",
  });
}

export function sendTalkRealtimeRelayAudio(params: {
  relaySessionId: string;
  connId: string;
  audioBase64: string;
  timestamp?: number;
}): void | Promise<void> {
  if (params.audioBase64.length > MAX_AUDIO_BASE64_BYTES) {
    throw new Error("Realtime relay audio frame is too large");
  }
  const session = getRelaySession(params.relaySessionId, params.connId);
  if (session.outputOwnership.phase === "cancelling") {
    return session.outputOwnership.drain!.promise.then(() => sendTalkRealtimeRelayAudio(params));
  }
  const audio = decodeTalkRelayAudioBase64(params.audioBase64, "Realtime relay");
  const turnId = ensureRelayTurn(session);
  session.bridge.sendAudio(audio);
  broadcastToOwner(
    session,
    { type: "inputAudio", byteLength: audio.byteLength },
    {
      type: "input.audio.delta",
      turnId,
      payload: { byteLength: audio.byteLength },
    },
  );
  if (typeof params.timestamp === "number" && Number.isFinite(params.timestamp)) {
    session.bridge.setMediaTimestamp(params.timestamp);
  }
}

export function acknowledgeTalkRealtimeRelayMark(params: {
  relaySessionId: string;
  connId: string;
  markName: string;
}): void {
  getRelaySession(params.relaySessionId, params.connId).bridge.acknowledgeMark(params.markName);
}
