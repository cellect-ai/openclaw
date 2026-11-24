import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type DeliveryQueueStateContext } from "../delivery-queue-sqlite.js";
import { getErrnoCode } from "../delivery-recovery.shared.js";
import { formatErrorMessage } from "../errors.js";
import { resolveOutboundChannelMessageAdapter } from "./channel-resolution.js";
import { OUTBOUND_DELIVERY_LOG_SCOPE } from "./deliver-log.js";
import { buildPayloadSummary } from "./deliver-payload.js";
import { type QueuedDeliveryOwner } from "./deliver-queue-state.js";
import {
  type OutboundDeliveryFailureStage,
  type OutboundDeliveryResult,
  type OutboundPayloadDeliveryOutcome,
} from "./deliver-types.js";
import { settleDurableDelivery } from "./delivery-completion.js";
import { collectEntrySpoolPaths, releaseSpoolArtifacts } from "./delivery-queue-media-spool.js";
import {
  cancelDeliveryQueueMediaRetention,
  createDeliveryQueueMediaRetention,
} from "./delivery-queue-media-staging.js";
import {
  buildUnknownSendContext,
  needsUnknownSendReconciliation,
} from "./delivery-queue-reconciliation.js";
import type { RecoveryLogger } from "./delivery-queue-recovery.js";
import {
  failDelivery,
  finalizeDeliveryFailureSettlement,
  stageDeliveryFailureSettlement,
  type QueuedDelivery,
} from "./delivery-queue-storage.js";
import type { DeliveryFailureSettlement } from "./delivery-queue-types.js";
import { createOutboundMessageSentEmitter, type MessageSentEvent } from "./message-sent-hook.js";
import {
  completedOutboundAuditTerminals,
  emitOutboundAuditTerminals,
  failedOutboundAuditTerminals,
  uniformOutboundAuditTerminals,
} from "./outbound-audit.js";
import { acceptedPreparedOutboundEntries, preparedOutboundPayloads } from "./prepared-batch.js";
export function emitRecoveredMessageSentEvents(
  entry: QueuedDelivery,
  events: readonly MessageSentEvent[],
): void {
  const { emitMessageSent } = createOutboundMessageSentEmitter(entry, OUTBOUND_DELIVERY_LOG_SCOPE);
  for (const event of events) {
    emitMessageSent(event);
  }
}

export type IndexedMessageSentEvent = {
  sourceIndex: number;
  event: MessageSentEvent;
};

export function emitRecoveredTerminalEvents(
  entry: QueuedDelivery,
  outcome:
    | { result: OutboundDeliveryResult }
    | { error: string; collected?: readonly IndexedMessageSentEvent[] },
): void {
  if (entry.legacyPreparedContentUnavailable) {
    return;
  }
  // Rendering can suppress an accepted payload before later payloads settle.
  // Source indices keep a gap from duplicating or misattributing events.
  const collectedBySourceIndex =
    "error" in outcome
      ? new Map(
          (outcome.collected ?? []).map(({ sourceIndex, event }) => [sourceIndex, event] as const),
        )
      : undefined;
  const preparedEntries = acceptedPreparedOutboundEntries(entry.preparedBatch);
  let messageIds: readonly (string | undefined)[] = [];
  if ("result" in outcome) {
    if (preparedEntries.length === 0) {
      return;
    }
    const { result } = outcome;
    const receiptMessageIds = result.receipt?.parts.length
      ? result.receipt.parts
          .toSorted((left, right) => left.index - right.index)
          .map((part) => part.platformMessageId)
      : result.receipt?.platformMessageIds;
    messageIds =
      preparedEntries.length === 1
        ? [result.messageId || receiptMessageIds?.[0]]
        : receiptMessageIds?.length === preparedEntries.length
          ? receiptMessageIds
          : [];
  }
  emitRecoveredMessageSentEvents(
    entry,
    preparedEntries.map((prepared, index) => {
      const summary = buildPayloadSummary(prepared.payload);
      const content = summary.hookContent ?? summary.text;
      if ("error" in outcome) {
        return (
          collectedBySourceIndex?.get(prepared.sourceIndex) ?? {
            success: false,
            content,
            error: outcome.error,
          }
        );
      }
      const messageId = messageIds[index];
      const event: MessageSentEvent = { success: true, content };
      if (messageId) {
        event.messageId = messageId;
      }
      return event;
    }),
  );
}

export function emitQueuedAuditTerminals(
  entry: QueuedDelivery,
  terminals: Parameters<typeof emitOutboundAuditTerminals>[0]["terminals"],
): void {
  emitOutboundAuditTerminals({
    context: entry,
    terminals,
    startedAt: entry.enqueuedAt,
    queueId: entry.id,
  });
}

