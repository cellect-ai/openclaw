import { notifyListeners } from "../shared/listeners.js";

export type ChatTerminalObservation = {
  runId: string;
  sessionKey: string;
  state: "final" | "error" | "aborted";
  message?: Record<string, unknown>;
  errorMessage?: string;
  yielded?: boolean;
};

type Observer = { sessionKey: string; accept: (terminal: ChatTerminalObservation) => void };
const observers = new Map<string, Set<Observer>>();

export function hasChatTerminalObserver(runId: string, sessionKey: string): boolean {
  const listeners = observers.get(runId);
  return listeners !== undefined && [...listeners].some((entry) => entry.sessionKey === sessionKey);
}

/** Internal run consumers do not acquire browser transcript subscription rights. */
export function observeChatTerminal(
  runId: string,
  sessionKey: string,
  listener: (terminal: ChatTerminalObservation) => void,
): () => void {
  const listeners = observers.get(runId) ?? new Set<Observer>();
  const unsubscribe = () => {
    listeners.delete(observer);
    if (listeners.size === 0 && observers.get(runId) === listeners) {
      observers.delete(runId);
    }
  };
  const accept = (terminal: ChatTerminalObservation) => {
    if (terminal.sessionKey !== sessionKey || terminal.yielded) {
      return;
    }
    unsubscribe();
    listener(terminal);
  };
  const observer = { sessionKey, accept };
  listeners.add(observer);
  observers.set(runId, listeners);
  return unsubscribe;
}

/** Called by both terminal producers before any socket-recipient filtering. */
export function publishChatTerminal(terminal: ChatTerminalObservation): void {
  const listeners = observers.get(terminal.runId);
  if (listeners) {
    notifyListeners(
      [...listeners].map((entry) => entry.accept),
      terminal,
    );
  }
}
