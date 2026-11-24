import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import {
  isTransientNetworkError,
  retryAsync,
  sleepWithAbort,
} from "openclaw/plugin-sdk/retry-runtime";
import type { PluginHookToolContext } from "openclaw/plugin-sdk/types";
import { brokerToken, configFromRuntime, matrixConnection } from "./fi-delegation.js";
import {
  UNAVAILABLE,
  DENIED,
  SILENT,
  type AuthorizationFailure,
  SOURCE_SESSION,
  AUDIENCE_CHANGED,
  type TurnAuthorship,
  MAX_CHILD_MS,
  type Turn,
  isPrivateSoleHuman,
  hasAuthorizationScope,
  isAuthorizedProof,
} from "./matrix-entitlements.policy.js";
import { SUBAGENT_RUN_REFUSAL } from "./matrix-subagent-guard.js";
import { logEntitlements, sessionThreadId, turnIds } from "./matrix-turn-origin.js";

export function createMatrixEntitlementAuthorization(
  api: OpenClawPluginApi,
  deps: {
    turns: Map<string, Turn>;
    childCurrent: (turn: Turn) => boolean;
    authorshipOf: (turn: Turn) => TurnAuthorship;
    noteChecked: (sessionKey: string) => void;
    noteAuthorship: (turn: Turn, result: object) => void;
    retireTurn: (runId: string) => void;
  },
) {
  const { turns, childCurrent, authorshipOf, noteChecked, noteAuthorship, retireTurn } = deps;
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

  // A child is never more private than its parent: the lower of the two holds.
  const parentPrivate = (turn: Turn): boolean =>
    !turn.parentRunId || turns.get(turn.parentRunId)?.privateSoleHuman === true;

  const capture = (context: OpenClawPluginToolContext) => {
    const runId = context.runId;
    const turn = runId ? turns.get(runId) : undefined;
    // A child has no message of its own: what the host names must be absent or the parent's.
    const absentOr = (value: unknown, expected: unknown) =>
      value === undefined || value === expected;
    if (
      !runId ||
      !turn?.admitted ||
      turn.settled ||
      SOURCE_SESSION.test(context.sessionKey ?? "") ||
      turn.agentId !== context.agentId ||
      turn.sessionKey !== context.sessionKey ||
      (turn.parentRunId
        ? !childCurrent(turn) ||
          turn.mode !== "text" ||
          !absentOr(context.messageChannel, "matrix") ||
          !absentOr(context.agentAccountId, turn.accountId) ||
          !absentOr(context.nativeChannelId, turn.roomId) ||
          !absentOr(context.requesterSenderId, turn.senderId) ||
          !absentOr(context.currentMessageId, turn.eventId)
        : context.messageChannel !== "matrix" ||
          turn.accountId !== context.agentAccountId ||
          turn.roomId !== context.nativeChannelId ||
          turn.senderId !== context.requesterSenderId ||
          (turn.mode === "text"
            ? turn.eventId !== context.currentMessageId
            : context.currentMessageId !== undefined ||
              sessionThreadId(turn.sessionKey) !== turn.threadRootEventId))
    ) {
      return undefined;
    }
    const assertCurrent = () => {
      turn.continuation?.assertCurrent();
      context.assertInvocationCurrent?.();
      if (
        turns.get(runId) !== turn ||
        !turn.admitted ||
        turn.settled ||
        (turn.parentRunId !== undefined && !childCurrent(turn))
      ) {
        throw new Error(UNAVAILABLE);
      }
    };
    assertCurrent();
    return Object.freeze({
      mode: turn.mode,
      /** Fi's authorship of the turn's message, read at use: tools refuse a send under a brief themselves too. */
      get authorship() {
        return authorshipOf(turn);
      },
      assertCurrent,
      workbookProof() {
        assertCurrent();
        const config = configFromRuntime(api);
        const root = sessionThreadId(turn.sessionKey);
        if (
          !hasAuthorizationScope(config, turn.agentId) ||
          (config.tenantOrgId && config.tenantOrgId !== turn.orgId) ||
          !turn.externalInput ||
          !["cellect-main", "cellect-fi-admin", "cellect-fi-user"].includes(turn.agentId) ||
          turn.mode !== "text" ||
          !root ||
          !turn.orgId
        ) {
          return undefined;
        }
        return {
          agentId: turn.agentId,
          runId,
          sessionKey: turn.sessionKey,
          roomId: turn.roomId,
          eventId: turn.eventId,
          threadRootEventId: root,
          senderMxid: turn.senderId,
          accountId: turn.accountId,
          orgId: turn.orgId,
          signal: turn.authorization.signal,
          assertCurrent() {
            assertCurrent();
            const current = configFromRuntime(api);
            if (
              !hasAuthorizationScope(current, turn.agentId) ||
              (current.tenantOrgId && current.tenantOrgId !== turn.orgId)
            ) {
              throw new Error(UNAVAILABLE);
            }
          },
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
        noteAuthorship(turn, result);
        turn.privateSoleHuman = isPrivateSoleHuman(result) && parentPrivate(turn);
        if (wasPrivateSoleHuman && !turn.privateSoleHuman) {
          throw new Error(AUDIENCE_CHANGED);
        }
        return result;
      },
    });
  };

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
      noteAuthorship(turn, result);
      turn.privateSoleHuman = isPrivateSoleHuman(result) && parentPrivate(turn);
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

  /**
   * A child of an admitted text turn acts for exactly the parent's person, room,
   * event, agent and org, which it copies and never supplies; Fi re-admits it
   * against that person's current grants. Nesting and voice parents are refused.
   */
  const admitChild = async (
    context: { runId?: string; agentId?: string; accountId?: string; sessionKey?: string },
    lineage: NonNullable<PluginHookToolContext["spawnedFrom"]>,
  ) => {
    const runId = context.runId;
    const parent = turns.get(lineage.parentRunId);
    const refuse = (reason: string) => {
      logEntitlements(
        {
          phase: "admission",
          agentId: context.agentId ?? null,
          accountId: context.accountId ?? null,
          outcome: "unavailable",
          reason: "subagent_run",
          roomId: parent?.roomId ?? null,
        },
        reason,
      );
      return { handled: true, reply: { text: SUBAGENT_RUN_REFUSAL } };
    };
    try {
      lineage.assertCurrent();
    } catch {
      if (runId) {
        retireTurn(runId);
      }
      return refuse("subagent_lineage");
    }
    if (
      !runId ||
      !context.sessionKey ||
      lineage.childRunId !== runId ||
      lineage.childSessionKey !== context.sessionKey ||
      lineage.childAgentId !== context.agentId ||
      lineage.completionTarget !== "parent" ||
      !parent?.admitted ||
      parent.parentRunId ||
      parent.mode !== "text" ||
      !parent.orgId ||
      parent.agentId !== context.agentId ||
      parent.agentId !== lineage.parentAgentId ||
      parent.sessionKey !== lineage.parentSessionKey ||
      parent.accountId !== context.accountId
    ) {
      if (runId) {
        retireTurn(runId);
      }
      return refuse("subagent_parent");
    }
    const child: Turn = {
      externalInput: false,
      admitted: false,
      authorization: new AbortController(),
      agentId: parent.agentId,
      accountId: parent.accountId,
      roomId: parent.roomId,
      mode: "text",
      eventId: parent.eventId,
      senderId: parent.senderId,
      sessionKey: context.sessionKey,
      orgId: parent.orgId,
      // A child of a brief is a brief too.
      ...(parent.authorship ? { authorship: parent.authorship } : {}),
      parentRunId: lineage.parentRunId,
      lineage,
      children: new Set(),
      expiresAt: Math.min(lineage.expiresAt, Date.now() + MAX_CHILD_MS),
    };
    retireTurn(runId);
    turns.set(runId, child);
    parent.children.add(runId);
    if (parent.pendingSpawns) {
      parent.pendingSpawns -= 1;
    }
    const failure = await authorize(child);
    if (turns.get(runId) !== child || !childCurrent(child)) {
      if (turns.get(runId) === child) {
        retireTurn(runId);
      }
      return refuse("subagent_parent");
    }
    logEntitlements({
      phase: "admission",
      roomId: child.roomId,
      agentId: child.agentId,
      accountId: child.accountId,
      mode: child.mode,
      outcome:
        failure === SILENT
          ? "silent"
          : failure
            ? failure === DENIED
              ? "denied"
              : "unavailable"
            : "admitted",
      subagent: true,
      ...turnIds(child),
    });
    if (failure) {
      retireTurn(runId);
      return {
        handled: true,
        reply: { text: failure === SILENT ? SUBAGENT_RUN_REFUSAL : failure },
      };
    }
    child.admitted = true;
    return undefined;
  };
  return { capture, authorize, admitChild };
}
