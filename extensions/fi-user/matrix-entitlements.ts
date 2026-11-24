import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import type { PluginHookToolContext } from "openclaw/plugin-sdk/types";
import { configFromRuntime, isAdminAgent, registerDelegationTurnSource } from "./fi-delegation.js";
import { createMatrixEntitlementAuthorization } from "./matrix-entitlements.authorization.js";
import {
  UNAVAILABLE,
  DENIED,
  SILENT,
  SOURCE_SESSION,
  PRIVATE_SOLE_HUMAN_CONTEXT,
  NOT_PRIVATE_SOLE_HUMAN_CONTEXT,
  MAX_CHECKED_SESSIONS,
  type TurnAuthorship,
  DESK_BRIEF_CONTEXT,
  PERSON_AFTER_BRIEF_CONTEXT,
  DESK_BRIEF_TOOL_REFUSAL,
  type Turn,
  isBrief,
  briefAllowed,
} from "./matrix-entitlements.policy.js";
import { createMatrixEntitlementToolGate } from "./matrix-entitlements.tool-gate.js";
import { createMatrixEntitlementTurnCustody } from "./matrix-entitlements.turns.js";
import {
  isSubagentSession,
  SUBAGENT_RUN_REFUSAL,
  type SpawnParent,
} from "./matrix-subagent-guard.js";
import {
  hostChatMatchesRoom,
  logEntitlements,
  sessionThreadId,
  turnIds,
} from "./matrix-turn-origin.js";

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
  /**
   * Text events Fi answered as a Desk brief. A continuation or child that
   * re-admits the same event stays a brief whatever a later answer says.
   */
  const briefEvents = new Map<string, TurnAuthorship>();
  /** Sessions that saw a brief, so a later person's turn withdraws its notice. */
  const briefSessions = new Set<string>();
  /**
   * Rooms known to be Desk task rooms, by account: Fi said `deskTaskRoom: true`
   * on an admission there, or Fi answered a brief there. Briefs arrive in them.
   */
  const deskTaskRooms = new Set<string>();

  /**
   * The event a run's delegation mints are for: a typed turn's own event, a
   * child's or continuation's source event. A voice turn has none.
   */
  const {
    roomKey,
    remember,
    authorshipOf,
    markBrief,
    noteAuthorship,
    retireTurn,
    settleTurn,
    childCurrent,
    retireAll,
  } = createMatrixEntitlementTurnCustody(turns, briefEvents, deskTaskRooms);
  registerDelegationTurnSource(api, (context) => {
    const turn = context.runId ? turns.get(context.runId) : undefined;
    if (
      !turn?.admitted ||
      turn.settled ||
      turn.mode !== "text" ||
      turn.agentId !== context.agentId ||
      turn.sessionKey !== context.sessionKey
    ) {
      return undefined;
    }
    return {
      roomId: turn.roomId,
      eventId: turn.eventId,
      senderId: turn.senderId,
      markBrief: () =>
        markBrief(
          turn,
          Object.freeze({ kind: "desk_handoff", writtenBy: "agent", deskConversationId: "" }),
        ),
    };
  });

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
        settleTurn(event.runId);
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
      briefEvents.clear();
      deskTaskRooms.clear();
      briefSessions.clear();
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

  const { capture, authorize, admitChild } = createMatrixEntitlementAuthorization(api, {
    turns,
    childCurrent,
    authorshipOf,
    noteChecked,
    noteAuthorship,
    retireTurn,
  });
  const turnRuntime = api.runtime.channel.runtimeContexts.register({
    channelId: "matrix",
    capability: "fi-admitted-turn",
    context: { protocol: "fi-matrix-turn-v1", capture },
  });

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
            !turn.parentRunId &&
            !turn.settled &&
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

  /**
   * A child descends from a Matrix turn when the host recorded its parent's
   * channel as Matrix, or its lineage names a turn this gate admitted. Such a
   * child is gated whatever channel its own run carries: a collector, for one,
   * runs with none.
   */
  const matrixChild = (context: {
    sessionKey?: string;
    spawnedFrom?: { parentRunId: string };
    spawnedFromChannel?: string;
  }): boolean =>
    isSubagentSession(context.sessionKey) &&
    (context.spawnedFromChannel === "matrix" ||
      (context.spawnedFrom !== undefined && turns.has(context.spawnedFrom.parentRunId)));
  api.on(
    "before_agent_reply",
    async (_event, context) => {
      if (matrixChild(context)) {
        if (context.spawnedFrom && !context.requesterContinuation) {
          return admitChild(context, context.spawnedFrom);
        }
        if (context.runId) {
          retireTurn(context.runId);
        }
        logEntitlements(
          {
            phase: "admission",
            agentId: context.agentId ?? null,
            accountId: context.accountId ?? null,
            outcome: "unavailable",
            reason: "subagent_run",
          },
          "subagent_unbound",
        );
        return { handled: true, reply: { text: SUBAGENT_RUN_REFUSAL } };
      }
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
      if (
        !context.requesterContinuation &&
        context.inputProvenance?.kind === "inter_session" &&
        context.inputProvenance.sourceTool === "subagent_announce" &&
        isSubagentSession(context.inputProvenance.sourceSessionKey)
      ) {
        // A child's private result for a parent that settled without yielding:
        // no person's message stands behind it and it must not reach the room.
        if (context.runId) {
          retireTurn(context.runId);
        }
        logEntitlements({
          phase: "admission",
          agentId: context.agentId ?? null,
          accountId: context.accountId ?? null,
          outcome: "silent",
          reason: "orphan_subagent_completion",
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
        if (isSubagentSession(context.sessionKey)) {
          // Not an outage: no person's message stands behind a sub-agent run.
          logEntitlements(
            {
              phase: "admission",
              agentId: context.agentId ?? null,
              accountId: context.accountId ?? null,
              outcome: "unavailable",
              reason: "subagent_run",
              roomId: typeof roomId === "string" ? roomId : null,
              eventId: typeof eventId === "string" ? eventId : null,
              chatMatches,
              senderMatches,
            },
            "subagent_run",
          );
          return { handled: true, reply: { text: SUBAGENT_RUN_REFUSAL } };
        }
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
        workspaceDir: context.workspaceDir,
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
        children: new Set(),
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
    const current =
      turn?.admitted && turn.agentId === context.agentId && turn.sessionKey === context.sessionKey;
    let authorshipContext: string | undefined;
    if (current) {
      const session = turn.sessionKey.toLowerCase();
      if (isBrief(authorshipOf(turn))) {
        remember(briefSessions, session);
        authorshipContext = DESK_BRIEF_CONTEXT;
      } else if (briefSessions.has(session)) {
        briefSessions.delete(session);
        authorshipContext = PERSON_AFTER_BRIEF_CONTEXT;
      }
    }
    const privateSoleHuman = current
      ? turn.privateSoleHuman === true
      : context.sessionKey?.startsWith(`agent:${context.agentId}:`) &&
          checkedSessions.has(context.sessionKey.toLowerCase())
        ? false
        : undefined;
    const parts = [
      privateSoleHuman === undefined
        ? undefined
        : privateSoleHuman
          ? PRIVATE_SOLE_HUMAN_CONTEXT
          : NOT_PRIVATE_SOLE_HUMAN_CONTEXT,
      authorshipContext,
    ].filter((part): part is string => Boolean(part));
    return parts.length ? { appendSystemContext: parts.join("\n\n") } : undefined;
  });
  /**
   * A Desk brief is not the person's approval: refuse what would send, sign or
   * deliver from it. Their own next message is a new event Fi answers as theirs.
   */
  const briefToolBlock = (
    event: { toolName: string; params?: Record<string, unknown> },
    context: Pick<PluginHookToolContext, "runId" | "agentId">,
  ) => {
    const turn = context.runId ? turns.get(context.runId) : undefined;
    if (
      !turn ||
      !isBrief(authorshipOf(turn)) ||
      briefAllowed(
        event.toolName,
        event.params ?? {},
        turn,
        isAdminAgent(configFromRuntime(api), turn.agentId),
      )
    ) {
      return undefined;
    }
    logEntitlements({
      phase: "tool",
      roomId: turn.roomId,
      agentId: turn.agentId,
      accountId: turn.accountId,
      mode: turn.mode,
      outcome: "blocked",
      reason: "desk_brief",
      toolName: event.toolName,
      ...turnIds(turn),
    });
    return { block: true as const, blockReason: DESK_BRIEF_TOOL_REFUSAL };
  };
  /** Whether this run answers a Desk brief: it then gets no delegated Fi credential either. */
  const briefRun = (context: Pick<PluginHookToolContext, "runId">): boolean => {
    const turn = context.runId ? turns.get(context.runId) : undefined;
    return turn !== undefined && isBrief(authorshipOf(turn));
  };
  /**
   * Whether a Matrix message arriving while a gated turn is live in its session
   * must be queued as its own turn instead of steered into that run. Fi decides
   * authorship per event, so a message injected into another event's run would
   * take that run's authorship: a brief would act under a person's turn, and the
   * person's own follow-up would be held under a brief's. Queued, each message is
   * admitted and judged by Fi on its own. Only where a brief can be in play: the
   * live turn is a brief, or its room is a Desk task room.
   */
  const steerQueue = (message: {
    channel?: string;
    sessionKey?: string;
    channelContext?: { chat?: object };
  }): boolean => {
    const chat = message.channelContext?.chat;
    const sessionKey = message.sessionKey?.toLowerCase();
    // A Talk consult stands on its own voice proof and joins its voice turn.
    if (
      message.channel !== "matrix" ||
      !sessionKey ||
      (chat && "talkThreadRootEventId" in chat && chat.talkThreadRootEventId !== undefined)
    ) {
      return false;
    }
    // Only a typed turn is judged per event; a live voice turn is never one to queue behind.
    // Only where a brief is in play: the live turn is one, or briefs arrive in its room.
    // An ordinary conversation keeps normal steering.
    for (const turn of turns.values()) {
      if (
        !turn.parentRunId &&
        !turn.settled &&
        turn.mode === "text" &&
        turn.sessionKey.toLowerCase() === sessionKey &&
        // Fail closed while Fi is still answering for the turn: its authorship is not known yet.
        (!turn.admitted || isBrief(authorshipOf(turn)) || deskTaskRooms.has(roomKey(turn)))
      ) {
        return true;
      }
    }
    return false;
  };

  const { beforeToolCall } = createMatrixEntitlementToolGate({
    turns,
    childCurrent,
    matrixChild,
    authorize,
    retireTurn,
  });
  // A spawn Fi allowed but the host did not accept leaves no child to wait for.
  api.on("after_tool_call", (event, context) => {
    const runId = event.runId ?? context.runId;
    const turn = runId ? turns.get(runId) : undefined;
    if (event.toolName !== "sessions_spawn" || !runId || !turn?.pendingSpawns) {
      return;
    }
    const result = event.result;
    const details =
      result && typeof result === "object" && "details" in result ? result.details : undefined;
    const accepted =
      !event.error &&
      details !== null &&
      typeof details === "object" &&
      "status" in details &&
      details.status === "accepted";
    if (!accepted) {
      turn.pendingSpawns -= 1;
      if (turn.settled && !turn.pendingSpawns && !turn.children.size) {
        retireTurn(runId);
      }
    }
  });
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
      !turn.parentRunId &&
      !turn.settled &&
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
  /** What a spawn's caller is, for the sub-agent guard: admitted text or voice turn, or child. */
  const spawnParent = (
    context: Pick<PluginHookToolContext, "runId" | "agentId" | "sessionKey">,
  ): SpawnParent => {
    const turn = context.runId ? turns.get(context.runId) : undefined;
    if (
      !turn?.admitted ||
      turn.settled ||
      turn.agentId !== context.agentId ||
      turn.sessionKey !== context.sessionKey
    ) {
      return undefined;
    }
    return turn.parentRunId ? "child" : turn.mode;
  };
  return {
    beforeToolCall,
    briefToolBlock,
    briefRun,
    steerQueue,
    spawnParent,
    admittedVoiceTurn,
    admittedOperatorCommand: (context: PluginHookToolContext) => {
      const turn = context.runId ? turns.get(context.runId) : undefined;
      const config = configFromRuntime(api);
      return config.operatorAgentId === "cellect-main" &&
        !config.tenantOrgId &&
        !config.tenantOrgConflict &&
        turn?.admitted &&
        !turn.parentRunId &&
        !turn.settled &&
        turn.externalInput &&
        turn.mode === "text" &&
        turn.orgId &&
        turn.workspaceDir &&
        !turn.continuation &&
        sessionThreadId(turn.sessionKey) &&
        !context.abortSignal?.aborted &&
        turn.agentId === "cellect-main" &&
        context.agentId === turn.agentId &&
        turn.sessionKey === context.sessionKey &&
        context.requester?.channel === "matrix" &&
        context.requester.senderId === turn.senderId &&
        context.requester.accountId === turn.accountId
        ? turn
        : undefined;
    },
    workbookTurn: (context: OpenClawPluginToolContext) => capture(context)?.workbookProof(),
  };
}

export type MatrixEntitlements = ReturnType<typeof registerMatrixEntitlements>;

export {
  type TurnAuthorship,
  DESK_BRIEF_TOOL_REFUSAL,
  assertNotDeskBrief,
} from "./matrix-entitlements.policy.js";
