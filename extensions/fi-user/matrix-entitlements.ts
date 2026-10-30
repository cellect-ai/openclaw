import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import {
  isTransientNetworkError,
  retryAsync,
  sleepWithAbort,
} from "openclaw/plugin-sdk/retry-runtime";
import type { PluginHookToolContext } from "openclaw/plugin-sdk/types";
import {
  brokerToken,
  configFromRuntime,
  matrixConnection,
  type ResolvedPluginConfig,
} from "./fi-delegation.js";

const UNAVAILABLE = "Access verification is temporarily unavailable. Please retry shortly.";
const DENIED = "You don’t currently have access to this agent in this conversation.";
// Fi intentionally declines unaddressed/non-selected text agents without a reply.
const SILENT = Symbol("matrix-agent-not-selected");
type AuthorizationFailure = typeof UNAVAILABLE | typeof DENIED | typeof SILENT;
// Not the gated set: the only sessions exempt from it. These are the source
// sessions the Matrix channel's own reply guard supports and authorizes.
const SOURCE_SESSION = /^agent:(cellect-fi-user|cellect-fi-admin|cellect-main):slack:/;
// Fi's admission, not the Matrix room kind, knows who can read this chat. Only
// a private, sole-human audience Fi proves is asserted; any other admitted
// answer withdraws it, since an earlier block can outlive its turn.
const AUDIENCE_CHANGED =
  "This conversation's audience changed during the turn. Treat it as shared and recheck what may be disclosed before continuing.";
