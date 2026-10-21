import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import type { PluginHookToolContext } from "openclaw/plugin-sdk/types";
import { brokerToken, configFromRuntime, matrixConnection } from "./fi-delegation.js";

const UNAVAILABLE = "I couldn’t verify your access to this agent. Please try again shortly.";
const DENIED = "You don’t currently have access to this agent in this conversation.";
// Fi intentionally declines unaddressed/non-selected text agents without a reply.
const SILENT = Symbol("matrix-agent-not-selected");
type AuthorizationFailure = typeof UNAVAILABLE | typeof DENIED | typeof SILENT;
// Not the gated set: the only sessions exempt from it. These are the source
// sessions the Matrix channel's own reply guard supports and authorizes.
const SOURCE_SESSION = /^agent:(cellect-fi-user|cellect-fi-admin|cellect-main):slack:/;
type Turn = {
  admitted: boolean;
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
 * Threaded text and Talk consults keep the bare Matrix room on channel context,
 * while the hook chat id can be the session raw id (`!room:server:thread:$root`).
 * Accept its suffix only when it matches the host-owned session (or Talk root).
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

/**
 * Fi owns live grants. Retain only host-proven event identity, never an access decision.
 *
 * Every agent a Matrix account is bound to is gated, whatever its id: the host
 * routes a Matrix turn to an agent by this runtime's bindings, so the gated set
 * is exactly what is configured, with no list here to fall out of step. An
 * agent this plugin has never heard of is denied until Fi admits the turn.
 */
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
    dispose: () => {
      turns.clear();
      turnRuntime?.dispose();
    },
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
  const requestAuthorization = async (
    turn: Turn,
    policy?: true | "own-accounts" | "tenant-domain-admin",
    abortSignal?: AbortSignal,
    slackRequesterWorkspace = false,
  ) => {
    const config = configFromRuntime(api);
    const connection = matrixConnection(config, turn.accountId);
    const token = connection && brokerToken(connection);
    if (!config.tenantOrgId || !connection || !token) throw new Error(UNAVAILABLE);
    return fetch(`${connection.baseUrl.replace(/\/+$/, "")}/api/threads/agent-authorize`, {
      method: "POST",
      signal: AbortSignal.any([AbortSignal.timeout(12_000), ...(abortSignal ? [abortSignal] : [])]),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        roomId: turn.roomId,
        agentId: turn.agentId,
        ...(turn.mode === "voice"
          ? { mode: "voice", speakerMxid: turn.senderId, threadRootEventId: turn.threadRootEventId }
          : { eventId: turn.eventId }),
        ...(policy ? { recheck: true, googleRequester: policy } : {}),
        ...(slackRequesterWorkspace ? { slackRequesterWorkspace: true } : {}),
      }),
    });
  };
  const turnRuntime = api.runtime.channel.runtimeContexts.register({
    channelId: "matrix",
    capability: "fi-admitted-turn",
    context: {
      protocol: "fi-matrix-turn-v1",
      capture(context: OpenClawPluginToolContext) {
        const runId = context.runId;
        const turn = runId ? turns.get(runId) : undefined;
        if (
          !runId ||
          !turn?.admitted ||
          context.messageChannel !== "matrix" ||
          SOURCE_SESSION.test(context.sessionKey ?? "") ||
          turn.agentId !== context.agentId ||
          turn.accountId !== context.agentAccountId ||
          turn.sessionKey !== context.sessionKey ||
          turn.roomId !== context.nativeChannelId ||
          turn.senderId !== context.requesterSenderId ||
          (turn.mode === "text"
            ? turn.eventId !== context.currentMessageId
            : context.currentMessageId !== undefined ||
              sessionThreadId(turn.sessionKey) !== turn.threadRootEventId)
        )
          return undefined;
        const assertCurrent = () => {
          context.assertInvocationCurrent?.();
          if (turns.get(runId) !== turn || !turn.admitted) throw new Error(UNAVAILABLE);
        };
        assertCurrent();
        return Object.freeze({
          mode: turn.mode,
          assertCurrent,
          async authorizeRequester(
            policy: true | "own-accounts" | "tenant-domain-admin",
            abortSignal?: AbortSignal,
          ) {
            assertCurrent();
            abortSignal?.throwIfAborted();
            if (![true, "own-accounts", "tenant-domain-admin"].includes(policy))
              throw new Error(UNAVAILABLE);
            const response = await requestAuthorization(turn, policy, abortSignal);
            if (!response.ok) throw new Error(response.status === 403 ? DENIED : UNAVAILABLE);
            const result: unknown = await response.json();
            assertCurrent();
            abortSignal?.throwIfAborted();
            if (
              !result ||
              typeof result !== "object" ||
              !("ok" in result) ||
              result.ok !== true ||
              !("agentId" in result) ||
              result.agentId !== turn.agentId ||
              !("orgId" in result) ||
              result.orgId !== configFromRuntime(api).tenantOrgId
            )
              throw new Error(UNAVAILABLE);
            return result;
          },
        });
      },
    },
  });
  const authorize = async (
    turn: Turn,
    requester?: { workspaceId: string; resolve: (senderId: string) => void },
  ): Promise<AuthorizationFailure | undefined> => {
    try {
      const config = configFromRuntime(api);
      if (!config.tenantOrgId) {
        return UNAVAILABLE;
      }
      const response = await requestAuthorization(turn, requester ? true : undefined, undefined, Boolean(requester));
      if (response.status === 403) {
        return DENIED;
      }
      if (!response.ok) {
        return UNAVAILABLE;
      }
      const result: unknown = await response.json();
      if (
        turn.mode === "text" &&
        result &&
        typeof result === "object" &&
        "ok" in result &&
        result.ok === false &&
        "respond" in result &&
        result.respond === false
      ) {
        return SILENT;
      }
      if (
        !result ||
        typeof result !== "object" ||
        !("ok" in result) ||
        result.ok !== true ||
        !("agentId" in result) ||
        result.agentId !== turn.agentId ||
        !("orgId" in result) ||
        result.orgId !== config.tenantOrgId
      ) {
        return UNAVAILABLE;
      }
      if (requester) {
        const identity = "googleRequester" in result ? result.googleRequester : undefined;
        if (
          !identity ||
          typeof identity !== "object" ||
          !("matrixUserId" in identity) ||
          identity.matrixUserId !== turn.senderId ||
          !("slackUserId" in identity) ||
          typeof identity.slackUserId !== "string" ||
          !/^[UW][A-Z0-9]+$/.test(identity.slackUserId) ||
          !("workspaceId" in identity) ||
          identity.workspaceId !== requester.workspaceId
        ) {
          return UNAVAILABLE;
        }
        requester.resolve(identity.slackUserId);
      }
      return undefined;
    } catch {
      return UNAVAILABLE;
    }
  };
  api.runtime.channel?.runtimeContexts?.register({
    channelId: "matrix",
    capability: "requester-slack-identity",
    context: {
      resolveSender: async (requester: {
        sessionKey: string;
        accountId: string;
        senderId: string;
        workspaceId: string;
      }) => {
        if (!/^T[A-Z0-9]+$/.test(requester.workspaceId)) {
          return undefined;
        }
        let selected: [string, Turn] | undefined;
        for (const entry of turns) {
          const [, turn] = entry;
          if (
            turn.admitted &&
            turn.sessionKey === requester.sessionKey &&
            turn.accountId === requester.accountId &&
            turn.senderId === requester.senderId
          ) {
            if (selected) {
              return undefined;
            }
            selected = entry;
          }
        }
        if (!selected) {
          return undefined;
        }
        const [runId, turn] = selected;
        let senderId: string | undefined;
        // Fi's existing requester mapping rechecks the actual sender's current
        // private-conversation grants; the mapping is never retained on a turn.
        const failure = await authorize(turn, {
          workspaceId: requester.workspaceId,
          resolve: (resolved) => {
            senderId = resolved;
          },
        });
        return !failure && turns.get(runId) === turn && turn.admitted ? senderId : undefined;
      },
    },
  });
  api.on(
    "before_agent_reply",
    async (_event, context) => {
      if (context.channel !== "matrix") {
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
      const textSessionMatches = ["channel", "group", "direct"].some(
        (kind) =>
          context.sessionKey ===
          `agent:${context.agentId}:matrix:${kind}:${roomId}:thread:${threadId}`,
      );
      const chatMatches =
        typeof roomId === "string" &&
        hostChatMatchesRoom(
          context.chatId,
          roomId,
          talkThreadRootEventId ?? (textSessionMatches ? threadId : undefined),
        );
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
        admitted: false,
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
      const outcome =
        failure === SILENT
          ? "silent"
          : failure
            ? failure === DENIED
              ? "denied"
              : "unavailable"
            : "admitted";
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
        return failure === SILENT ? { handled: true } : { handled: true, reply: { text: failure } };
      }
      turn.admitted = true;
      return undefined;
    },
    { priority: 10_000 },
  );
  const beforeToolCall = (context: PluginHookToolContext) => {
    const matrixTurn =
      context.requester?.channel === "matrix" ||
      (context.sessionKey?.includes(":matrix:") ?? false) ||
      Boolean(context.runId && turns.has(context.runId));
    if (!matrixTurn || SOURCE_SESSION.test(context.sessionKey ?? "")) {
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
      turn.admitted = !failure;
      logEntitlements({
        phase: "tool",
        roomId: turn.roomId,
        agentId: turn.agentId,
        accountId: turn.accountId,
        mode: turn.mode,
        outcome:
          failure === SILENT
            ? "silent"
            : failure
              ? failure === DENIED
                ? "denied"
                : "unavailable"
              : "admitted",
        ...turnIds(turn),
        sessionThreadId: sessionThreadId(turn.sessionKey) ?? null,
      });
      return failure
        ? { block: true, blockReason: failure === SILENT ? DENIED : failure }
        : undefined;
    });
  };
  // Share identity already proved by this owner, never a cached grant decision.
  // The normal tool hook still checks Fi's current grants before delegation.
  const admittedVoiceTurn = (
    context: Pick<
      PluginHookToolContext,
      "runId" | "agentId" | "sessionKey" | "requester" | "abortSignal"
    >,
  ) => {
    const turn = context.runId ? turns.get(context.runId) : undefined;
    return turn?.admitted &&
      turn.mode === "voice" &&
      sessionThreadId(turn.sessionKey) === turn.threadRootEventId &&
      !context.abortSignal?.aborted &&
      turn.agentId === context.agentId &&
      turn.sessionKey === context.sessionKey &&
      context.requester?.channel === "matrix" &&
      turn.senderId === context.requester.senderId &&
      turn.accountId === context.requester.accountId
      ? turn
      : undefined;
  };
  return { beforeToolCall, admittedVoiceTurn };
}

export type MatrixEntitlements = ReturnType<typeof registerMatrixEntitlements>;
