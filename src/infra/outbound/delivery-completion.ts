import { randomUUID } from "node:crypto";
import { notifyNativeFinalDeliveryChanged } from "../../auto-reply/reply/native-final-delivery.js";
import { resolveMessageReceiptPrimaryId } from "../../channels/message/receipt.js";
import {
  ConversationDeliveryMissingError,
  markConversationDeliveryQueued,
  markConversationDeliveryRejected,
  markConversationDeliverySent,
  markConversationDeliverySuppressed,
  markConversationDeliveryUnknown,
  type ConversationDeliveryRecord,
} from "../../config/sessions/conversation-delivery-store.js";
import type {
  ConversationRegistryScope,
  PreparedConversationRegistryScope,
} from "../../config/sessions/conversation-registry.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type {
  SessionActorDeliveryEvidence,
  SessionActorAuthority,
} from "../../config/sessions/session-actor-contract.js";
import {
  runSessionActorCommand,
  withSessionActor,
} from "../../config/sessions/session-actor-scope.js";
import type { PendingFinalDeliverySettlementInput } from "../../config/sessions/session-pending-final-settlement.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  isSameOpenClawAgentDatabasePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import {
  resolveDeliveryQueueStateEnv,
  type DeliveryQueueStateContext,
} from "../delivery-queue-sqlite.js";
import { formatErrorMessage } from "../errors.js";
import { isGatewayExternallySupervised } from "../gateway-supervision.js";
import { wrapSqliteWorkerError } from "../sqlite-worker-contract.js";
import {
  countPhysicalOutboundSends,
  type OutboundDeliveryBatch as DeliveryEvidenceBatch,
  type OutboundDeliveryResult,
} from "./deliver-types.js";
import {
  nativeFinalBatchMemberIds,
  selectNativeFinalMemberEvidence,
  type NativeFinalMemberEvidence,
} from "./delivery-completion-members.js";
import {
  captureDeliveryPlacementEvidence,
  deliveryPlacementMatchesContext,
  type DeliveryPlacementEvidence,
} from "./delivery-placement-evidence.js";
import type { DeliveryPublicationEvidence } from "./delivery-queue-publication.types.js";
import type { DurableDeliveryCompletion } from "./delivery-queue-types.js";
import { normalizeTargetForProvider } from "./target-normalization.js";

const log = createSubsystemLogger("outbound/delivery-completion");

/** In-process locator captured before delivery preparation; never queue payload data. */
export type ConversationDeliveryTarget = Pick<
  PreparedConversationRegistryScope,
  "agentId" | "databaseAgentId" | "storePath"
> &
  DeliveryQueueStateContext;

export function captureConversationDeliveryTarget(
  scope: PreparedConversationRegistryScope,
): ConversationDeliveryTarget {
  return {
    workerContext: captureOpenClawStateWorkerContext({ env: scope.env }),
    agentId: scope.agentId,
    databaseAgentId: scope.databaseAgentId,
    storePath: scope.storePath,
    stateDir: resolveStateDir(scope.env),
    ...(isGatewayExternallySupervised(scope.env) ? { supervisorMode: "external" as const } : {}),
  };
}

type DurableDeliveryCompletionResult = {
  state: "prepared" | "queued" | "delivered" | "suppressed" | "rejected" | "unknown" | "stale";
  platformMessageId?: string;
  rejectionError?: string;
};

export function resolveConversationDeliveryScope(
  completion: Extract<DurableDeliveryCompletion, { kind: "conversation" }>,
  stateDir?: string,
  stateContext?: DeliveryQueueStateContext,
  target?: ConversationDeliveryTarget,
): ConversationRegistryScope {
  const scope = {
    agentId: completion.agentId,
    ...(completion.storePath ? { storePath: completion.storePath } : {}),
    env: resolveDeliveryQueueStateEnv(stateDir, target ?? stateContext),
  };
  if (!target) {
    return scope;
  }
  const options = toDatabaseOptions(resolveSqliteReadScope(scope));
  if (
    normalizeAgentId(scope.agentId) !== normalizeAgentId(target.agentId) ||
    options.agentId !== target.databaseAgentId ||
    !isSameOpenClawAgentDatabasePath(resolveOpenClawAgentSqlitePath(options), target.storePath)
  ) {
    throw new Error("Conversation delivery target does not match durable custody");
  }
  return { ...scope, storePath: target.storePath, databaseAgentId: target.databaseAgentId };
}

