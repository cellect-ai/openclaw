import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginHookToolContext } from "openclaw/plugin-sdk/types";
import { brokerToken, configFromRuntime, matrixConnection } from "./fi-delegation.js";

const AGENTS = new Set(["cellect-fi-user", "cellect-fi-admin", "cellect-main"]);
const UNAVAILABLE = "I couldn’t verify your access to this agent. Please try again shortly.";
const DENIED = "You don’t currently have access to this agent in this conversation.";
const SOURCE_SESSION = /^agent:(cellect-fi-user|cellect-fi-admin|cellect-main):slack:/;
type Turn = {
  agentId: string;
  accountId: string;
  roomId: string;
  senderId: string;
  sessionKey: string;
} & ({ eventId: string; mode: "text" } | { threadRootEventId: string; mode: "voice" });

function sessionThreadId(sessionKey: string): string | undefined {
  const marker = ":thread:";
  const at = sessionKey.lastIndexOf(marker);
  if (at < 0) {
    return undefined;
  }
  const id = sessionKey.slice(at + marker.length);
  return id.length > 0 ? id : undefined;
}

/**
 * Talk consults keep the Matrix room on channel context, while the hook chat id
 * can still be the session raw id (`!room:server:thread:$root`). That raw id is
 * the same room only when its thread suffix is the attested Talk root.
 */
function hostChatMatchesRoom(chatId: unknown, roomId: string, threadRoot: unknown): boolean {
  if (typeof chatId !== "string" || chatId.length === 0) {
    return false;
  }
  if (chatId === roomId) {
    return true;
  }
  if (typeof threadRoot !== "string" || !threadRoot.startsWith("$")) {
    return false;
  }
  const marker = ":thread:";
  const at = chatId.lastIndexOf(marker);
  return (
    at > 0 && chatId.slice(0, at) === roomId && chatId.slice(at + marker.length) === threadRoot
  );
}

function logEntitlements(fields: Record<string, unknown>, mismatch?: string): void {
  const line = {
    evt: "threads.agent_entitlements",
    ...fields,
    ...(mismatch ? { mismatch } : {}),
  };
  console.info(JSON.stringify(line));
  if (mismatch) {
    console.warn(JSON.stringify({ ...line, level: "warn" }));
  }
}

function turnIds(turn: Turn): { eventId: string | null; threadRootEventId: string | null } {
  return turn.mode === "voice"
    ? { eventId: null, threadRootEventId: turn.threadRootEventId }
    : { eventId: turn.eventId, threadRootEventId: null };
}

