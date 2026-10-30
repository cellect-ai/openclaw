import { extractDeliveryInfo } from "../../../config/sessions/delivery-info.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import {
  deliverOutboundPayloads,
  type OutboundDeliveryResult,
} from "../../../infra/outbound/deliver.js";
import {
  appendRelayVoiceTranscript,
  closeRelayVoiceSessionRecord,
  createOrResumeClientVoiceSession,
} from "../../../talk/client-voice-session.js";
import {
  normalizeVoiceTranscriptText,
  VOICE_TRANSCRIPT_QUEUE_POLICY,
} from "../../../talk/voice-transcript.js";
import { sleep } from "../../../utils/sleep.js";
import { drainingRelaySessions, type RelaySession } from "./state.js";

export type RelayVoiceTranscriptUpdate = {
  itemId?: string;
  textMode?: "delta" | "snapshot";
};

// A later final revises the previous saved line only while the speaker could
// still be finishing it. Grok carries an unanswered item's words into the next
// item's cumulative transcript ("And" -> "And how much ..."), seconds later.
const RELAY_VOICE_REVISION_WINDOW_MS = 30_000;

function extendsAtWordBoundary(shorter: string, longer: string): boolean {
  if (!longer.startsWith(shorter)) {
    return false;
  }
  const next = longer.charAt(shorter.length);
  // "No" -> "Now ..." is a new sentence; "And" -> "And how ..." continues it.
  return next === "" || /[\s\p{P}]/u.test(next) || /[\s\p{P}]$/u.test(shorter);
}

function sameSpokenUtterance(previous: string, next: string): boolean {
  if (previous.length < 2 || next.length < 2) {
    return false;
  }
  if (
    previous === next ||
    extendsAtWordBoundary(previous, next) ||
    extendsAtWordBoundary(next, previous)
  ) {
    return true;
  }
  const limit = Math.min(previous.length, next.length);
  let shared = 0;
  while (shared < limit && previous[shared] === next[shared]) {
    shared += 1;
  }
  return shared >= 8 && shared * 10 >= limit * 7;
}

const RELAY_TRANSCRIPT_RETRY_DELAYS_MS = [0, 500, 2_000] as const;

async function projectRelayTranscriptToOwningMatrix(params: {
  session: RelaySession;
  sessionKey: string;
  entryId: string;
  role: "user" | "assistant";
  text: string;
  utteranceKey: string;
  projectionId: string;
  deliveryIntentId: string;
  supersedeEventId?: string;
  arrivedAt: number;
}): Promise<OutboundDeliveryResult[]> {
  const cfg = params.session.voiceConfig ?? params.session.context.getRuntimeConfig();
  const stored = extractDeliveryInfo(params.sessionKey, { cfg });
  const deliveryContext = params.session.matrixRoute
    ? {
        channel: "matrix",
        to: `room:${params.session.matrixRoute.roomId}`,
        accountId: params.session.matrixRoute.accountId,
        threadId: params.session.matrixRoute.threadRootEventId,
      }
    : stored.deliveryContext;
  const threadId = params.session.matrixRoute?.threadRootEventId ?? stored.threadId;
  if (deliveryContext?.channel?.toLowerCase() !== "matrix" || !deliveryContext.to) {
    return [];
  }
  // Matrix is the canonical conversation transcript for a bound voice turn:
  // the delegated agent publishes its answer there. The realtime model's
  // assistant transcript is speech output, and forwarding it too creates a
  // second answer (or exposes an ungrounded voice-side error) in that thread.
  // Keep it in the durable voice-session transcript; project only caller speech.
  if (params.role === "assistant") {
    return [];
  }
  const projectionId = params.projectionId;
  // Fi loads a thread only through /relations/{root}/m.thread. An m.replace edit
  // drops that relation, so a revision has to be a new threaded message. The
  // previous event is redacted after the replacement is accepted.
  const supersedeEventId = params.supersedeEventId;
  const results = await deliverOutboundPayloads({
    cfg,
    channel: "matrix",
    to: deliveryContext.to,
    accountId: deliveryContext.accountId,
    threadId: deliveryContext.threadId ?? threadId,
    payloads: [
      {
        text: params.text,
        channelData: {
          matrix: {
            ...(supersedeEventId ? { supersedeEventId } : {}),
            extraContent: {
              "com.openclaw.voice_transcript": {
                version: 1,
                type: "voice.transcript",
                role: params.role,
                id: projectionId,
                ...(params.role === "user" && params.session.speakerMxid
                  ? { speakerMxid: params.session.speakerMxid }
                  : {}),
              },
            },
          },
        },
      },
    ],
    deliveryIntentId: params.deliveryIntentId,
    queuePolicy: "required",
  });
  const messageId = results.find(
    (result) => result.messageId && result.messageId !== "unknown",
  )?.messageId;
  params.session.voiceUtterance = {
    role: params.role,
    key: params.utteranceKey,
    text: params.text,
    at: params.arrivedAt,
    ...(messageId ? { eventId: messageId } : {}),
  };
  return results;
}

function logRelayVoiceFailure(session: RelaySession, message: string, error: unknown): void {
  session.context.logGateway?.warn(`${message}: ${formatErrorMessage(error)}`);
}