export function emitQueuedDeliveryResults(
  entry: QueuedDelivery,
  results: readonly OutboundDeliveryResult[],
  payloadOutcomes: readonly OutboundPayloadDeliveryOutcome[] = [],
  failureStage?: () => OutboundDeliveryFailureStage,
): void {
  emitQueuedAuditTerminals(entry, () => {
    const batch = {
      payloadCount: entry.preparedBatch.sourcePayloadCount,
      results,
      payloadOutcomes,
    };
    return failureStage === undefined
      ? completedOutboundAuditTerminals(batch)
      : failedOutboundAuditTerminals({ ...batch, failureStage: failureStage() });
  });
}

export async function recordRecoveryFailure(
  owner: QueuedDeliveryOwner,
  error: string,
  record = failDelivery,
): Promise<"failed" | "already-gone"> {
  try {
    await owner.fail(record, error);
  } catch (failure) {
    if (getErrnoCode(failure) === "ENOENT") {
      return "already-gone";
    }
  }
  return "failed";
}

export async function settleQueuedFailure(
  params: {
    entry: QueuedDelivery;
    cfg: OpenClawConfig;
    log: RecoveryLogger;
    stateDir?: string;
    error: string;
    claimedAttemptId?: string;
    rejectionError?: string;
    events?: readonly IndexedMessageSentEvent[];
    terminals?: ReturnType<typeof failedOutboundAuditTerminals>;
  },
  stateContext: DeliveryQueueStateContext,
): Promise<"moved-to-failed" | "failed" | "already-gone"> {
  let terminalized = false;
  try {
    const unknownSend = needsUnknownSendReconciliation(params.entry);
    const settlement: DeliveryFailureSettlement = params.entry.settlement ?? {
      error: params.error,
      ...(params.terminals ? { terminals: params.terminals } : {}),
      ...(unknownSend ? { unknownSendCleanup: true as const } : {}),
      ...(params.rejectionError !== undefined
        ? { outcome: "failed" as const, rejectionError: params.rejectionError }
        : { outcome: unknownSend ? ("unknown" as const) : ("failed" as const) }),
    };
    const entry = await stageDeliveryFailureSettlement(
      params.entry,
      settlement,
      params.stateDir,
      params.claimedAttemptId,
      stateContext,
    );
    if (!entry) {
      return "already-gone";
    }
    // Failed custody forbids sends even after a restart. Keep the completion
    // payload until its idempotent owner projection succeeds, then compact once.
    if (entry.deliveryCompletion) {
      await settleDurableDelivery(
        entry.deliveryCompletion,
        settlement.outcome === "failed" && settlement.rejectionError !== undefined
          ? { rejectionError: settlement.rejectionError }
          : { platformSendStarted: true },
        params.stateDir,
        stateContext,
      );
    }
    const spoolPaths = collectEntrySpoolPaths(
      preparedOutboundPayloads(entry.preparedBatch),
      params.stateDir,
    );
    const leaseId =
      spoolPaths.length > 0
        ? await createDeliveryQueueMediaRetention(
            spoolPaths,
            "outbound-media-recovery-lease",
            params.stateDir,
            stateContext,
          )
        : undefined;
    try {
      if (!(await finalizeDeliveryFailureSettlement(entry, params.stateDir, stateContext))) {
        return "already-gone";
      }
      terminalized = true;
      emitRecoveredTerminalEvents(entry, { error: settlement.error, collected: params.events });
      emitQueuedAuditTerminals(
        entry,
        settlement.terminals ??
          (() =>
            uniformOutboundAuditTerminals(entry.preparedBatch.sourcePayloadCount, {
              outcome: settlement.outcome,
              failureStage: "queue",
            })),
      );
      if (settlement.unknownSendCleanup) {
        const cleanup = (
          await resolveOutboundChannelMessageAdapter({
            channel: entry.channel,
            cfg: params.cfg,
            agentId: entry.session?.agentId,
            allowBootstrap: true,
            assertCurrent: () => stateContext.workerContext.admission.assertCurrent(),
          })
        )?.durableFinal?.afterUnknownSendTerminal;
        try {
          await cleanup?.(
            buildUnknownSendContext({
              entry,
              payloads: preparedOutboundPayloads(entry.preparedBatch),
              cfg: params.cfg,
            }),
          );
        } catch (error) {
          params.log.warn(
            `Delivery entry ${entry.id} unknown-send terminal cleanup failed: ${formatErrorMessage(error)}`,
          );
        }
      }
      await releaseSpoolArtifacts(spoolPaths, params.stateDir);
    } finally {
      await cancelDeliveryQueueMediaRetention(leaseId, params.stateDir, stateContext);
    }
  } catch (error) {
    params.log.warn(
      `Delivery entry ${params.entry.id} ${terminalized ? "terminal cleanup failed" : "settlement pending"}: ${formatErrorMessage(error)}`,
    );
  }
  return terminalized ? "moved-to-failed" : "failed";
}
