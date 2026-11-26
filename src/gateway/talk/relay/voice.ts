import { extractDeliveryInfo } from "../../../config/sessions/delivery-info.js";
import { releaseSessionSourceAuthorities } from "../../../config/sessions/session-source-authority.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import {
  deliverOutboundPayloads,
  type OutboundDeliveryResult,
} from "../../../infra/outbound/deliver.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { withClientVoiceSessionSettlement } from "../../../talk/client-voice-session-lifecycle.js";
import {
  captureClientVoiceSessionSource,
  captureClientVoiceSessionWriter,
  type ClientVoiceSessionWriter,
} from "../../../talk/client-voice-session-source.js";
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
import { appendTalkClientTranscript } from "../client-transcript.js";
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
// A required Matrix projection is part of this relay's accepted transcript debt,
// even when its route was resolved from the stored session rather than a binding.
const matrixProjectionQueues = new WeakSet<RelaySession>();

/** Sealed close owns all accepted work; required projection failures cannot become a clean drain. */
export async function drainRelayVoiceTranscriptForClose(session: RelaySession): Promise<void> {
  session.voiceTranscriptQueue.seal();
  await session.voiceTranscriptQueue.flush();
  // Route resolution happens inside queued work, so inspect after that prefix
  // settled. Sealing prevents the strict join from capturing any later input.
  if (session.matrixRoute || matrixProjectionQueues.has(session)) {
    await session.voiceTranscriptQueue.flush({ requireSuccess: true });
  }
}