async function conversationResult(
  completion: Extract<DurableDeliveryCompletion, { kind: "conversation" }>,
  update: (scope: ConversationRegistryScope) => Promise<ConversationDeliveryRecord>,
  stateDir?: string,
  stateContext?: DeliveryQueueStateContext,
  target?: ConversationDeliveryTarget,
): Promise<DurableDeliveryCompletionResult> {
  let record: ConversationDeliveryRecord;
  try {
    record = await update(
      resolveConversationDeliveryScope(completion, stateDir, stateContext, target),
    );
  } catch (error) {
    // Full session deletion can retire the owner before its shared queue settles.
    if (error instanceof ConversationDeliveryMissingError) {
      return { state: "stale" };
    }
    throw error;
  }
  const delivered = record.status === "sent" || record.status === "replied";
  return {
    state: delivered
      ? "delivered"
      : record.status === "suppressed" ||
          record.status === "rejected" ||
          record.status === "unknown"
        ? record.status
        : "queued",
    ...(delivered && (record.platformMessageId || record.preparedMessageId)
      ? { platformMessageId: record.platformMessageId ?? record.preparedMessageId }
      : {}),
    ...(record.status === "rejected" && record.rejectionError
      ? { rejectionError: record.rejectionError }
      : {}),
  };
}