export function ensureRelayVoiceSession(session: RelaySession): boolean {
  if (session.voiceSessionCreated) {
    return true;
  }
  const { agentId, sessionKey } = session.sessionTarget;
  try {
    createOrResumeClientVoiceSession({
      agentId,
      sessionKey,
      provider: session.provider,
      origin: "relay",
      voiceSessionId: session.id,
    });
    session.voiceSessionCreated = true;
    return true;
  } catch (error) {
    logRelayVoiceFailure(session, "realtime relay voice session create failed", error);
    return false;
  }
}

export function enqueueRelayVoiceTranscript(
  session: RelaySession,
  role: "user" | "assistant",
  text: string,
  update?: RelayVoiceTranscriptUpdate,
): boolean {
  const observed =
    role === "user" && !session.closing
      ? session.confirmationReadiness.observeUserTranscript(text, true)
      : undefined;
  const normalizedText = normalizeVoiceTranscriptText(text);
  if (!normalizedText) {
    return true;
  }
  if (!ensureRelayVoiceSession(session)) {
    session.confirmationReadiness.fail(new Error("Realtime voice session could not be recorded"));
    return true;
  }
  const transcriptSeq = session.voiceTranscriptSeq + 1;
  const entryId = String(transcriptSeq);
  const arrivedAt = Date.now();
  const { agentId, sessionKey, canonicalKey, storePath } = session.sessionTarget;
  const admission = session.voiceTranscriptQueue.enqueue(
    async () => {
      let lastError: unknown;
      for (const delayMs of RELAY_TRANSCRIPT_RETRY_DELAYS_MS) {
        if (delayMs > 0) {
          await sleep(delayMs);
        }
        try {
          await appendRelayVoiceTranscript({
            agentId,
            sessionKey,
            sessionTarget: { sessionKey: canonicalKey, storePath },
            voiceSessionId: session.id,
            entryId,
            role,
            text: normalizedText,
            confirmation: observed?.confirmation ?? null,
            ...(session.voiceConfig ? { config: session.voiceConfig } : {}),
          });
          const open = session.voiceUtterance;
          const itemKey = update?.itemId?.trim() ? `item:${update.itemId.trim()}` : undefined;
          const revises =
            open?.role === role &&
            ((itemKey !== undefined && open.key === itemKey) ||
              (arrivedAt - open.at <= RELAY_VOICE_REVISION_WINDOW_MS &&
                sameSpokenUtterance(open.text, normalizedText)));
          const supersedeEventId = revises ? open?.eventId : undefined;
          const utteranceKey = revises && open ? open.key : (itemKey ?? entryId);
          const projectionId = `voice:${session.id}:${utteranceKey}`;
          if (!(supersedeEventId && open?.text === normalizedText)) {
            await projectRelayTranscriptToOwningMatrix({
              session,
              sessionKey,
              entryId,
              role,
              text: normalizedText,
              utteranceKey,
              projectionId,
              arrivedAt,
              // A stable intent refuses a second send, so a revision needs its own.
              deliveryIntentId: supersedeEventId ? `${projectionId}:${entryId}` : projectionId,
              ...(supersedeEventId ? { supersedeEventId } : {}),
            });
          }
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    },
    { weight: normalizedText.length },
  );
  if (!admission.accepted) {
    session.confirmationReadiness.fail(
      new Error("Realtime voice transcript queue is closed or full"),
    );
    if (admission.reason === "overflow") {
      session.failSession(VOICE_TRANSCRIPT_QUEUE_POLICY.overflowMessage);
    }
    return false;
  }
  session.voiceTranscriptSeq = transcriptSeq;
  void admission.completion.then(observed?.persisted, (error: unknown) => {
    session.confirmationReadiness.fail(error);
    logRelayVoiceFailure(session, "realtime relay transcript append failed", error);
  });
  return true;
}

export function closeRelayVoiceSession(session: RelaySession): Promise<void> {
  if (session.voiceSessionClose) {
    return session.voiceSessionClose;
  }
  session.voiceTranscriptQueue.seal();
  if (!ensureRelayVoiceSession(session)) {
    session.voiceSessionClose = Promise.reject(
      new Error("Realtime relay final voice record could not be created"),
    );
    return session.voiceSessionClose;
  }
  const { agentId, sessionKey } = session.sessionTarget;
  session.voiceSessionClose = session.voiceTranscriptQueue
    .flush({ requireSuccess: true })
    .then(async () => {
      const config = session.voiceConfig ?? session.context.getRuntimeConfig();
      await closeRelayVoiceSessionRecord({
        agentId,
        sessionKey,
        voiceSessionId: session.id,
        config,
      });
    })
    .catch((error: unknown) => {
      logRelayVoiceFailure(session, "realtime relay voice session close failed", error);
      throw error;
    });
  drainingRelaySessions.add(session);
  const releaseDraining = () => {
    drainingRelaySessions.delete(session);
  };
  // A failed final prefix remains owned for diagnosis; completion is not success.
  void session.voiceSessionClose.then(releaseDraining, () => {
    if (!session.cleanupAdmission) {
      releaseDraining();
    }
  });
  return session.voiceSessionClose;
}
