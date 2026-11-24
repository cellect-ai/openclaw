import { suspendSession, type SessionSuspensionParams } from "./session-suspension.js";

export type DeferredSessionSuspensionState = {
  pending?: SessionSuspensionParams;
};

export function flushDeferredSessionSuspension(state: DeferredSessionSuspensionState): void {
  const pending = state.pending;
  if (!pending) {
    return;
  }
  state.pending = undefined;
  void suspendSession(pending);
}