export async function settlePendingFinalDelivery(
  completion: Extract<DurableDeliveryCompletion, { kind: "pending-final" }>,
  state: Exclude<DurableDeliveryCompletionResult["state"], "rejected" | "stale">,
  expectedStates?: readonly ("prepared" | "queued" | "unknown")[],
  options: {
    stateDir?: string;
    preserveActivity?: boolean;
    stateContext?: DeliveryQueueStateContext;
    identifiedResult?: OutboundDeliveryResult;
    batch?: DeliveryEvidenceBatch;
    finalPhysicalReceipt?: DeliveryPublicationEvidence;
    requireFinalPhysicalReceipt?: true;
    /** Delivery has settled; durable queue owners must retain their receipt until ACK. */
    clearAfterSettled?: true;
  } = {},
): Promise<DurableDeliveryCompletionResult> {
  const memberIds = nativeFinalBatchMemberIds(completion);
  if (memberIds) {
    const outcomes = [];
    for (const deliveryId of memberIds) {
      outcomes.push(
        await settlePendingFinalDelivery(
          { ...completion, memberDeliveryIds: undefined, deliveryId },
          state === "delivered" ? "unknown" : state,
          expectedStates,
          {
            stateDir: options.stateDir,
            stateContext: options.stateContext,
            preserveActivity: options.preserveActivity,
          },
        ),
      );
    }
    return (
      outcomes.find((outcome) => outcome.state === "unknown" || outcome.state === "stale") ??
      outcomes.at(-1)!
    );
  }
  let settled: DurableDeliveryCompletionResult["state"] = "stale";
  let finalSource: { sourceRunId: string; sourceGeneration: string } | undefined;
  const scope = {
    agentId: completion.agentId,
    sessionKey: completion.sessionKey,
    storePath: completion.storePath,
    env: resolveDeliveryQueueStateEnv(options.stateDir, options.stateContext),
  };
  const settlement: PendingFinalDeliverySettlementInput = {
    sessionId: completion.sessionId,
    intentId: completion.intentId,
    deliveryId: completion.deliveryId,
    state,
    expectedStates: expectedStates?.slice(),
    ...(options.clearAfterSettled
      ? {
          cleanup: {
            sessionKey: completion.sessionKey,
            now: Date.now(),
            preserveActivity: options.preserveActivity,
          },
        }
      : {}),
  };
  const authority = completion.sessionWriterDeliveryAuthority;
  if (
    completion.agentId !== undefined &&
    authority?.agentId !== undefined &&
    normalizeAgentId(authority.agentId) !== normalizeAgentId(completion.agentId)
  ) {
    return { state: "stale" };
  }
  let refused = false;
  const evidence = (entry: SessionEntry | undefined): SessionActorDeliveryEvidence => ({
    result: resolvePendingFinalResultEvidence(options, entry?.pendingFinalDelivery?.context),
  });
  const live: SessionActorAuthority = {
    assertCurrent() {},
    authorize(stage, facts) {
      const entry = facts.entry;
      const sourceMatches = (plan?: { sourceRunId?: string; sourceGeneration?: string }) =>
        (completion.sourceRunId === undefined || plan?.sourceRunId === completion.sourceRunId) &&
        (completion.sourceGeneration === undefined ||
          plan?.sourceGeneration === completion.sourceGeneration);
      // The commit postimage of this owner's own cleanup has no pending plan; the
      // transaction stage already matched it, and a retained receipt must still match.
      const cleared =
        stage === "commit" && options.clearAfterSettled && !entry?.pendingFinalDelivery;
      const receipt = entry?.completedFinalDeliveries?.find(
        (candidate) => candidate.intentId === completion.intentId,
      );
      if (
        cleared
          ? receipt !== undefined && !sourceMatches(receipt)
          : !sourceMatches(entry?.pendingFinalDelivery)
      ) {
        refused = true;
        throw new Error("Pending final source identity changed");
      }
      if (
        authority &&
        (!entry ||
          authority.sessionKey !== completion.sessionKey ||
          (authority.storePath !== undefined && authority.storePath !== completion.storePath) ||
          authority.expectedSessionId !== entry.sessionId ||
          (authority.expectedLifecycleRevision !== undefined &&
            authority.expectedLifecycleRevision !== entry.lifecycleRevision) ||
          (authority.expectedWriterRunId !== undefined &&
            authority.expectedWriterRunId !== entry.activeWriterRunId))
      ) {
        refused = true;
        throw new Error("Pending final delivery authority was revoked");
      }
    },
  };
  await withSessionActor(scope, { assertCurrent() {}, assertReadable() {} }, async (actor) => {
    let outcome;
    try {
      outcome = await runSessionActorCommand(actor, live, async (snapshot) => {
        // Only receipt evidence needs a captured route/version. State-only custody
        // changes validate atomically in deliverySettled without a preparatory read.
        const current = snapshot ?? (options.identifiedResult ? await actor.read(live) : undefined);
        const capturedEvidence = evidence(current?.entry);
        return actor.deliverySettled(
          {
            commandId: randomUUID(),
            phaseId: randomUUID(),
            expected: current?.version,
            settlement:
              options.requireFinalPhysicalReceipt &&
              state === "delivered" &&
              !capturedEvidence.result?.finalPlatformMessageId
                ? { ...settlement, state: "unknown" }
                : settlement,
            evidence: capturedEvidence,
          },
          live,
        );
      });
    } catch (error) {
      // No command was accepted if its read's live authorization refused.
      if (refused) {
        return;
      }
      throw error;
    }
    if (outcome.kind !== "committed") {
      if (outcome.kind === "rolled-back" && (refused || outcome.reason === "stale-state")) {
        return;
      }
      throw wrapSqliteWorkerError(
        outcome.error.message,
        outcome.kind === "unknown" ? "outcome-unknown" : "unavailable",
        outcome.error,
      );
    }
    if (!("state" in outcome.value)) {
      throw new Error("Pending final delivery returned another settlement");
    }
    settled = outcome.value.state;
    const postimage = outcome.receipt.postimage.entry;
    const plan =
      postimage?.pendingFinalDelivery?.intentId === completion.intentId
        ? postimage.pendingFinalDelivery
        : postimage?.completedFinalDeliveries?.find(
            (candidate) => candidate.intentId === completion.intentId,
          );
    if (plan?.sourceRunId && plan.sourceGeneration && plan.projectionConsumers?.length)
      finalSource = { sourceRunId: plan.sourceRunId, sourceGeneration: plan.sourceGeneration };
    if (outcome.failure) {
      throw new Error(outcome.failure.message);
    }
  });
  if (finalSource) await notifyNativeFinalDeliveryChanged({ ...completion, ...finalSource });
  return { state: settled };
}

