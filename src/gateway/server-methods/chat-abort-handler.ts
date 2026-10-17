import type { Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateChatAbortParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { discardSessionPendingInput } from "../../config/sessions/session-pending-input-withdrawal.js";
import type { VerifiedRunStopActor } from "../../infra/run-stop-actor.js";
import { isIncognitoSessionKey, normalizeAgentId } from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { resolveStateContentionPresentation } from "../../sessions/session-run-error-presentation.js";
import { captureWorkerInferenceForSession, createChatAbortOps } from "../chat-abort-ops.js";
import {
  abortChatRunById,
  isChatAbortControllerEntryAbortable,
  type ChatAbortControllerEntry,
} from "../chat-abort.js";
import { abortQueuedChatTurnById, isQueuedChatTurnForSession } from "../chat-queued-turns.js";
import { formatStopRequest } from "../control-plane-audit.js";
import { pendingChatSendDedupeKey, type DedupeEntry } from "../server-shared.js";
import {
  resolveRequestedSessionAgentId,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "../session-request-agent.js";
import { loadSessionEntry, resolveSessionStoreKey } from "../session-utils.js";
import { getWorkerInferenceSessionControl } from "../worker-environments/inference-control-internal.js";
import {
  createChatAbortTargetAuthorizer,
  isDetachedChatInputController,
  canRequesterAbortPreRegisteredRun,
  readPreRegisteredAgentDedupePayloadForSession,
  resolveChatAbortRequester,
  writePreRegisteredAgentAbort,
  writePreRegisteredChatAbort,
  type ChatAbortTarget,
} from "./chat-abort-authorization.js";
import {
  abortChatRunsForSessionKeyWithPartials,
  abortControlledSubagents,
  descendantAbortError,
} from "./chat-abort-runtime.js";
import {
  abortedPartialPersistenceError,
  captureAbortedPartial,
  deferAbortedPartialPersistence,
  withAbortedPartialPersistenceWarning,
} from "./chat-aborted-partial.js";
import { persistAbortedPartials } from "./chat-transcript-persistence.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { assertValidParams } from "./validation.js";

type ChatAbortLifecycle = {
  preservePendingInputs?: true;
  stopActor?: VerifiedRunStopActor;
  onAuthorizedAfterQueuedAbort?: () => boolean;
  onDescendantsCancelled?: () => void;
  cascadeDescendants?: true;
};

export async function handleChatAbortRequestWithLifecycle(
  options: GatewayRequestHandlerOptions,
  lifecycle: ChatAbortLifecycle = {},
): Promise<void> {
  const { params, respond, context, client, sessionMutationAuthorization } = options;
  const authority = readGatewayRequestMutationAuthority(options);
  const requester = resolveChatAbortRequester(client, sessionMutationAuthorization);
  const assertCurrent = () => {
    authority.assertCurrent();
    sessionMutationAuthorization?.assertCurrent();
    requester.sessionAuthority?.assertCurrent();
  };
  if (!assertValidParams(params, validateChatAbortParams, "chat.abort", respond)) {
    return;
  }
  const { sessionKey: rawSessionKey, runId, preserveSideRuns, discardPendingInput } = params;
  if (discardPendingInput && !runId) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "discardPendingInput requires an exact runId"),
    );
    return;
  }
  const agentIdOverride = normalizeOptionalString(params.agentId);
  const abortCfg = context.getRuntimeConfig();
  const parsedAbortSessionKey = parseAgentSessionKey(rawSessionKey);
  const compatibilityDefaultAgentId = tryResolveSessionCompatibilityOwnerAgentId(
    abortCfg,
    rawSessionKey,
  );
  const inferredSessionAgentId =
    !agentIdOverride && parsedAbortSessionKey
      ? normalizeAgentId(parsedAbortSessionKey.agentId)
      : undefined;
  const bareSessionAgentResolution = !parsedAbortSessionKey
    ? resolveRequestedSessionAgentId(abortCfg, rawSessionKey, agentIdOverride)
    : undefined;
  if (bareSessionAgentResolution && !bareSessionAgentResolution.ok) {
    respond(false, undefined, bareSessionAgentResolution.error);
    return;
  }
  const abortAgentId = parsedAbortSessionKey
    ? (agentIdOverride ?? inferredSessionAgentId)
    : bareSessionAgentResolution?.agentId;
  if (!abortAgentId) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        rawSessionKey.trim().toLowerCase() === "global"
          ? "agentId is required for global chat.abort when no compatibility owner exists"
          : "agentId is required for unscoped chat.abort when no compatibility owner exists",
      ),
    );
    return;
  }
  if (
    agentIdOverride &&
    parsedAbortSessionKey &&
    normalizeAgentId(parsedAbortSessionKey.agentId) !== normalizeAgentId(agentIdOverride)
  ) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `agentId "${agentIdOverride}" does not match session key "${rawSessionKey}"`,
      ),
    );
    return;
  }
  const canonicalAbortSessionKey = resolveSessionStoreKey({
    cfg: abortCfg,
    sessionKey: rawSessionKey,
    storeAgentId: abortAgentId,
  });
  if (discardPendingInput && isIncognitoSessionKey(canonicalAbortSessionKey)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Removing accepted queued input is unavailable in incognito sessions. Use Stop to cancel it.",
      ),
    );
    return;
  }
  const narrow =
    authority.sessionScope === "operator.sessions.write" ||
    requester.sessionAuthority !== undefined;
  const admittedTarget = sessionMutationAuthorization?.admittedTarget;
  if (
    narrow &&
    (!admittedTarget?.sessionId.trim() ||
      admittedTarget.sessionKey !== canonicalAbortSessionKey ||
      admittedTarget.agentId !== normalizeAgentId(abortAgentId))
  ) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "session target is unavailable"),
    );
    return;
  }
  const requiredSessionId = narrow ? admittedTarget?.sessionId : undefined;
  const ops = createChatAbortOps(context);

  const abortSession: Result<ReturnType<typeof loadSessionEntry>, unknown> = (() => {
    try {
      return {
        ok: true,
        value: loadSessionEntry(canonicalAbortSessionKey, { agentId: abortAgentId }),
      };
    } catch (error) {
      return { ok: false, error };
    }
  })();
  const abortSessionEntry = abortSession.ok ? abortSession.value.entry : undefined;
  if (!runId) {
    const res = await abortChatRunsForSessionKeyWithPartials({
      context,
      ops,
      sessionKey: canonicalAbortSessionKey,
      sessionKeyAliases: canonicalAbortSessionKey === rawSessionKey ? undefined : [rawSessionKey],
      agentId: abortAgentId,
      sessionId: abortSessionEntry?.sessionId,
      requiredSessionId,
      session: abortSession,
      defaultAgentId: compatibilityDefaultAgentId,
      abortOrigin: "rpc",
      stopReason: "rpc",
      stopActor: lifecycle.stopActor,
      preservePendingInputs: lifecycle.preservePendingInputs,
      requester,
      assertCurrent,
      preserveSideRuns,
      onAuthorizedAfterQueuedAbort: lifecycle.onAuthorizedAfterQueuedAbort,
      cascadeDescendants: lifecycle.cascadeDescendants,
    });
    if (res.unauthorized) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
      return;
    }
    if (res.descendants?.killed) {
      lifecycle.onDescendantsCancelled?.();
    }
    const error = res.error ?? descendantAbortError(res.descendants, "Session");
    if (error) {
      respond(false, undefined, withAbortedPartialPersistenceWarning(error, res.warning));
      return;
    }
    respond(true, {
      ok: true,
      aborted: res.aborted,
      runIds: res.runIds,
      ...(res.warning ? { warning: res.warning } : {}),
    });
    return;
  }
  const authorizeRunTarget = createChatAbortTargetAuthorizer({
    requester,
    respond,
    discardPendingInput,
    narrow,
    requiredSessionId,
    rawSessionKey,
    canonicalAbortSessionKey,
    abortAgentId,
    compatibilityDefaultAgentId,
  });

  const capturedActive = context.chatAbortControllers.get(runId);
  const active =
    lifecycle.preservePendingInputs &&
    capturedActive &&
    isDetachedChatInputController(context, runId, capturedActive)
      ? undefined
      : capturedActive;
  const withdrawalQueue = discardPendingInput ? context.chatQueuedTurns.get(runId) : undefined;
  const withdrawalScope = withdrawalQueue && {
    sessionKey: withdrawalQueue.sessionKey,
    sessionId: withdrawalQueue.sessionId,
    agentId: withdrawalQueue.agentId,
  };
  const ownsWithdrawalQueue = () =>
    Boolean(
      withdrawalQueue &&
      withdrawalScope &&
      context.chatQueuedTurns.get(runId) === withdrawalQueue &&
      isQueuedChatTurnForSession(context.chatQueuedTurns, runId, withdrawalScope),
    );
  if (discardPendingInput) {
    if (
      (active && !authorizeRunTarget(active)) ||
      (withdrawalQueue && !authorizeRunTarget(withdrawalQueue))
    ) {
      return;
    }
    if (!ownsWithdrawalQueue() || (active && withdrawalQueue?.controller !== active.controller)) {
      respond(true, { ok: true, aborted: false, runIds: [] });
      return;
    }
  }
  const workerTarget = getWorkerInferenceSessionControl(
    context.workerEnvironmentService,
  )?.resolveSessionTargetForRunId(runId);
  // Broad same-device Stop can name an active run on another session. Capture
  // that original producer's SID before descendant or transcript work yields.
  const workerCancellation = captureWorkerInferenceForSession({
    context,
    sessionId: active?.sessionId ?? workerTarget?.sessionId ?? abortSessionEntry?.sessionId,
    runId,
  });
  let inputWithdrawn = false;
  const holdPendingInputWithdrawal = (controller: AbortController) => {
    if (!discardPendingInput) {
      return undefined;
    }
    const queued = withdrawalQueue?.controller === controller ? withdrawalQueue : undefined;
    const activeTarget = active && {
      entry: active,
      sessionKey: active.sessionKey,
      sessionId: active.sessionId,
      agentId: active.agentId,
    };
    const queuedTarget = queued && {
      entry: queued,
      sessionKey: queued.sessionKey,
      sessionId: queued.sessionId,
      agentId: queued.agentId,
    };
    const release = queued?.holdPendingInputWithdrawal?.();
    if (!queued || !release) {
      throw new Error("Queued input is already starting; refresh before removing it.");
    }
    return () => {
      try {
        // Native commitment owns cancellation even if the requester expires or active custody retires.
        if (!inputWithdrawn || controller.signal.aborted) {
          return;
        }
        if (
          activeTarget &&
          context.chatAbortControllers.get(runId) === activeTarget.entry &&
          activeTarget.entry.controller === controller &&
          activeTarget.entry.sessionKey === activeTarget.sessionKey &&
          activeTarget.entry.sessionId === activeTarget.sessionId &&
          activeTarget.entry.agentId === activeTarget.agentId
        ) {
          abortChatRunById(ops, {
            runId,
            sessionKey: activeTarget.sessionKey,
            stopReason: "rpc",
            stopActor: lifecycle.stopActor,
          });
        }
        if (
          !controller.signal.aborted &&
          queuedTarget &&
          context.chatQueuedTurns.get(runId) === queuedTarget.entry &&
          queuedTarget.entry.controller === controller &&
          queuedTarget.entry.sessionKey === queuedTarget.sessionKey &&
          queuedTarget.entry.sessionId === queuedTarget.sessionId &&
          queuedTarget.entry.agentId === queuedTarget.agentId
        ) {
          abortQueuedChatTurnById(context.chatQueuedTurns, {
            runId,
            sessionKey: queuedTarget.sessionKey,
            stopReason: "rpc",
            stopActor: lifecycle.stopActor,
          });
        }
      } finally {
        release?.();
      }
    };
  };
  const discardBeforeAbort = async (target: ChatAbortTarget, ownsTarget: () => boolean) => {
    if (!abortSession.ok) {
      throw abortSession.error;
    }
    const captured = {
      agentId: target.agentId ?? abortAgentId,
      sessionKey: target.sessionKey,
      sessionId: target.sessionId,
      storePath: abortSession.value.storePath,
    };
    inputWithdrawn = await discardSessionPendingInput(captured, runId, () => {
      assertCurrent();
      if (!ownsTarget()) {
        throw new Error("Run changed before input removal; refresh and retry.");
      }
    });
    if (inputWithdrawn) {
      emitSessionsChanged(
        context,
        {
          sessionKey: captured.sessionKey,
          sessionId: captured.sessionId,
          agentId: captured.agentId,
          reason: "agent.input.settled",
        },
        { accessChanged: false },
      );
    }
  };
  const respondWithWorkerRuns = async (localRunIds: string[], warning?: string): Promise<void> => {
    const runIds = new Set(localRunIds);
    if (inputWithdrawn) {
      runIds.add(runId);
    }
    if (requester.isAdmin && (!lifecycle.preservePendingInputs || localRunIds.length > 0)) {
      assertCurrent();
      await workerCancellation?.cancel({
        assertCurrent,
        onCancelled: (id) => runIds.add(id),
      });
    }
    if (!abortSession.ok) {
      throw abortSession.error;
    }
    respond(true, {
      ok: true,
      aborted: runIds.size > 0,
      runIds: [...runIds],
      ...(warning ? { warning } : {}),
    });
  };
  if (!active) {
    const readPendingRunForAbort = (entry: DedupeEntry | undefined) => {
      for (const sessionKey of new Set([canonicalAbortSessionKey, rawSessionKey])) {
        const payload = readPreRegisteredAgentDedupePayloadForSession({
          entry,
          runId,
          sessionKey,
          agentId: abortAgentId,
          defaultAgentId: compatibilityDefaultAgentId,
          requiredSessionId,
        });
        if (payload) {
          return {
            sessionKey: normalizeOptionalString(payload.sessionKey) ? sessionKey : undefined,
            payload,
          };
        }
      }
      return undefined;
    };
    const pendingChatMatch =
      !lifecycle.preservePendingInputs &&
      !discardPendingInput &&
      readPendingRunForAbort(context.dedupe.get(pendingChatSendDedupeKey(runId)));
    if (pendingChatMatch) {
      if (!canRequesterAbortPreRegisteredRun(pendingChatMatch.payload, requester)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
        return;
      }
      assertCurrent();
      const aborted = writePreRegisteredChatAbort({
        context,
        runId,
        stopReason: "rpc",
        stopActor: lifecycle.stopActor,
        attemptId: normalizeOptionalString(pendingChatMatch.payload.attemptId),
        expectedPayload: pendingChatMatch.payload,
      });
      await respondWithWorkerRuns(aborted ? [runId] : []);
      return;
    }
    const pendingAgentEntry = context.dedupe.get(`agent:${runId}`);
    const pendingAgentMatch =
      !lifecycle.preservePendingInputs &&
      !discardPendingInput &&
      readPendingRunForAbort(pendingAgentEntry);
    if (pendingAgentMatch) {
      const pendingAgentPayload = pendingAgentMatch.payload;
      if (!canRequesterAbortPreRegisteredRun(pendingAgentPayload, requester)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
        return;
      }
      let aborted = false;
      const descendants = await abortControlledSubagents({
        cfg: abortCfg,
        sessionKey: pendingAgentMatch.sessionKey ?? canonicalAbortSessionKey,
        agentId: abortAgentId,
        requesterTurnRunId: runId,
        preservePendingInputs: lifecycle.preservePendingInputs,
        assertCurrent,
        beforeKill: () => {
          assertCurrent();
          return (aborted = writePreRegisteredAgentAbort({
            context,
            runId,
            sessionKey: pendingAgentMatch.sessionKey,
            payload: pendingAgentPayload,
            expectedPayload: pendingAgentPayload,
            stopReason: "rpc",
            stopActor: lifecycle.stopActor,
          }));
        },
      });
      const error = descendantAbortError(descendants, "Parent run");
      if (error) {
        respond(false, undefined, error);
        return;
      }
      await respondWithWorkerRuns(aborted ? [runId] : []);
      return;
    }
    // Queued followup/collect turns keep a cancel identity after chat.send
    // terminalizes; abort them here so Esc cannot report done while they run.
    const chatQueuedTurns = context.chatQueuedTurns;
    const queued = !lifecycle.preservePendingInputs ? chatQueuedTurns.get(runId) : undefined;
    if (queued) {
      if (!discardPendingInput && !authorizeRunTarget(queued)) {
        return;
      }
      const { sessionKey, sessionId, agentId } = queued;
      const ownsTarget = () =>
        chatQueuedTurns.get(runId) === queued &&
        isQueuedChatTurnForSession(chatQueuedTurns, runId, { sessionKey, sessionId, agentId });
      const releaseWithdrawal = holdPendingInputWithdrawal(queued.controller);
      try {
        if (discardPendingInput) {
          await discardBeforeAbort(queued, ownsTarget);
          if (!inputWithdrawn) {
            respond(true, { ok: true, aborted: false, runIds: [] });
            return;
          }
        }
        assertCurrent();
        if (discardPendingInput && !ownsTarget()) {
          await respondWithWorkerRuns([]);
          return;
        }
        if (
          chatQueuedTurns.get(runId) !== queued ||
          queued.sessionKey !== sessionKey ||
          queued.sessionId !== sessionId ||
          queued.agentId !== agentId
        ) {
          throw new Error("Run changed before cancellation; retry Stop.");
        }
        const queuedRes = abortQueuedChatTurnById(chatQueuedTurns, {
          runId,
          sessionKey: queued.sessionKey,
          stopReason: "rpc",
          stopActor: lifecycle.stopActor,
          allowSessionMismatch: true,
        });
        await respondWithWorkerRuns(queuedRes.aborted ? [runId] : []);
      } finally {
        releaseWithdrawal?.();
      }
      return;
    }
    if (!workerCancellation?.runIds.length) {
      if (!abortSession.ok) {
        throw abortSession.error;
      }
      respond(true, { ok: true, aborted: false, runIds: [] });
      return;
    }
    if (!requester.isAdmin) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
      return;
    }
    await respondWithWorkerRuns([]);
    return;
  }
  if (!discardPendingInput && !authorizeRunTarget(active)) {
    return;
  }
  let aborted = false;
  const { sessionKey, sessionId, agentId, controlUiVisible } = active;
  const ownsTarget = () =>
    context.chatAbortControllers.get(runId) === active &&
    active.sessionKey === sessionKey &&
    active.sessionId === sessionId &&
    active.agentId === agentId &&
    isChatAbortControllerEntryAbortable(active) &&
    (!discardPendingInput || ownsWithdrawalQueue());
  const releaseWithdrawal = holdPendingInputWithdrawal(active.controller);
  try {
    if (discardPendingInput) {
      await discardBeforeAbort(active, ownsTarget);
      if (!inputWithdrawn) {
        respond(true, { ok: true, aborted: false, runIds: [] });
        return;
      }
    }
    assertCurrent();
    if (discardPendingInput && !ownsTarget()) {
      await respondWithWorkerRuns([]);
      return;
    }
    const partialText = context.chatRunState.resolveBuffer(runId, { final: true }).text;
    const snapshot =
      controlUiVisible !== false && partialText?.trim()
        ? captureAbortedPartial({
            runId,
            sessionKey,
            sessionId,
            agentId: agentId ?? abortAgentId,
            text: partialText,
            abortOrigin: "rpc",
            resolveTerminalProducer: active.resolveTerminalProducer,
            ...(sessionKey === rawSessionKey || sessionKey === canonicalAbortSessionKey
              ? { session: abortSession }
              : {}),
          })
        : undefined;
    let descendants: Awaited<ReturnType<typeof abortControlledSubagents>>;
    let failure: { error: unknown } | undefined;
    let warning: string | undefined;
    try {
      descendants = await abortControlledSubagents({
        cfg: abortCfg,
        sessionKey,
        agentId,
        requesterTurnRunId: runId,
        preservePendingInputs: lifecycle.preservePendingInputs,
        assertCurrent,
        beforeKill: () => {
          // The descendant owner can await a reservation even when no child survives.
          assertCurrent();
          if (
            context.chatAbortControllers.get(runId) !== active ||
            active.sessionKey !== sessionKey ||
            active.sessionId !== sessionId ||
            active.agentId !== agentId
          ) {
            if (inputWithdrawn) {
              return false;
            }
            throw new Error("Run changed before cancellation; retry Stop.");
          }
          return abortChatRunById(ops, {
            runId,
            sessionKey,
            stopReason: "rpc",
            stopActor: lifecycle.stopActor,
            onAbortCommitted: () => {
              aborted = true;
              deferAbortedPartialPersistence(snapshot, context);
            },
          }).aborted;
        },
      });
    } catch (error) {
      failure = { error };
    }
    // A later child fence can reject after the parent consumed its buffer. The
    // transcript owner must still settle that already-committed cancellation.
    if (aborted && snapshot) {
      try {
        warning = await persistAbortedPartials({ context, snapshots: [snapshot] });
      } catch (error) {
        if (failure) {
          throw new AggregateError(
            [failure.error, error],
            "Chat cancellation and persistence failed",
            { cause: error },
          );
        }
        throw error;
      }
    }
    if (failure) {
      throw abortedPartialPersistenceError(failure.error, warning);
    }
    if (!abortSession.ok) {
      throw abortedPartialPersistenceError(abortSession.error, warning);
    }
    const descendantError = descendantAbortError(descendants, "Parent run");
    if (descendantError) {
      respond(false, undefined, withAbortedPartialPersistenceWarning(descendantError, warning));
      return;
    }
    try {
      await respondWithWorkerRuns(aborted ? [runId] : [], warning);
    } catch (error) {
      throw abortedPartialPersistenceError(error, warning);
    }
  } finally {
    releaseWithdrawal?.();
  }
}

export async function handleChatAbortRequest(options: GatewayRequestHandlerOptions): Promise<void> {
  if (validateChatAbortParams(options.params)) {
    options.context.logGateway.info(
      formatStopRequest("chat.abort", options.client, options.params),
    );
  }
  try {
    await handleChatAbortRequestWithLifecycle(options);
  } catch (error) {
    const contention = resolveStateContentionPresentation(error);
    if (!contention) {
      throw error;
    }
    // A session read can fail even though cancellation takes effect. Do not
    // replay Stop or claim it had no effect; preserve uncertainty at the RPC boundary.
    options.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        "The server is busy. Check this turn's status before trying Stop again.\n\n" +
          "SQLite transaction admission remained busy. Stopping may already have taken effect.",
        { details: { errorKind: contention.errorKind } },
      ),
    );
  }
}