const PRIVATE_SOLE_HUMAN_CONTEXT = [
  "## Fi conversation audience",
  "Verified by Fi's grant check when this prompt was built: private conversation; the requester is the only human member.",
  "",
  "```json",
  JSON.stringify({
    schema: "fi.conversation_audience.v1",
    visibility: "private",
    human_count: 1,
    mixed_audience: false,
    requester_is_sole_human: true,
  }),
  "```",
].join("\n");
// A Codex thread keeps an earlier block in its history, so a turn Fi did not
// prove private must withdraw it rather than stay silent.
const NOT_PRIVATE_SOLE_HUMAN_CONTEXT = [
  "## Fi conversation audience",
  "Fi's grant check did not verify this conversation as private to the requester when this prompt was built. Any earlier Fi conversation audience block no longer applies: treat the conversation as shared.",
  "",
  "```json",
  JSON.stringify({ schema: "fi.conversation_audience.v1", requester_is_sole_human: false }),
  "```",
].join("\n");
const MAX_CHECKED_SESSIONS = 5_000;
type Turn = {
  admitted: boolean;
  externalInput: boolean;
  authorization: AbortController;
  agentId: string;
  accountId: string;
  roomId: string;
  senderId: string;
  sessionKey: string;
  continuation?: PluginHookToolContext["requesterContinuation"];
  /** Fi-owned conversation tenant, pinned after the first successful admission. */
  orgId?: string;
  /** Latest Fi admission proved a private conversation whose only human is the sender. */
  privateSoleHuman?: boolean;
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

function isPrivateSoleHuman(result: object): boolean {
  const audience = "audience" in result ? result.audience : undefined;
  return Boolean(
    audience &&
    typeof audience === "object" &&
    "visibility" in audience &&
    audience.visibility === "private" &&
    "requesterIsSoleHuman" in audience &&
    audience.requesterIsSoleHuman === true &&
    "humanCount" in audience &&
    audience.humanCount === 1 &&
    "mixedAudience" in audience &&
    audience.mixedAudience === false,
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

function hasAuthorizationScope(config: ResolvedPluginConfig, agentId: string): boolean {
  if (config.tenantOrgConflict) {
    return false;
  }
  return config.operatorAgentId
    ? !config.tenantOrgId && config.operatorAgentId === agentId
    : Boolean(config.tenantOrgId);
}

/** Fi owns requester grants; configuration limits which runtime can consume them. */
function isAuthorizedProof(
  api: OpenClawPluginApi,
  turn: Turn,
  result: unknown,
): result is { ok: true; agentId: string; orgId: string; googleRequester?: unknown } {
  const config = configFromRuntime(api);
  if (
    !hasAuthorizationScope(config, turn.agentId) ||
    !result ||
    typeof result !== "object" ||
    !("ok" in result) ||
    result.ok !== true ||
    !("agentId" in result) ||
    result.agentId !== turn.agentId ||
    !("orgId" in result) ||
    typeof result.orgId !== "string" ||
    !result.orgId.trim() ||
    (turn.orgId !== undefined && result.orgId !== turn.orgId)
  ) {
    return false;
  }
  if (config.operatorAgentId) {
    return "credentialClass" in result && result.credentialClass === "operator";
  }
  return (
    result.orgId === config.tenantOrgId &&
    (!("credentialClass" in result) || result.credentialClass === "tenant")
  );
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
  const retireTurn = (runId: string) => {
    const turn = turns.get(runId);
    turn?.authorization.abort();
    turns.delete(runId);
  };
  const retireAll = () => {
    for (const runId of turns.keys()) {
      retireTurn(runId);
    }
  };
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
        retireTurn(event.runId);
      }
    },
  });
  /**
   * Sessions Fi has checked. A later run there that the gate did not admit
   * (an inter-session send, a manual run) was never checked itself, so it is
   * told only that any earlier block no longer applies.
   */
  const checkedSessions = new Set<string>();
  const noteChecked = (sessionKey: string): void => {
    const key = sessionKey.toLowerCase();
    checkedSessions.delete(key);
    checkedSessions.add(key);
    for (const oldest of checkedSessions) {
      if (checkedSessions.size <= MAX_CHECKED_SESSIONS) {
        break;
      }
      checkedSessions.delete(oldest);
    }
  };
  api.lifecycle.registerRuntimeLifecycle({
    id: "matrix-entitlement-identities",
    dispose: () => {
      retireAll();
      checkedSessions.clear();
      turnRuntime?.dispose();
    },
    cleanup: ({ runId, sessionKey }) => {
      if (runId) {
        retireTurn(runId);
      } else if (sessionKey) {
        checkedSessions.delete(sessionKey.toLowerCase());
        for (const [id, turn] of turns) {
          if (turn.sessionKey === sessionKey) {
            retireTurn(id);
          }
        }
      } else {
        retireAll();
        checkedSessions.clear();
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
    if (!hasAuthorizationScope(config, turn.agentId) || !connection || !token) {
      throw new Error(UNAVAILABLE);
    }
    // This POST only verifies current grants. Reuse the exact source and one
    // total budget; never retry a tool/business effect or refresh the deadline.
    const signal = AbortSignal.any([
      AbortSignal.timeout(12_000),
      turn.authorization.signal,
      ...(abortSignal ? [abortSignal] : []),
    ]);
    const url = `${connection.baseUrl.replace(/\/+$/, "")}/api/threads/agent-authorize`;
    const init = {
      method: "POST",
      signal,
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
    };
    const transientResponse = new Error("Fi authorization temporarily unavailable");
    return retryAsync(
      async () => {
        signal.throwIfAborted();
        const response = await fetch(url, init);
        signal.throwIfAborted();
        if ([500, 502, 503, 504].includes(response.status)) {
          await response.body?.cancel();
          throw transientResponse;
        }
        return response;
      },
      {
        attempts: 2,
        minDelayMs: 3_000,
        maxDelayMs: 3_000,
        jitter: 0,
        shouldRetry: (error) =>
          !signal.aborted && (error === transientResponse || isTransientNetworkError(error)),
        onRetry: ({ err, attempt }) =>
          logEntitlements({
            phase: "verification",
            agentId: turn.agentId,
            accountId: turn.accountId,
            outcome: "retrying",
            reason: err === transientResponse ? "service_unavailable" : "transport_unavailable",
            attempt,
            ...turnIds(turn),
          }),
        sleep: (ms) => sleepWithAbort(ms, signal),
      },
    );
  };
  const capture = (context: OpenClawPluginToolContext) => {
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
    ) {
      return undefined;
    }
    const assertCurrent = () => {
      turn.continuation?.assertCurrent();
      context.assertInvocationCurrent?.();
      if (turns.get(runId) !== turn || !turn.admitted) {
        throw new Error(UNAVAILABLE);
      }
    };
    assertCurrent();
    return Object.freeze({
      mode: turn.mode,
      assertCurrent,
      workbookProof() {
        assertCurrent();
        const config = configFromRuntime(api);
        const root = sessionThreadId(turn.sessionKey);
        if (
          config.operatorAgentId !== "cellect-main" ||
          config.tenantOrgId ||
          config.tenantOrgConflict ||
          !turn.externalInput ||
          turn.agentId !== "cellect-main" ||
          turn.mode !== "text" ||
          !root ||
          !turn.orgId
        ) {
          return undefined;
        }
        return {
          runId,
          sessionKey: turn.sessionKey,
          roomId: turn.roomId,
          eventId: turn.eventId,
          threadRootEventId: root,
          senderMxid: turn.senderId,
          accountId: turn.accountId,
          orgId: turn.orgId,
          signal: turn.authorization.signal,
          assertCurrent,
        };
      },
      async authorizeRequester(
        policy: true | "own-accounts" | "tenant-domain-admin",
        abortSignal?: AbortSignal,
      ) {
        assertCurrent();
        abortSignal?.throwIfAborted();
        if (![true, "own-accounts", "tenant-domain-admin"].includes(policy)) {
          throw new Error(UNAVAILABLE);
        }
        const wasPrivateSoleHuman = turn.privateSoleHuman;
        turn.privateSoleHuman = false;
        noteChecked(turn.sessionKey);
        const response = await requestAuthorization(turn, policy, abortSignal);
        if (!response.ok) {
          throw new Error(response.status === 403 ? DENIED : UNAVAILABLE);
        }
        const result: unknown = await response.json();
        turn.continuation?.assertCurrent();
        assertCurrent();
        abortSignal?.throwIfAborted();
        if (!isAuthorizedProof(api, turn, result)) {
          throw new Error(UNAVAILABLE);
        }
        turn.privateSoleHuman = isPrivateSoleHuman(result);
        if (wasPrivateSoleHuman && !turn.privateSoleHuman) {
          throw new Error(AUDIENCE_CHANGED);
        }
        return result;
      },
    });
  };
  const turnRuntime = api.runtime.channel.runtimeContexts.register({
    channelId: "matrix",
    capability: "fi-admitted-turn",
    context: { protocol: "fi-matrix-turn-v1", capture },
  });
  const authorize = async (
    turn: Turn,
    requester?: { workspaceId: string; resolve: (senderId: string) => void },
    abortSignal?: AbortSignal,
  ): Promise<AuthorizationFailure | undefined> => {
    // Only a successful check re-establishes the audience; failures leave it unknown.
    turn.privateSoleHuman = false;
    noteChecked(turn.sessionKey);
    try {
      turn.continuation?.assertCurrent();
      if (!hasAuthorizationScope(configFromRuntime(api), turn.agentId)) {
        return UNAVAILABLE;
      }
      const response = await requestAuthorization(
        turn,
        requester ? true : undefined,
        abortSignal,
        Boolean(requester),
      );
      if (response.status === 403) {
        return DENIED;
      }
      if (!response.ok) {
        return UNAVAILABLE;
      }
      const result: unknown = await response.json();
      turn.continuation?.assertCurrent();
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
      if (!isAuthorizedProof(api, turn, result)) {
        return UNAVAILABLE;
      }
      turn.orgId = result.orgId;
      turn.privateSoleHuman = isPrivateSoleHuman(result);
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
        const wasPrivateSoleHuman = turn.privateSoleHuman;
        let senderId: string | undefined;
        // Fi's existing requester mapping rechecks the actual sender's current
        // private-conversation grants; the mapping is never retained on a turn.
        const failure = await authorize(turn, {
          workspaceId: requester.workspaceId,
          resolve: (resolved) => {
            senderId = resolved;
          },
        });
        return !failure &&
          turns.get(runId) === turn &&
          turn.admitted &&
          !(wasPrivateSoleHuman && !turn.privateSoleHuman)
          ? senderId
          : undefined;
      },
    },
  });
  api.on(
    "before_agent_reply",
    async (_event, context) => {
      if (context.channel !== "matrix") {
        return undefined;
      }
      // Fresh source-linked ingress already passed the Matrix channel's source-session guard.
      // A native continuation rechecks its original Matrix event below.
      if (SOURCE_SESSION.test(context.sessionKey ?? "") && !context.requesterContinuation) {
        return undefined;
      }
      if (
        context.inputProvenance?.kind === "internal_system" &&
        context.inputProvenance.sourceTool === "exec"
      ) {
        // The heartbeat producer retains the completed command result, but
        // supplies no live human/event custody for a new Matrix turn. Do not
        // infer a principal from session history or report a human denial.
        if (context.runId) {
          retireTurn(context.runId);
        }
        logEntitlements({
          phase: "admission",
          agentId: context.agentId ?? null,
          accountId: context.accountId ?? null,
          outcome: "silent",
          reason: "orphan_exec_completion",
          sourceKind: context.inputProvenance.kind,
          sourceTool: context.inputProvenance.sourceTool,
        });
        return { handled: true };
      }
      const continuation = context.requesterContinuation;
      if (continuation) {
        try {
          continuation.assertCurrent();
          if (
            continuation.runId !== context.runId ||
            continuation.agentId !== context.agentId ||
            continuation.sessionKey !== context.sessionKey ||
            continuation.sessionId !== context.sessionId ||
            continuation.channel !== "matrix" ||
            continuation.accountId !== context.accountId ||
            (context.senderId !== undefined && context.senderId !== continuation.senderId) ||
            !continuation.sourceTurnId
          ) {
            throw new Error("Requester continuation does not own this turn");
          }
        } catch {
          return { handled: true, reply: { text: UNAVAILABLE } };
        }
      }
      const roomId = continuation?.chatId ?? context.channelContext?.chat?.id;
      const eventId = continuation?.eventId ?? context.channelContext?.chat?.eventId;
      const talkThreadRootEventId = context.channelContext?.chat?.talkThreadRootEventId;
      const senderId = continuation?.senderId ?? context.channelContext?.sender?.id;
      const threadId = sessionThreadId(context.sessionKey ?? "");
      const textSessionMatches = ["channel", "group", "direct"].some(
        (kind) =>
          context.sessionKey ===
          `agent:${context.agentId}:matrix:${kind}:${roomId}:thread:${threadId}`,
      );
      const chatMatches =
        typeof roomId === "string" &&
        hostChatMatchesRoom(
          continuation?.chatId ?? context.chatId,
          roomId,
          talkThreadRootEventId ?? (textSessionMatches ? threadId : undefined),
        );
      const senderMatches =
        typeof senderId === "string" &&
        (continuation ? continuation.senderId === senderId : context.senderId === senderId);
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
        externalInput: !context.inputProvenance || context.inputProvenance.kind === "external_user",
        admitted: false,
        authorization: new AbortController(),
        ...(continuation ? { continuation } : {}),
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
      retireTurn(runId);
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
        retireTurn(runId);
        return failure === SILENT ? { handled: true } : { handled: true, reply: { text: failure } };
      }
      turn.admitted = true;
      return undefined;
    },
    { priority: 10_000 },
  );
  api.on("before_prompt_build", (_event, context) => {
    const turn = context.runId ? turns.get(context.runId) : undefined;
    const privateSoleHuman =
      turn?.admitted && turn.agentId === context.agentId && turn.sessionKey === context.sessionKey
        ? turn.privateSoleHuman === true
        : context.sessionKey?.startsWith(`agent:${context.agentId}:`) &&
            checkedSessions.has(context.sessionKey.toLowerCase())
          ? false
          : undefined;
    return privateSoleHuman === undefined
      ? undefined
      : {
          appendSystemContext: privateSoleHuman
            ? PRIVATE_SOLE_HUMAN_CONTEXT
            : NOT_PRIVATE_SOLE_HUMAN_CONTEXT,
        };
  });
  const beforeToolCall = (context: PluginHookToolContext) => {
    const matrixTurn =
      context.requester?.channel === "matrix" ||
      context.requesterContinuation?.channel === "matrix" ||
      (context.sessionKey?.includes(":matrix:") ?? false) ||
      Boolean(context.runId && turns.has(context.runId));
    if (
      !matrixTurn ||
      (SOURCE_SESSION.test(context.sessionKey ?? "") &&
        !context.requesterContinuation &&
        !(context.runId && turns.get(context.runId)?.continuation))
    ) {
      return undefined;
    }
    const runId = context.runId;
    const turn = runId ? turns.get(runId) : undefined;
    const continuation = turn?.continuation;
    let continuationCurrent = false;
    if (
      continuation &&
      context.requesterContinuation === continuation &&
      continuation.runId === runId &&
      continuation.agentId === context.agentId &&
      continuation.sessionKey === context.sessionKey &&
      continuation.sessionId === context.sessionId
    ) {
      try {
        continuation.assertCurrent();
        continuationCurrent = true;
      } catch {
        // The same identity without its original live task custody grants nothing.
      }
    }
    const requester = continuation ?? context.requester;
    const conflictingRequester =
      continuation &&
      context.requester &&
      ((context.requester.senderId !== undefined &&
        context.requester.senderId !== continuation.senderId) ||
        (context.requester.accountId !== undefined &&
          context.requester.accountId !== continuation.accountId) ||
        (context.requester.channel !== undefined &&
          context.requester.channel !== continuation.channel));
    if (
      !runId ||
      !turn ||
      turn.agentId !== context.agentId ||
      turn.sessionKey !== context.sessionKey ||
      turn.senderId !== requester?.senderId ||
      turn.accountId !== requester?.accountId ||
      (continuation && !continuationCurrent) ||
      conflictingRequester
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
    const wasPrivateSoleHuman = turn.privateSoleHuman;
    return authorize(turn, undefined, context.abortSignal).then((failure) => {
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
      if (failure) {
        return { block: true, blockReason: failure === SILENT ? DENIED : failure };
      }
      // The system prompt keeps its claim until the next build; stop and say so.
      return wasPrivateSoleHuman && !turn.privateSoleHuman
        ? { block: true, blockReason: AUDIENCE_CHANGED }
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
  return {
    beforeToolCall,
    admittedVoiceTurn,
    workbookTurn: (context: OpenClawPluginToolContext) => capture(context)?.workbookProof(),
  };
}

export type MatrixEntitlements = ReturnType<typeof registerMatrixEntitlements>;