/** Keep contradictions until every physical send has been checked against captured routing. */
function resolvePendingFinalResultEvidence(
  options: {
    identifiedResult?: OutboundDeliveryResult;
    batch?: DeliveryEvidenceBatch;
    finalPhysicalReceipt?: DeliveryPublicationEvidence;
  },
  context: DeliveryContext | undefined,
): SessionActorDeliveryEvidence["result"] {
  if (!context?.channel || !context.to || !options.identifiedResult) {
    return undefined;
  }
  const destination = { channel: context.channel, to: context.to, threadId: context.threadId };
  const physical = options.finalPhysicalReceipt;
  if (physical !== undefined) {
    if (
      physical.destination.channel !== context.channel ||
      normalizeTargetForProvider(context.channel, physical.destination.to) !==
        normalizeTargetForProvider(context.channel, context.to) ||
      (physical.destination.accountId ?? "default") !== (context.accountId ?? "default") ||
      String(physical.destination.threadId ?? "") !== String(context.threadId ?? "") ||
      !deliveryPlacementMatchesContext(physical.placement, destination) ||
      !physical.platformMessageIds.length ||
      physical.platformMessageIds.some((id) => typeof id !== "string" || !id.trim()) ||
      physical.platformMessageIds.at(-1) !== physical.platformMessageId ||
      !physical.primaryPlatformMessageId?.trim() ||
      !Number.isSafeInteger(physical.resultCount) ||
      Number(physical.resultCount) <= 0
    )
      return undefined;
    // The producer supplied complete immutable source-index evidence before observers.
    // Never let mutable aggregate objects replace any part of this receipt.
    return {
      channel: context.channel,
      platformMessageId: physical.primaryPlatformMessageId,
      finalPlatformMessageId: physical.platformMessageId,
      resultCount: physical.resultCount,
      verifiedContext: structuredClone(context),
    };
  }
  const matchesPlacement = (placement: DeliveryPlacementEvidence | undefined): boolean =>
    deliveryPlacementMatchesContext(placement, destination);
  const matches = (result: OutboundDeliveryResult): boolean =>
    result.channel === context.channel &&
    result.outcome !== "not_sent" &&
    Boolean(readPlatformMessageId(result)) &&
    matchesPlacement(captureDeliveryPlacementEvidence(result));
  const batch = options.batch;
  const results = batch?.results ?? [options.identifiedResult];
  if (batch) {
    const indices = new Set(batch.payloadOutcomes.map((outcome) => outcome.index));
    if (
      batch.payloadCount < 1 ||
      batch.payloadOutcomes.length !== batch.payloadCount ||
      indices.size !== batch.payloadCount ||
      batch.payloadOutcomes.some(
        (outcome) =>
          outcome.index < 0 ||
          outcome.index >= batch.payloadCount ||
          outcome.status !== "sent" ||
          outcome.incompleteReason !== undefined ||
          !matchesPlacement(outcome.reportedPlacement) ||
          !outcome.results.length ||
          !outcome.results.every(matches),
      )
    ) {
      return undefined;
    }
  }
  if (!results.length || !results.every(matches) || !matches(options.identifiedResult)) {
    return undefined;
  }
  return {
    channel: context.channel,
    platformMessageId: readPlatformMessageId(options.identifiedResult),
    resultCount: countPhysicalOutboundSends(results),
    verifiedContext: structuredClone(context),
  };
}

function readPlatformMessageId(result: OutboundDeliveryResult): string | undefined {
  const receiptId = result.receipt ? resolveMessageReceiptPrimaryId(result.receipt) : undefined;
  return receiptId ?? (result.messageId.trim() || undefined);
}

/**
 * A plugin notice has no owner record to update; its owner is the posting plugin, which must
 * still be loaded and enabled in this process. The returned check reads the live registry on
 * each call, so recovery can repeat it synchronously right before transport I/O.
 */
export async function preparePluginNoticeOwnerCheck(pluginId: string): Promise<() => void> {
  const [{ getActivePluginRegistry }, { isPluginRecordActive }] = await Promise.all([
    import("../../plugins/runtime.js"),
    import("../../plugins/registry-lifecycle.js"),
  ]);
  return () => {
    const registry = getActivePluginRegistry();
    const record = registry?.plugins.find((plugin) => plugin.id === pluginId);
    if (!registry || !record || !isPluginRecordActive(registry, record)) {
      throw new Error(`plugin "${pluginId}" that posted this notice is no longer active`);
    }
  };
}

async function pluginNoticeOwnerState(
  completion: Extract<DurableDeliveryCompletion, { kind: "plugin-notice" }>,
): Promise<DurableDeliveryCompletionResult> {
  try {
    (await preparePluginNoticeOwnerCheck(completion.pluginId))();
    return { state: "queued" };
  } catch (error) {
    const rejectionError = formatErrorMessage(error);
    log.warn(`Refusing a queued plugin notice: ${rejectionError}`);
    return { state: "rejected", rejectionError };
  }
}

/** Records queue ownership before either the live sender or recovery crosses platform I/O. */
export async function markDurableDeliveryQueued(
  completion: DurableDeliveryCompletion,
  queueId: string,
  expectedPendingFinalState?: "prepared",
  stateDir?: string,
  stateContext?: DeliveryQueueStateContext,
  target?: ConversationDeliveryTarget,
): Promise<DurableDeliveryCompletionResult> {
  if (completion.kind === "plugin-notice") {
    return await pluginNoticeOwnerState(completion);
  }
  return completion.kind === "pending-final"
    ? // The reply dispatcher may have claimed direct custody ("queued") before the
      // durable enqueue; both states still belong to this send attempt.
      await settlePendingFinalDelivery(
        completion,
        "queued",
        expectedPendingFinalState ? ["prepared", "queued"] : undefined,
        { stateDir, stateContext },
      )
    : conversationResult(
        completion,
        (scope) => markConversationDeliveryQueued(scope, completion.operationId, queueId),
        stateDir,
        stateContext,
        target,
      );
}

