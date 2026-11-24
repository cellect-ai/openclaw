import type { PluginHookToolContext } from "openclaw/plugin-sdk/types";
import { createMatrixEntitlementAuthorization } from "./matrix-entitlements.authorization.js";
import {
  UNAVAILABLE,
  DENIED,
  SILENT,
  SOURCE_SESSION,
  AUDIENCE_CHANGED,
  type Turn,
} from "./matrix-entitlements.policy.js";
import { SUBAGENT_RUN_REFUSAL } from "./matrix-subagent-guard.js";
import { logEntitlements, sessionThreadId, turnIds } from "./matrix-turn-origin.js";

export function createMatrixEntitlementToolGate(deps: {
  turns: Map<string, Turn>;
  childCurrent: (turn: Turn) => boolean;
  matrixChild: (context: PluginHookToolContext) => boolean;
  authorize: ReturnType<typeof createMatrixEntitlementAuthorization>["authorize"];
  retireTurn: (runId: string) => void;
}) {
  const { turns, childCurrent, matrixChild, authorize, retireTurn } = deps;
  const beforeToolCall = (context: PluginHookToolContext) => {
    if (matrixChild(context) && !(context.runId && turns.get(context.runId)?.parentRunId)) {
      logEntitlements(
        {
          phase: "tool",
          agentId: context.agentId ?? null,
          outcome: "unavailable",
          reason: "no_admission",
        },
        "subagent_unbound",
      );
      return { block: true, blockReason: SUBAGENT_RUN_REFUSAL };
    }
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
    const lineage = context.spawnedFrom;
    if (
      !runId ||
      !turn ||
      turn.settled ||
      turn.agentId !== context.agentId ||
      turn.sessionKey !== context.sessionKey ||
      (turn.parentRunId
        ? !childCurrent(turn) ||
          context.requesterContinuation !== undefined ||
          lineage?.childRunId !== runId ||
          lineage.childSessionKey !== context.sessionKey ||
          (context.requester?.senderId !== undefined &&
            context.requester.senderId !== turn.senderId) ||
          (context.requester?.accountId !== undefined &&
            context.requester.accountId !== turn.accountId)
        : turn.senderId !== requester?.senderId ||
          turn.accountId !== requester?.accountId ||
          (continuation && !continuationCurrent) ||
          conflictingRequester)
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
      if (
        turns.get(runId) !== turn ||
        context.abortSignal?.aborted ||
        (turn.parentRunId !== undefined && !childCurrent(turn))
      ) {
        return { block: true, blockReason: UNAVAILABLE };
      }
      turn.admitted = !failure;
      if (failure === DENIED) {
        // Fi withdrew this person's access: no child of this turn may go on.
        for (const child of turn.children) {
          retireTurn(child);
        }
      }
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
      if (wasPrivateSoleHuman && !turn.privateSoleHuman) {
        return { block: true, blockReason: AUDIENCE_CHANGED };
      }
      if (context.toolName === "sessions_spawn" && !turn.parentRunId) {
        // Its child may start after this turn settles; keep custody for it until then.
        turn.pendingSpawns = (turn.pendingSpawns ?? 0) + 1;
      }
      return undefined;
    });
  };
  return { beforeToolCall };
}
