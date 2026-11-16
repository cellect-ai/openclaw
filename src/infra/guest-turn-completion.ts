// Completion of a guest conversation turn (Cellect fork).
//
// A `hook:fi-guest:` turn is never delivered to a channel. When it ends, the
// gateway hands its attested outcome to the one handler a plugin registered, and
// that handler reports the reply back to the application that started the turn.
// The model has no tool for this: the reply is the run's own final text, so a
// guest turn cannot report anything else, or report twice by choice.
//
// With no handler registered nothing happens, so a gateway without a guest
// agent configured behaves exactly as before.

export type GuestTurnCompletion = {
  runId: string;
  sessionKey: string;
  /** Opaque receipt the application minted for this turn; never logged. */
  attestation: string;
  /** The Fi environment the hook named; the report goes to that environment only. */
  environment?: "dev" | "staging" | "prod";
  status: "ok" | "error" | "skipped";
  /** The run's final non-empty text, when it produced one. */
  outputText?: string;
};

export type GuestTurnCompletionHandler = (completion: GuestTurnCompletion) => Promise<void>;

let handler: GuestTurnCompletionHandler | undefined;

/** Registers the single handler; returns its release. A later registration replaces an earlier one. */
export function registerGuestTurnCompletionHandler(next: GuestTurnCompletionHandler): () => void {
  handler = next;
  return () => {
    if (handler === next) {
      handler = undefined;
    }
  };
}

/** Hands a finished guest turn to the handler. Never throws: a failed report must not fail the run. */
export async function notifyGuestTurnCompletion(
  completion: GuestTurnCompletion,
  onError: (error: unknown) => void,
): Promise<void> {
  const current = handler;
  if (!current) {
    return;
  }
  try {
    await current(completion);
  } catch (error) {
    onError(error);
  }
}
