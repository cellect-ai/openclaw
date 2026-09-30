import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginHookToolContext } from "openclaw/plugin-sdk/types";
import { brokerToken, configFromRuntime, matrixConnection } from "./fi-delegation.js";

const AGENTS = new Set(["cellect-fi-user", "cellect-fi-admin", "cellect-main"]);
const UNAVAILABLE = "I couldn’t verify your access to this agent. Please try again shortly.";
const AUTHORIZE_BUDGET_MS = 12_000;
const AUTHORIZE_ATTEMPTS = 3;
const AUTHORIZE_BACKOFF_MS = 500;
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const DENIED = "You don’t currently have access to this agent in this conversation.";
const SOURCE_SESSION = /^agent:(cellect-fi-user|cellect-fi-admin|cellect-main):slack:/;
type Turn = {
  agentId: string;
  accountId: string;
  roomId: string;
  senderId: string;
  sessionKey: string;
} & ({ eventId: string; mode: "text" } | { threadRootEventId: string; mode: "voice" });

/** Fi owns live grants. Retain only host-proven event identity, never an access decision. */
export function registerMatrixEntitlements(api: OpenClawPluginApi) {
  const turns = new Map<string, Turn>();
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
      // One budget, shorter than the tool-hook deadline; admission catches all
      // failures and returns a reply. A connection failure or a 502/503/504 is
      // Fi restarting or briefly overloaded, not a denial, so retry inside the
      // same budget instead of turning the agent's reply into an access error.
      const deadline = Date.now() + AUTHORIZE_BUDGET_MS;
      const body = JSON.stringify({
        roomId: turn.roomId,
        agentId: turn.agentId,
        ...(turn.mode === "voice"
          ? {
              mode: "voice",
              speakerMxid: turn.senderId,
              threadRootEventId: turn.threadRootEventId,
            }
          : { eventId: turn.eventId }),
      });
      let response: Response | undefined;
      for (let attempt = 1; attempt <= AUTHORIZE_ATTEMPTS; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          break;
        }
        try {
          response = await fetch(
            `${connection.baseUrl.replace(/\/+$/, "")}/api/threads/agent-authorize`,
            {
              method: "POST",
              signal: AbortSignal.timeout(remaining),
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body,
            },
          );
          if (!TRANSIENT_STATUSES.has(response.status)) {
            break;
          }
        } catch {
          response = undefined;
        }
        const backoff = AUTHORIZE_BACKOFF_MS * attempt;
        if (attempt === AUTHORIZE_ATTEMPTS || deadline - Date.now() <= backoff + 1_000) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
      if (!response) {
        return UNAVAILABLE;
      }
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
      if (
        !context.runId ||
        !context.agentId ||
        !context.accountId ||
        !context.sessionKey ||
        typeof roomId !== "string" ||
        !roomId.startsWith("!") ||
        typeof senderId !== "string" ||
        !senderId.startsWith("@") ||
        context.chatId !== roomId ||
        context.senderId !== senderId
      ) {
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
      const failure = await authorize(turn);
      if (failure) {
        return { handled: true, reply: { text: failure } };
      }
      turns.set(context.runId, turn);
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
    const turn = context.runId ? turns.get(context.runId) : undefined;
    if (
      !turn ||
      turn.agentId !== context.agentId ||
      turn.sessionKey !== context.sessionKey ||
      turn.senderId !== context.requester?.senderId ||
      turn.accountId !== context.requester?.accountId
    ) {
      return { block: true, blockReason: UNAVAILABLE };
    }
    return authorize(turn).then((failure) =>
      failure ? { block: true, blockReason: failure } : undefined,
    );
  };
  api.on("agent_end", (_event, context) => {
    if (context.runId) {
      turns.delete(context.runId);
    }
  });
  return beforeToolCall;
}