/** Finalizes owner state from identified platform evidence before queue acknowledgement. */
export async function completeDurableDelivery(
  completion: DurableDeliveryCompletion,
  result: OutboundDeliveryResult,
  stateDir?: string,
  stateContext?: DeliveryQueueStateContext,
  target?: ConversationDeliveryTarget,
  batch?: DeliveryEvidenceBatch,
): Promise<DurableDeliveryCompletionResult> {
  return settleDurableDelivery(completion, { result, batch }, stateDir, stateContext, target);
}

type DurableDeliveryTerminalEvidence = (
  | {
      result: OutboundDeliveryResult;
      batch?: DeliveryEvidenceBatch;
      finalPhysicalReceipt?: DeliveryPublicationEvidence;
    }
  | { rejectionError: string }
  | { platformSendStarted: boolean }
) & { memberEvidence?: readonly NativeFinalMemberEvidence[] };

/** Settles the completion owner from the final evidence held by its lifecycle owner. */
export async function settleDurableDelivery(
  completion: DurableDeliveryCompletion,
  evidence: DurableDeliveryTerminalEvidence,
  stateDir?: string,
  stateContext?: DeliveryQueueStateContext,
  target?: ConversationDeliveryTarget,
): Promise<DurableDeliveryCompletionResult> {
  if (completion.kind === "pending-final") {
    const members = nativeFinalBatchMemberIds(completion);
    if (members) {
      const outcomes = [];
      for (const [index, deliveryId] of members.entries()) {
        const member = selectNativeFinalMemberEvidence(
          evidence.memberEvidence,
          members.length,
          index,
        );
        // A whole-batch pre-send refusal proves no member crossed transport.
        const noSend =
          !member &&
          (("platformSendStarted" in evidence && !evidence.platformSendStarted) ||
            "rejectionError" in evidence);
        const memberState = member?.state ?? (noSend ? "suppressed" : "unknown");
        const captured = member?.state === "delivered" ? member.receipt : undefined;
        outcomes.push(
          await settlePendingFinalDelivery(
            { ...completion, memberDeliveryIds: undefined, deliveryId },
            memberState,
            undefined,
            {
              stateDir,
              stateContext,
              requireFinalPhysicalReceipt: true,
              ...(index === members.length - 1 ? { clearAfterSettled: true as const } : {}),
              ...(captured
                ? {
                    identifiedResult: {
                      channel: captured.destination.channel,
                      messageId: captured.primaryPlatformMessageId ?? "",
                    },
                    finalPhysicalReceipt: captured,
                  }
                : {}),
            },
          ),
        );
      }
      return (
        outcomes.find((outcome) => outcome.state === "unknown" || outcome.state === "stale") ??
        outcomes.at(-1)!
      );
    }
  }
  // Proven no-send rejections suppress a pending final without owing an
  // uncertainty notice; conversation delivery retains the explicit rejection.
  const state =
    "result" in evidence
      ? "delivered"
      : "platformSendStarted" in evidence && evidence.platformSendStarted
        ? "unknown"
        : "suppressed";
  if (completion.kind === "plugin-notice") {
    // The posting plugin keeps no delivery record; the queue row is the only state.
    return { state };
  }
  return completion.kind === "pending-final"
    ? await settlePendingFinalDelivery(completion, state, undefined, {
        stateDir,
        stateContext,
        ...("result" in evidence
          ? {
              identifiedResult: evidence.result,
              batch: evidence.batch,
              finalPhysicalReceipt: evidence.finalPhysicalReceipt,
            }
          : {}),
      })
    : conversationResult(
        completion,
        (scope) => {
          if ("result" in evidence) {
            return markConversationDeliverySent(
              scope,
              completion.operationId,
              readPlatformMessageId(evidence.result),
            );
          }
          if ("rejectionError" in evidence) {
            return markConversationDeliveryRejected(
              scope,
              completion.operationId,
              evidence.rejectionError,
            );
          }
          return evidence.platformSendStarted
            ? markConversationDeliveryUnknown(scope, completion.operationId)
            : markConversationDeliverySuppressed(scope, completion.operationId);
        },
        stateDir,
        stateContext,
        target,
      );
}