/** Fi owns live grants. Retain only host-proven event identity, never an access decision. */
export function registerMatrixEntitlements(api: OpenClawPluginApi) {
  const turns = new Map<string, Turn>();
  // agent_end closes one model attempt, not the admitted turn: recovery and
  // fallback can still execute tools under the same run. The outer lifecycle
  // owner publishes executionSettled only after all attempts have finished.
  api.agent.events.registerAgentEventSubscription({
    id: "matrix-entitlement-turn-retirement",
    streams: ["lifecycle"],
    handle(event) {
      if (
        event.data.executionSettled === true &&
        (event.data.phase === "end" || event.data.phase === "error")
      ) {
        turns.delete(event.runId);
      }
    },
  });
  api.lifecycle.registerRuntimeLifecycle({
    id: "matrix-entitlement-identities",
    dispose: () => turns.clear(),
    cleanup: ({ runId, sessionKey }) => {
      if (runId) {
        turns.delete(runId);
      } else if (sessionKey) {
        for (const [id, turn] of turns) {
          if (turn.sessionKey === sessionKey) {
            turns.delete(id);
          }
        }
      } else {
        turns.clear();
      }
    },
  });
  const authorize = async (turn: Turn): Promise<string | undefined> => {
    try {
      const config = configFromRuntime(api);
      if (!config.matrixTenantOrgId) {
        return UNAVAILABLE;
      }
      const connection = matrixConnection(config, turn.accountId);
      const token = connection && brokerToken(connection);
      if (!connection || !token) {
        return UNAVAILABLE;
      }
      // Shorter than the tool-hook deadline; admission catches all failures and returns a reply.
      const response = await fetch(
        `${connection.baseUrl.replace(/\/+$/, "")}/api/threads/agent-authorize`,
        {
          method: "POST",
          signal: AbortSignal.timeout(12_000),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            roomId: turn.roomId,
            agentId: turn.agentId,
            ...(turn.mode === "voice"
              ? {
                  mode: "voice",
                  speakerMxid: turn.senderId,
                  threadRootEventId: turn.threadRootEventId,
                }
              : { eventId: turn.eventId }),
          }),
        },
      );
      if (response.status === 403) {
        return DENIED;
      }
      if (!response.ok) {
        return UNAVAILABLE;
      }
      const result: unknown = await response.json();
      return result &&
        typeof result === "object" &&
        "ok" in result &&
        result.ok === true &&
        "agentId" in result &&
        result.agentId === turn.agentId &&
        "orgId" in result &&
        typeof result.orgId === "string" &&
        result.orgId === config.matrixTenantOrgId
        ? undefined
        : UNAVAILABLE;
    } catch {
      return UNAVAILABLE;
    }
  };
  api.on(
    "before_agent_reply",
    async (_event, context) => {
      if (context.channel !== "matrix" || !AGENTS.has(context.agentId ?? "")) {
        return undefined;
      }
      // Source-linked continuations already pass the Matrix channel's source-session guard.
      if (SOURCE_SESSION.test(context.sessionKey ?? "")) {
        return undefined;
      }
      const roomId = context.channelContext?.chat?.id;
      const eventId = context.channelContext?.chat?.eventId;
      const talkThreadRootEventId = context.channelContext?.chat?.talkThreadRootEventId;
      const senderId = context.channelContext?.sender?.id;
      const threadId = sessionThreadId(context.sessionKey ?? "");
      const chatMatches =
        typeof roomId === "string" &&
        hostChatMatchesRoom(context.chatId, roomId, talkThreadRootEventId);
      const senderMatches = typeof senderId === "string" && context.senderId === senderId;
      if (
        !context.runId ||
        !context.agentId ||
        !context.accountId ||
        !context.sessionKey ||
        typeof roomId !== "string" ||
        !roomId.startsWith("!") ||
        typeof senderId !== "string" ||
        !senderId.startsWith("@") ||
        !chatMatches ||
        !senderMatches
      ) {
        logEntitlements(
          {
            phase: "admission",
            roomId: typeof roomId === "string" ? roomId : null,
            agentId: context.agentId ?? null,
            accountId: context.accountId ?? null,
            outcome: "unavailable",
            reason: "incomplete_host_context",
            eventId: typeof eventId === "string" ? eventId : null,
            threadRootEventId:
              typeof talkThreadRootEventId === "string" ? talkThreadRootEventId : null,
            sessionThreadId: threadId ?? null,
            hasRunId: Boolean(context.runId),
            hasSessionKey: Boolean(context.sessionKey),
            chatMatches,
            senderMatches,
          },
          "incomplete_host_context",
        );
        return { handled: true, reply: { text: UNAVAILABLE } };
      }
      const source =
        typeof talkThreadRootEventId === "string" &&
        talkThreadRootEventId.startsWith("$") &&
        eventId === undefined
          ? { mode: "voice" as const, threadRootEventId: talkThreadRootEventId }
          : typeof eventId === "string" &&
              eventId.startsWith("$") &&
              talkThreadRootEventId === undefined
            ? { mode: "text" as const, eventId }
            : undefined;
      if (!source) {
        logEntitlements(
          {
            phase: "admission",
            roomId,
            agentId: context.agentId,
            accountId: context.accountId,
            outcome: "unavailable",
            eventId: typeof eventId === "string" ? eventId : null,
            threadRootEventId:
              typeof talkThreadRootEventId === "string" ? talkThreadRootEventId : null,
            sessionThreadId: threadId ?? null,
          },
          "exclusive_source",
        );
        return { handled: true, reply: { text: UNAVAILABLE } };
      }
      const turn: Turn = {
        agentId: context.agentId,
        accountId: context.accountId,
        roomId,
        ...source,
        senderId,
        sessionKey: context.sessionKey,
      };
      const voiceMismatch =
        turn.mode === "voice" && threadId && threadId !== turn.threadRootEventId
          ? "session_thread"
          : undefined;
      const runId = context.runId;
      turns.set(runId, turn);
      const failure = await authorize(turn);
      if (turns.get(runId) !== turn) {
        return { handled: true, reply: { text: UNAVAILABLE } };
      }
      const outcome = failure ? (failure === DENIED ? "denied" : "unavailable") : "admitted";
      logEntitlements(
        {
          phase: "admission",
          roomId,
          agentId: turn.agentId,
          accountId: turn.accountId,
          mode: turn.mode,
          outcome,
          ...turnIds(turn),
          sessionThreadId: threadId ?? null,
        },
        voiceMismatch,
      );
      if (failure) {
        turns.delete(runId);
        return { handled: true, reply: { text: failure } };
      }
      return undefined;
    },
    { priority: 10_000 },
  );
  const beforeToolCall = (context: PluginHookToolContext) => {
    const matrixTurn =
      context.requester?.channel === "matrix" ||
      (context.sessionKey?.includes(":matrix:") ?? false) ||
      Boolean(context.runId && turns.has(context.runId));
    if (
      !AGENTS.has(context.agentId ?? "") ||
      !matrixTurn ||
      SOURCE_SESSION.test(context.sessionKey ?? "")
    ) {
      return undefined;
    }
    const runId = context.runId;
    const turn = runId ? turns.get(runId) : undefined;
    if (
      !runId ||
      !turn ||
      turn.agentId !== context.agentId ||
      turn.sessionKey !== context.sessionKey ||
      turn.senderId !== context.requester?.senderId ||
      turn.accountId !== context.requester?.accountId
    ) {
      logEntitlements(
        {
          phase: "tool",
          roomId: turn?.roomId ?? null,
          agentId: context.agentId ?? null,
          accountId: context.requester?.accountId ?? turn?.accountId ?? null,
          outcome: "unavailable",
          reason: "no_admission",
          sessionThreadId: sessionThreadId(context.sessionKey ?? "") ?? null,
        },
        "no_admission",
      );
      return { block: true, blockReason: UNAVAILABLE };
    }
    return authorize(turn).then((failure) => {
      // A terminal publication or replacement can arrive while Fi checks live
      // grants. A successful response cannot resurrect a retired admission.
      if (turns.get(runId) !== turn || context.abortSignal?.aborted) {
        return { block: true, blockReason: UNAVAILABLE };
      }
      logEntitlements({
        phase: "tool",
        roomId: turn.roomId,
        agentId: turn.agentId,
        accountId: turn.accountId,
        mode: turn.mode,
        outcome: failure ? (failure === DENIED ? "denied" : "unavailable") : "admitted",
        ...turnIds(turn),
        sessionThreadId: sessionThreadId(turn.sessionKey) ?? null,
      });
      return failure ? { block: true, blockReason: failure } : undefined;
    });
  };
  return beforeToolCall;
}
