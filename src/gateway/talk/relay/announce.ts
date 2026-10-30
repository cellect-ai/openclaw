import { getRelaySession } from "./operations.js";

const ANSWER_ANNOUNCEMENT_PROMPT =
  "An answer to the user's earlier request is ready. Say exactly 'I have an answer,' then summarise the following for speech in under 45 seconds. Do not read links, ids or tables. Then stop and listen.";

/**
 * Has the owner's realtime voice speak a finished answer to an earlier request.
 * The Gateway owns the speech framing; callers supply only the answer text.
 */
export function announceTalkRealtimeRelayAnswer(params: {
  relaySessionId: string;
  connId: string;
  text: string;
}): void | Promise<void> {
  const session = getRelaySession(params.relaySessionId, params.connId);
  if (!session.bridge.bridge.sendUserMessage) {
    throw new Error("Realtime voice provider cannot speak an announcement");
  }
  // A cancelled response still owns the output until its drain settles.
  if (session.outputOwnership.phase === "cancelling") {
    return session.outputOwnership.drain!.promise.then(() =>
      announceTalkRealtimeRelayAnswer(params),
    );
  }
  session.bridge.sendUserMessage(`${ANSWER_ANNOUNCEMENT_PROMPT}\n\n${params.text}`);
}
