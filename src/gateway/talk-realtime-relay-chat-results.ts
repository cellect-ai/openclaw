import { formatErrorMessage as formatError } from "../infra/errors.js";
import { observeChatTerminal } from "./chat-terminal-observer.js";
import type { submitTalkRealtimeRelayToolResult } from "./talk/relay/operations.js";
import { relaySessions, type RelaySession } from "./talk/relay/state.js";

/** The ACK registers this listener before dispatch starts; no browser echo is required. */
export function registerRelayChatTerminal(
  session: RelaySession,
  runId: string,
  callId: string,
  sessionKey: string,
  submit: typeof submitTalkRealtimeRelayToolResult,
): void {
  const registration = session.activeAgentToolCalls.get(callId);
  const run = registration?.run;
  if (!registration || !run || run.runId !== runId || run.sessionKey !== sessionKey) {
    throw new Error("Relay terminal observer requires the registered run owner");
  }
  session.agentToolCallTerminalSubscriptions ??= new Map();
  session.agentToolCallTerminalSubscriptions.get(callId)?.();
  const release = observeChatTerminal(runId, sessionKey, (terminal) => {
    session.agentToolCallTerminalSubscriptions?.delete(callId);
    if (
      relaySessions.get(session.id) !== session ||
      session.closeDisposition !== undefined ||
      session.activeAgentRuns.get(runId) !== run ||
      session.activeAgentToolCalls.get(callId) !== registration ||
      !registration.isCurrent("completion") ||
      session.toolCalls.isAgentCompleted(callId) ||
      session.toolCalls.hasCancelled(callId)
    ) {
      return;
    }
    const content = terminal.message?.content;
    const text = Array.isArray(content)
      ? content
          .flatMap((part: unknown) => {
            if (!part || typeof part !== "object") {
              return [];
            }
            const block = part as { type?: unknown; text?: unknown };
            return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
          })
          .join("")
      : "";
    const result =
      terminal.state === "final"
        ? { result: text }
        : { error: terminal.errorMessage ?? "Agent run cancelled" };
    const fail = (error: unknown) => {
      if (relaySessions.get(session.id) === session) {
        session.failSession(formatError(error));
      }
    };
    try {
      void Promise.resolve(
        submit({
          relaySessionId: session.id,
          connId: session.connId,
          callId,
          result,
        }),
      ).catch(fail);
    } catch (error) {
      fail(error);
    }
  });
  session.agentToolCallTerminalSubscriptions.set(callId, release);
}