async function withRelayTranscriptRetries(
  run: () => Promise<unknown>,
  reconcileUnknown = false,
): Promise<void> {
  let lastError: unknown;
  for (const delayMs of RELAY_TRANSCRIPT_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    try {
      await run();
      return;
    } catch (error) {
      if (hasSqliteWorkerOutcomeUnknown(error) && !reconcileUnknown) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError;
}

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
  assertCurrent: () => void;
}): Promise<OutboundDeliveryResult[]> {
  const cfg = params.session.voiceConfig ?? params.session.context.getRuntimeConfig();
  const stored = params.session.matrixRoute
    ? undefined
    : await extractDeliveryInfo(params.sessionKey, { cfg });
  params.assertCurrent();
  const deliveryContext = params.session.matrixRoute
    ? {
        channel: "matrix",
        to: `room:${params.session.matrixRoute.roomId}`,
        accountId: params.session.matrixRoute.accountId,
        threadId: params.session.matrixRoute.threadRootEventId,
      }
    : stored?.deliveryContext;
  const threadId = params.session.matrixRoute?.threadRootEventId ?? stored?.threadId;
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
  matrixProjectionQueues.add(params.session);
  params.assertCurrent();
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

export function captureRelayVoiceSessionSource(session: RelaySession) {
  return (session.voiceSessionSource ??= captureClientVoiceSessionSource(
    session.sessionTarget.agentId,
  ));
}

export function ensureRelayVoiceSession(session: RelaySession): Promise<boolean> {
  const fail = (error: unknown) => {
    if (!hasSqliteWorkerOutcomeUnknown(error)) {
      session.voiceSessionCreation = undefined;
    }
    logRelayVoiceFailure(session, "realtime relay voice session create failed", error);
    return false;
  };
  try {
    const source = captureRelayVoiceSessionSource(session);
    if (session.voiceSessionCreated) {
      return source.prepareCurrent().then(() => true, fail);
    }
    const { agentId, sessionKey } = session.sessionTarget;
    session.voiceSessionCreation ??= withClientVoiceSessionSettlement(
      async () => {
        let writer: ClientVoiceSessionWriter | undefined;
        const errors: unknown[] = [];
        try {
          writer = captureClientVoiceSessionWriter({ agentId, physicalSource: source });
          await createOrResumeClientVoiceSession(
            {
              agentId,
              sessionKey,
              provider: session.provider,
              origin: "relay",
              voiceSessionId: session.id,
            },
            writer,
          );
          const committed = writer.source;
          committed.assertCurrent();
          session.voiceSessionSource = committed;
          session.voiceSessionCreated = true;
          return true;
        } catch (error) {
          errors.push(error);
          if (writer && !hasSqliteWorkerOutcomeUnknown(error)) {
            try {
              // Admission may have created the file before the voice write was refused.
              const admitted = writer.source;
              admitted.assertCurrent();
              session.voiceSessionSource = admitted;
            } catch {
              // Keep the original descriptor fenced when its creator cannot certify the file.
            }
          }
          throw error;
        } finally {
          await releaseSessionSourceAuthorities(writer ? [writer] : [], errors);
        }
      },
      undefined,
      source.settlementContext,
    ).catch(fail);
    return session.voiceSessionCreation;
  } catch (error) {
    return Promise.resolve(fail(error));
  }
}

export function enqueueRelayVoiceTranscript(
  session: RelaySession,
  role: "user" | "assistant",
  text: string,
  update?: RelayVoiceTranscriptUpdate,
): boolean {
  const normalizedText = normalizeVoiceTranscriptText(text);
  if (!normalizedText) {
    return true;
  }
  const transcriptSeq = session.voiceTranscriptSeq + 1;
  const entryId = String(transcriptSeq);
  const arrivedAt = Date.now();
  const userTranscript =
    role === "user"
      ? session.transcriptReadiness.observeUserTranscript(normalizedText, true)
      : undefined;
  const { agentId, sessionKey, canonicalKey, storePath } = session.sessionTarget;
  let accepted = false;
  let rejection: string | undefined;
  const reportFailure = (error: unknown) => {
    session.transcriptReadiness.fail(error);
    logRelayVoiceFailure(session, "realtime relay transcript append failed", error);
  };
  const completion = withClientVoiceSessionSettlement(
    async () => {
      captureRelayVoiceSessionSource(session);
      const admission = session.voiceTranscriptQueue.enqueue(
        async () => {
          if (!(await ensureRelayVoiceSession(session))) {
            throw new Error("Realtime voice session could not be recorded");
          }
          const writer = captureClientVoiceSessionWriter({
            agentId,
            physicalSource: captureRelayVoiceSessionSource(session),
          });
          try {
            await withRelayTranscriptRetries(() =>
              appendTalkClientTranscript(
                {
                  agentId,
                  sessionKey,
                  sessionTarget: { sessionKey: canonicalKey, storePath },
                  voiceSessionId: session.id,
                  entryId,
                  role,
                  text: normalizedText,
                  confirmation: userTranscript?.confirmation ?? null,
                  ...(session.capabilities?.handlesAgentConsult ? { providerOwned: true } : {}),
                  config: session.voiceConfig ?? session.context.getRuntimeConfig(),
                },
                session.context,
                writer,
                appendRelayVoiceTranscript,
              ),
            );
            userTranscript?.persisted();
            writer.assertCurrent();
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
                assertCurrent: () => writer.assertCurrent(),
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
          } finally {
            await writer.release();
          }
        },
        { weight: normalizedText.length },
      );
      accepted = admission.accepted;
      if (!admission.accepted) {
        rejection = admission.reason;
        return;
      }
      session.voiceTranscriptSeq = transcriptSeq;
      await admission.completion.then(undefined, reportFailure);
    },
    undefined,
    session.voiceSessionSource?.settlementContext,
  );
  void completion.catch(reportFailure);
  if (!accepted) {
    session.transcriptReadiness.fail(
      new Error("Realtime voice transcript queue is closed or full"),
    );
    if (rejection === "overflow") {
      session.failSession(VOICE_TRANSCRIPT_QUEUE_POLICY.overflowMessage);
    }
    return false;
  }
  return true;
}

export function closeRelayVoiceSession(
  session: RelaySession,
  disposition: "abort" | "detach" = "abort",
): Promise<void> {
  if (session.voiceSessionClose) {
    return session.voiceSessionClose;
  }
  session.voiceTranscriptQueue.seal();
  const { agentId, sessionKey } = session.sessionTarget;
  session.voiceSessionClose = withClientVoiceSessionSettlement(
    async () => {
      try {
        captureRelayVoiceSessionSource(session);
        await ensureRelayVoiceSession(session);
      } catch (error) {
        await drainRelayVoiceTranscriptForClose(session);
        throw error;
      }
      await drainRelayVoiceTranscriptForClose(session);
      if (!session.voiceSessionCreated) {
        return;
      }
      const writer = captureClientVoiceSessionWriter({
        agentId,
        physicalSource: captureRelayVoiceSessionSource(session),
      });
      const errors: unknown[] = [];
      try {
        if (disposition === "detach") {
          for (const append of session.unspokenAnswers?.values() ?? []) {
            try {
              // The stable-key transcript turn reconciles any earlier commit before inserting.
              await withRelayTranscriptRetries(() => append(writer), true);
            } catch (error) {
              errors.push(error);
            }
          }
        }
        try {
          const config = session.voiceConfig ?? session.context.getRuntimeConfig();
          await closeRelayVoiceSessionRecord(
            {
              agentId,
              sessionKey,
              voiceSessionId: session.id,
              config,
            },
            writer,
          );
        } catch (error) {
          errors.push(error);
        }
      } finally {
        await releaseSessionSourceAuthorities([writer], errors);
      }
    },
    async (error) => {
      await drainRelayVoiceTranscriptForClose(session);
      throw error;
    },
    session.voiceSessionSource?.settlementContext,
  ).catch((error: unknown) => {
    logRelayVoiceFailure(session, "realtime relay voice session close failed", error);
    throw error;
  });
  drainingRelaySessions.add(session);
  void session.voiceSessionClose.then(
    () => drainingRelaySessions.delete(session),
    () => {
      if (!session.cleanupAdmission) drainingRelaySessions.delete(session);
    },
  );
  return session.voiceSessionClose;
}
