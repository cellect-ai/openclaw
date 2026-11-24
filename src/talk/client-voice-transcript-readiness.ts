import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { materializeErrorStack } from "../infra/error-graph-internal.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  captureClientVoiceConfirmationUtterance,
  type ClientVoiceConfirmationUtteranceContext,
  invalidateClientVoiceConfirmationUtterance,
  readClientVoiceConfirmationReadiness,
} from "./client-voice-confirmation.js";

/** Keep native delegation behind the current transport's finalized user speech. */
export function createClientVoiceTranscriptReadiness(params: {
  agentId?: string;
  voiceSessionId?: string;
  flushTranscript: () => Promise<void>;
}) {
  const lifetime = new AbortController();
  let transcriptChanged = createDeferredCore();
  let failure: { error: unknown } | undefined;
  let userTranscript:
    | {
        finalReceived: boolean;
        complete: boolean;
        empty: boolean;
        superseded: boolean;
        confirmationId?: string;
        confirmation: ClientVoiceConfirmationUtteranceContext;
      }
    | undefined;
  const readConfirmation = () =>
    params.agentId && params.voiceSessionId
      ? readClientVoiceConfirmationReadiness(params.agentId, params.voiceSessionId)
      : undefined;
  const invalidateUtterance = () =>
    params.agentId && params.voiceSessionId
      ? invalidateClientVoiceConfirmationUtterance(params.agentId, params.voiceSessionId)
      : undefined;
  const notifyTranscriptChanged = () => {
    const changed = transcriptChanged;
    transcriptChanged = createDeferredCore();
    changed.resolve();
  };
  const throwIfFailed = () => {
    if (failure) {
      throw failure.error;
    }
  };
  return {
    observeUserTranscript(
      text: string,
      final: boolean,
    ):
      | { confirmation: ClientVoiceConfirmationUtteranceContext; persisted: () => void }
      | undefined {
      if (
        !params.agentId ||
        !params.voiceSessionId ||
        lifetime.signal.aborted ||
        (!final && !text.trim())
      ) {
        return undefined;
      }
      if (!userTranscript || userTranscript.finalReceived) {
        userTranscript = {
          finalReceived: false,
          complete: false,
          empty: false,
          superseded: false,
          confirmationId: readConfirmation()?.confirmationId,
          confirmation: captureClientVoiceConfirmationUtterance({
            agentId: params.agentId,
            voiceSessionId: params.voiceSessionId,
          }),
        };
      }
      const current = userTranscript;
      current.finalReceived = final;
      notifyTranscriptChanged();
      if (!final) {
        return undefined;
      }
      if (!text.trim()) {
        current.empty = true;
        current.complete = true;
        return undefined;
      }
      return {
        confirmation: current.confirmation,
        persisted: () => {
          current.complete = true;
          current.superseded = current.confirmationId !== readConfirmation()?.confirmationId;
          notifyTranscriptChanged();
        },
      };
    },
    fail(error: unknown): void {
      materializeErrorStack(error);
      failure = { error };
      notifyTranscriptChanged();
    },
    async wait(signal?: AbortSignal): Promise<void> {
      const waitSignal = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
      for (;;) {
        waitSignal.throwIfAborted();
        throwIfFailed();
        const observedUserTranscript = userTranscript;
        const pending = readConfirmation();
        const emptyFinalForPending =
          observedUserTranscript?.empty &&
          observedUserTranscript.confirmationId === pending?.confirmationId;
        if (
          pending &&
          (observedUserTranscript?.complete === false ||
            (pending.needsUserUtterance &&
              !pending.utteranceRejected &&
              !emptyFinalForPending &&
              !observedUserTranscript?.superseded))
        ) {
          // The canonical challenge owns expiry; local notifications also wake on
          // empty finals and failed persistence, which cannot authorize anything.
          await racePromiseWithAbortSignal(
            Promise.race([pending.changed, transcriptChanged.promise]),
            waitSignal,
          );
          continue;
        }
        await racePromiseWithAbortSignal(params.flushTranscript(), waitSignal);
        waitSignal.throwIfAborted();
        throwIfFailed();
        const currentPending = readConfirmation();
        if (
          observedUserTranscript !== userTranscript ||
          currentPending?.changed !== pending?.changed
        ) {
          continue;
        }
        if (emptyFinalForPending) {
          invalidateUtterance();
        }
        if (observedUserTranscript?.superseded) {
          userTranscript = undefined;
        }
        return;
      }
    },
    close(): void {
      lifetime.abort();
      userTranscript = undefined;
      notifyTranscriptChanged();
    },
  };
}
