// Gateway Talk realtime relay.
// Bridges browser Talk audio sessions with realtime voice provider plugins.
export { announceTalkRealtimeRelayAnswer, normalizeTalkAnswerText } from "./announce.js";
export { createTalkRealtimeRelaySession } from "./session-create.js";
export {
  acknowledgeTalkRealtimeRelayMark,
  cancelTalkRealtimeRelayTurn,
  ensureTalkRealtimeRelayVoiceSession,
  flushTalkRealtimeRelayVoiceWrites,
  prepareTalkRealtimeRelayAgentRunRegistration,
  registerTalkRealtimeRelayAgentRun,
  sendTalkRealtimeRelayAudio,
  steerTalkRealtimeRelayAgentRun,
  stopTalkRealtimeRelaySession,
  submitTalkRealtimeRelayToolResult,
} from "./operations.js";
