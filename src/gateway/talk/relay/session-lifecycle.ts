import { AsyncLocalStorage } from "node:async_hooks";
import { formatErrorMessage as formatError } from "../../../infra/errors.js";
import { beginLifecycleWriteCustody } from "../../../infra/lifecycle-write-custody.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { withClientVoiceSessionSettlement } from "../../../talk/client-voice-session-lifecycle.js";
import type { RealtimeVoiceCloseOptions } from "../../../talk/provider-types.js";
import { closeTalkRelaySessionsForConnection } from "../relay-session-lifecycle.js";
import { forgetUnifiedTalkSession, registerTalkConnectionCleanup } from "../session-registry.js";
import {
  isTalkVoiceSessionReplacing,
  registerTalkVoiceSession,
  unregisterTalkVoiceSession,
} from "../voice-selection.js";
import {
  broadcastRelaySessionClosed,
  drainingRelaySessions,
  relaySessions,
  retireRelayAgentRuns,
  type RelaySession,
} from "./state.js";
import {
  captureRelayVoiceSessionSource,
  closeRelayVoiceSession,
  drainRelayVoiceTranscriptForClose,
} from "./voice.js";

export function adoptTalkRealtimeRelaySession(
  session: RelaySession,
  voice: Omit<
    Parameters<typeof registerTalkVoiceSession>[0],
    "voiceSessionId" | "connId" | "sessionTarget"
  >,
): void {
  session.cleanupTimer.unref();
  relaySessions.set(session.id, session);
  registerTalkConnectionCleanup(session.connId, "realtime-relay", () =>
    closeTalkRealtimeRelaySessionsForConnection(session.connId),
  );
  try {
    registerTalkVoiceSession({
      ...voice,
      voiceSessionId: session.id,
      connId: session.connId,
      sessionTarget: session.sessionTarget,
    });
  } catch (error) {
    void closeRelaySession(session, "error");
    throw error;
  }
}

export function closeRelaySession(
  session: RelaySession,
  reason: "completed" | "error",
  options?: RealtimeVoiceCloseOptions & { eventReason?: "output-cancelled" },
): void | Promise<void> {
  if (session.closing) {
    if (reason === "error") {
      session.closing.reason = reason;
    }
    return session.closing.completion;
  }
  const completion = createDeferredCore();
  const closing: NonNullable<RelaySession["closing"]> = {
    reason,
    completion: completion.promise,
  };
  session.closing = closing;
  const close = async (admissionFailure?: { error: unknown }) => {
    try {
      if (admissionFailure) {
        throw admissionFailure.error;
      }
      const source = captureRelayVoiceSessionSource(session);
      if (session.voiceSessionCreated) {
        source.assertCurrent();
      }
    } catch (error) {
      closing.reason = "error";
      closing.runTranscript = () => false;
      session.voiceTranscriptQueue.seal();
      const accepted = (session.voiceSessionClose ??= drainRelayVoiceTranscriptForClose(session));
      try {
        await finishRelaySessionClose(session, "error", closing, () => accepted, options);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Realtime relay close failed", {
          cause: cleanupError,
        });
      }
      throw error;
    }
    closing.runTranscript = AsyncLocalStorage.bind((run: () => boolean) => run());
    await finishRelaySessionClose(
      session,
      reason,
      closing,
      (disposition) => closeRelayVoiceSession(session, disposition),
      options,
    );
  };
  void withClientVoiceSessionSettlement(
    close,
    (error) => close({ error }),
    session.voiceSessionSource?.settlementContext,
  ).then(completion.resolve, completion.reject);
  // Disconnects, expiry, and provider callbacks have no RPC caller to observe cleanup failures.
  void completion.promise.catch((error: unknown) => {
    session.context.logGateway.warn(
      `failed to close realtime relay session: ${formatError(error)}`,
    );
  });
  return completion.promise;
}

export function finishRelaySessionClose(
  session: RelaySession,
  reason: "completed" | "error",
  closing: NonNullable<RelaySession["closing"]>,
  closeVoice: (disposition: "abort" | "detach") => Promise<void>,
  options?: RealtimeVoiceCloseOptions & { eventReason?: "output-cancelled" },
): Promise<void> {
  // Provider shutdown can emit final speech before transcript flush. Own this
  // closing prefix even when socket cleanup retained no admitted root.
  const releaseFinalPersistence = beginLifecycleWriteCustody("talk-final-persistence");
  let providerCloseFailed = false;
  const disposition =
    options?.disposition ??
    (session.speakerMxid ||
    isTalkVoiceSessionReplacing(session.id, session.connId, session.sessionTarget.agentId)
      ? "detach"
      : "abort");
  session.closeDisposition = disposition;
  unregisterTalkVoiceSession(session.id, session.connId, session.sessionTarget.agentId);
  session.transcriptReadiness.close();
  session.harness.close();
  session.outputOwnership.drain?.resolve();
  relaySessions.delete(session.id);
  drainingRelaySessions.add(session);
  forgetUnifiedTalkSession(session.id);
  clearTimeout(session.cleanupTimer);
  for (const release of session.agentToolCallTerminalSubscriptions?.values() ?? []) release();
  session.agentToolCallTerminalSubscriptions?.clear();
  retireRelayAgentRuns(
    session,
    disposition === "detach" ? undefined : reason === "error" ? "relay-error" : "relay-closed",
  );
  const finish = () => {
    const voiceClose = closeVoice(disposition).finally(() => session.runAuthority?.release());
    void voiceClose.then(
      () => {
        drainingRelaySessions.delete(session);
        // A failed provider close remains uncertain, even if record close succeeded.
        if (!providerCloseFailed) {
          releaseFinalPersistence?.();
          session.cleanupAdmission?.release();
        }
      },
      () => {
        if (!session.cleanupAdmission) {
          drainingRelaySessions.delete(session);
        }
      },
    );
    broadcastRelaySessionClosed(session, closing.reason, options?.eventReason);
    return voiceClose;
  };
  const failClose = async (error: unknown): Promise<never> => {
    providerCloseFailed = true;
    closing.reason = "error";
    await finish();
    if (session.cleanupAdmission) {
      drainingRelaySessions.add(session);
    }
    throw error;
  };
  let providerClose: void | Promise<void>;
  try {
    providerClose = session.bridge.close({ disposition });
  } catch (error) {
    return failClose(error);
  }
  return providerClose ? providerClose.then(finish, failClose) : finish();
}

export function closeTalkRealtimeRelaySessionsForConnection(connId: string): Promise<void> {
  return closeTalkRelaySessionsForConnection({
    sessions: [...relaySessions.values(), ...drainingRelaySessions],
    connId,
    closeSession: (session) => closeRelaySession(session, "completed", { disposition: "detach" }),
    onCloseError: (error, session) => {
      session.context.logGateway.warn(
        `failed to close realtime relay session after connection disconnect: ${formatError(error)}`,
      );
    },
  });
}
