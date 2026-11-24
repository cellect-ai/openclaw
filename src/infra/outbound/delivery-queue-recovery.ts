// Delivery queue recovery drains pending outbound sends with backoff, crash
// replay protection, unknown-send reconciliation, and failed-entry pruning.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sleep } from "../../utils/sleep.js";
import {
  captureDeliveryQueueStateContext,
  type DeliveryQueueStateContext,
} from "../delivery-queue-sqlite.js";
import { resolveDeliveryQueueAttemptCount } from "../delivery-queue-sqlite.types.js";
import {
  createEmptyDeliveryRecoverySummary,
  getErrnoCode,
  isAmbiguousDeliveryTransportError,
  isDeliveryRecoveryRetryEligible,
  isProvenDeliveryNotSentError,
  resolveDeliveryRecoveryDeadlineMs,
  type DeliveryRecoveryDrainDecision,
  type DeliveryRecoverySummary,
} from "../delivery-recovery.shared.js";
import { formatErrorMessage } from "../errors.js";
import { prepareDeferredDeliveryAdmission } from "./deferred-delivery-admission.js";
import type { DeliverOutboundPayloadsParams } from "./deliver-contracts.js";
import {
  createQueuedDeliveryOwner,
  findTerminalBatchRejection,
  persistQueuedPostSendState,
  type QueuedPostSendState,
  type QueuedDeliveryOwner,
} from "./deliver-queue-state.js";
import {
  areOutboundPayloadsIntentionallySuppressed,
  isOutboundDeliveryError,
  OutboundDeliveryError,
  isOutboundDeliveryAdmissionClosedError,
  OutboundDeliveryAdmissionClosedError,
  type OutboundDeliveryResult,
  type OutboundPayloadDeliveryOutcome,
} from "./deliver-types.js";
import {
  isOutboundDeliveryResultArray,
  runOutboundDeliveryCommitHooks,
} from "./delivery-commit-hooks.js";
import { markDurableDeliveryQueued, settleDurableDelivery } from "./delivery-completion.js";
import { prepareOutboundDeliveryGeneration } from "./delivery-generation.js";
import { createDeliveryPublicationCapture } from "./delivery-publication-capture.js";
import { collectEntrySpoolPaths, releaseSpoolArtifacts } from "./delivery-queue-media-spool.js";
import {
  cancelDeliveryQueueMediaRetention,
  createDeliveryQueueMediaRetention,
} from "./delivery-queue-media-staging.js";
import { captureDeliveryPublicationEvidence } from "./delivery-queue-publication-evidence.js";
import { assertDeliveryPublicationOwner } from "./delivery-queue-publication-owner.js";
import {
  flushDeliveryPublications,
  DeliveryPublicationPendingError,
  findDeliveryPublicationPendingError,
} from "./delivery-queue-publication.js";
import {
  buildReconciledSentResult,
  needsUnknownSendReconciliation,
  reconcileUnknownQueuedDelivery,
} from "./delivery-queue-reconciliation.js";
import { runReconciledSentCommitHooks } from "./delivery-queue-recovery-commit-hooks.js";
import { recoveryCoordinator, recoveryLaneKey } from "./delivery-queue-recovery-coordinator.js";
import {
  emitRecoveredMessageSentEvents,
  type IndexedMessageSentEvent,
  emitRecoveredTerminalEvents,
  emitQueuedAuditTerminals,
  emitQueuedDeliveryResults,
  recordRecoveryFailure,
  settleQueuedFailure,
} from "./delivery-queue-recovery-failure.js";
import { buildRecoveryDeliverParams } from "./delivery-queue-recovery-params.js";
import {
  canReplayAmbiguousFinalText,
  isPermanentDeliveryError,
  recoveryPlatformAttemptId,
  resolveMaxRetries,
  resolveUnknownSendReplay,
  shouldInspectQueuedDelivery,
} from "./delivery-queue-recovery-policy.js";
import {
  claimDeliveryPlatformSendAttempt,
  failDelivery,
  failDeliveryAfterPlatformSend,
  failDeliveryBeforePlatformSend,
  loadUnfinishedDelivery,
  loadUnfinishedDeliveries,
  reserveDeliveryAttempt,
  restoreDeliveryAttemptBeforeDispatch,
  type QueuedDelivery,
} from "./delivery-queue-storage.js";
import { commitRecoveredVisibleMessages } from "./delivery-queue-transcript.js";
import { failedOutboundAuditTerminals, uniformOutboundAuditTerminals } from "./outbound-audit.js";
import { acceptedPreparedOutboundEntries, preparedOutboundPayloads } from "./prepared-batch.js";

export const withActiveDeliveryClaim = recoveryCoordinator.withClaim;

export type DeliverFn = (params: DeliverOutboundPayloadsParams) => Promise<unknown>;

type InternalRecoveryDeliver = (
  params: DeliverOutboundPayloadsParams,
  context: DeliveryQueueStateContext,
) => Promise<unknown>;

export interface RecoveryLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

type RecoveryOptions = {
  cfg: OpenClawConfig;
  deliver: DeliverFn;
  log: RecoveryLogger;
  stateDir?: string;
  shouldContinue?: () => boolean;
  onPending?: () => void;
};

type EntryRecoveryOptions = RecoveryOptions & {
  entry: QueuedDelivery;
  onRecovered?: (entry: QueuedDelivery) => void;
  onFailed?: (entry: QueuedDelivery, errMsg: string) => void;
  onDelivered?: (
    results: OutboundDeliveryResult[],
    outcomes: OutboundPayloadDeliveryOutcome[],
  ) => void;
  onAttemptFailed?: (error: OutboundDeliveryError) => void;
};

async function resolveCompletedOwnerBeforeRecovery(
  opts: EntryRecoveryOptions & { owner: QueuedDeliveryOwner },
  stateContext: DeliveryQueueStateContext,
): Promise<"continue" | "publication-reconciliation" | "recovered" | "failed" | "moved-to-failed"> {
  const completion = opts.entry.deliveryCompletion;
  if (!completion) {
    return "continue";
  }
  let operation: Awaited<ReturnType<typeof markDurableDeliveryQueued>>;
  try {
    operation = await markDurableDeliveryQueued(
      completion,
      opts.entry.id,
      undefined,
      opts.stateDir,
      stateContext,
    );
  } catch (error) {
    const errMsg = `delivery owner state unavailable: ${formatErrorMessage(error)}`;
    await opts.owner.fail(failDelivery, errMsg).catch(() => undefined);
    opts.onFailed?.(opts.entry, errMsg);
    opts.log.warn(`Delivery entry ${opts.entry.id} ${errMsg}`);
    return "failed";
  }
  if (operation.state === "prepared" || operation.state === "queued") {
    return "continue";
  }
  if (operation.state === "unknown") {
    const settled = await settleQueuedFailure(
      {
        ...opts,
        error: "delivery owner state is unknown",
      },
      stateContext,
    );
    return settled === "already-gone" ? "failed" : settled;
  }
  // An owner's compact primary ID cannot prove the final physical publication
  // part. Keep exact reconciliation custody after a crash before canonical ACK.
  if (
    operation.state === "delivered" &&
    acceptedPreparedOutboundEntries(opts.entry.preparedBatch).some(
      (part) => part.publication?.kind === "final",
    )
  ) {
    return "publication-reconciliation";
  }
  try {
    const suppressReceipt =
      operation.state !== "delivered" && typeof opts.entry.completionRetention === "object";
    await opts.owner.ack(suppressReceipt ? { suppressCompletionReceipt: true } : undefined);
  } catch (error) {
    const errMsg = `failed to ack owner-${operation.state} delivery: ${formatErrorMessage(error)}`;
    opts.onFailed?.(opts.entry, errMsg);
    opts.log.warn(`Delivery entry ${opts.entry.id} ${errMsg}`);
    return "failed";
  }
  if (operation.state === "delivered") {
    await commitRecoveredVisibleMessages(opts, stateContext);
    const messageId = operation.platformMessageId;
    if (messageId) {
      const result: OutboundDeliveryResult = { channel: opts.entry.channel, messageId };
      emitRecoveredTerminalEvents(opts.entry, { result });
      await runOutboundDeliveryCommitHooks([result]);
      emitQueuedDeliveryResults(opts.entry, [result]);
      opts.onDelivered?.([result], []);
    }
  } else if (operation.state === "rejected") {
    emitQueuedDeliveryResults(opts.entry, [], [], () => "platform_send");
    const error =
      operation.rejectionError ?? "delivery permanently rejected before platform dispatch";
    emitRecoveredTerminalEvents(opts.entry, { error });
    opts.onFailed?.(opts.entry, error);
    return "failed";
  } else if (operation.state === "suppressed") {
    // A restart can separate owner suppression from queue ack. Publish only
    // after custody ends; a stale/missing owner proves no suppression.
    emitQueuedAuditTerminals(opts.entry, () =>
      uniformOutboundAuditTerminals(opts.entry.preparedBatch.sourcePayloadCount, {
        outcome: "suppressed",
        reasonCode: "no_visible_payload",
      }),
    );
    opts.onDelivered?.([], []);
  }
  opts.onRecovered?.(opts.entry);
  return "recovered";
}

async function drainQueuedEntry(
  opts: EntryRecoveryOptions,
  stateContext: DeliveryQueueStateContext,
  internalDeliver?: InternalRecoveryDeliver,
): Promise<"recovered" | "failed" | "moved-to-failed" | "already-gone" | "stopped"> {
  const { entry } = opts;
  try {
    assertDeliveryPublicationOwner(entry);
  } catch (error) {
    opts.log.warn(String(error));
    opts.onFailed?.(entry, String(error));
    return "failed";
  }
  const deliver: DeliverFn = internalDeliver
    ? (params) => internalDeliver(params, stateContext)
    : opts.deliver;
  const owner = createQueuedDeliveryOwner(
    {
      queueId: entry.id,
      stateDir: opts.stateDir,
      expectedPlatformSendAttemptId: recoveryPlatformAttemptId(entry),
    },
    stateContext,
  );
  const maxRetries = resolveMaxRetries(entry);
  const attemptBudgetExhausted = resolveDeliveryQueueAttemptCount(entry) >= maxRetries;
  let reconciledPlatformSendAttemptId: string | undefined;
  let reconciledPlatformSendStartedAt: number | undefined;
  let unknownSendReplay: "blind" | "proven" | undefined;
  const ownerState = await resolveCompletedOwnerBeforeRecovery({ ...opts, owner }, stateContext);
  if (ownerState !== "continue" && ownerState !== "publication-reconciliation") {
    return ownerState;
  }
  // Ephemeral producer authority is not serialized with durable custody. Only
  // an already recorded owner receipt above may settle it. Adapter reconciliation
  // can resend original transactions, so it also requires a fresh live authority.
  // Unknown future policy values also fail closed rather than inheriting replay.
  if (entry.recoveryPolicy !== undefined) {
    return settleQueuedFailure(
      {
        ...opts,
        error:
          "needs_live_authority: durable intent permits receipt reconciliation only; new delivery requires a fresh producer",
      },
      stateContext,
    );
  }
  if (needsUnknownSendReconciliation(entry) || ownerState === "publication-reconciliation") {
    // Unconfirmed sends: adapter reconciliation decides first, then the shared final-text rule.
    const reconciliation =
      entry.legacyUnknownSendReconciliation ??
      (await reconcileUnknownQueuedDelivery({
        entry,
        payloads: preparedOutboundPayloads(entry.preparedBatch),
        cfg: opts.cfg,
        warn: (message) => opts.log.warn(message),
        assertCurrent: () => stateContext.workerContext.admission.assertCurrent(),
      }));
    if (reconciliation?.status === "sent") {
      try {
        const result = buildReconciledSentResult(entry, reconciliation);

        const evidence = captureDeliveryPublicationEvidence([result], entry);
        if (entry.deliveryCompletion) {
          await settleDurableDelivery(
            entry.deliveryCompletion,
            {
              result,
              // Native reconciliation supplies a complete identity for one payload only.
              finalPhysicalReceipt:
                entry.preparedBatch.sourcePayloadCount === 1 ? evidence : undefined,
              batch: {
                results: [result],
                payloadCount: entry.preparedBatch.sourcePayloadCount,
                // Reconciliation supplies no per-payload completion outcomes.
                payloadOutcomes: [{ index: 0, status: "sent", results: [result] }],
              },
            },
            opts.stateDir,
            stateContext,
          );
        }
        await owner.ack(
          evidence
            ? {
                publicationEvidence: evidence,
                completionReceipt: { platformMessageId: evidence.platformMessageId },
              }
            : undefined,
        );
        await commitRecoveredVisibleMessages(opts, stateContext);
        emitRecoveredTerminalEvents(entry, { result });
        await runReconciledSentCommitHooks({
          entry,
          cfg: opts.cfg,
          reconciliation,
          log: opts.log,
          assertCurrent: () => stateContext.workerContext.admission.assertCurrent(),
        });
        emitQueuedDeliveryResults(entry, [result]);
        opts.onRecovered?.(entry);
        opts.onDelivered?.([result], []);
        opts.log.info(`Delivery entry ${entry.id} reconciled unknown_after_send as already sent`);
        return "recovered";
      } catch (ackErr) {
        if (ackErr instanceof DeliveryPublicationPendingError) throw ackErr;
        if (getErrnoCode(ackErr) === "ENOENT") {
          return "already-gone";
        }
        const errMsg = `failed to ack reconciled sent delivery: ${formatErrorMessage(ackErr)}`;
        opts.log.warn(`Delivery entry ${entry.id} ${errMsg}`);
        opts.onFailed?.(entry, errMsg);
        return await recordRecoveryFailure(owner, errMsg);
      }
    }
    const requiredPublication = acceptedPreparedOutboundEntries(entry.preparedBatch).some(
      (prepared) => prepared.publication?.receiptRequired === true,
    );
    unknownSendReplay =
      ownerState === "publication-reconciliation"
        ? undefined
        : resolveUnknownSendReplay(entry, reconciliation);
    // Required source publications never inherit the ordinary final-text blind retry.
    if (requiredPublication && unknownSendReplay === "blind") unknownSendReplay = undefined;
    if (unknownSendReplay) {
      reconciledPlatformSendAttemptId = entry.platformSendAttemptId;
      reconciledPlatformSendStartedAt = entry.platformSendStartedAt;
      opts.log.info(
        unknownSendReplay === "blind"
          ? `Delivery entry ${entry.id} retrying an unconfirmed final text reply`
          : `Delivery entry ${entry.id} reconciled ${entry.recoveryState} as not sent; replaying`,
      );
    } else {
      if (requiredPublication || ownerState === "publication-reconciliation") {
        const error =
          "needs_review: source final publication lacks a complete authenticated provider receipt; preserving ambiguous journal custody";
        opts.log.warn(`Delivery entry ${entry.id} ${error}`);
        opts.onFailed?.(entry, error);
        try {
          await owner.fail(failDelivery, error);
        } catch (failErr) {
          if (getErrnoCode(failErr) === "ENOENT") {
            return "already-gone";
          }
        }
        return "failed";
      }
      let errMsg = `delivery state is ${entry.recoveryState}; refusing blind replay without adapter reconciliation`;
      if (reconciliation?.status === "not_sent") {
        errMsg = `delivery state is ${entry.recoveryState}; refusing full replay after post-send evidence`;
      } else if (reconciliation?.status === "unresolved" && reconciliation.error) {
        errMsg = `delivery state is ${entry.recoveryState} and reconciliation is unresolved: ${reconciliation.error}`;
      }
      opts.log.warn(`Delivery entry ${entry.id} ${errMsg}`);
      opts.onFailed?.(entry, errMsg);
      if (
        reconciliation?.status === "unresolved" &&
        reconciliation.retryable === true &&
        !attemptBudgetExhausted
      ) {
        return await recordRecoveryFailure(owner, errMsg);
      }
      return settleQueuedFailure({ ...opts, error: errMsg }, stateContext);
    }
  }
  const payloadOutcomes: OutboundPayloadDeliveryOutcome[] = [];
  // Recovery captures physical evidence exactly as live delivery does.
  const publicationCapture = createDeliveryPublicationCapture({
    destination: entry,
    payloadCount: entry.preparedBatch.sourcePayloadCount,
    enabled: () => true,
  });
  const {
    publicationEvidenceByPayload,
    publicationSuppressionsByPayload,
    nativeMemberEvidence,
    captureCanonicalResult,
    completeFinalPhysicalReceipt,
  } = publicationCapture;
  // Deliberately process-local: a crash may lose best-effort observers, but
  // persisting plugin callbacks must never become part of delivery custody.
  const messageSentEvents: IndexedMessageSentEvent[] = [];
  let postSendState: QueuedPostSendState | undefined;
  let platformSendStarted = false;
  let attemptError: OutboundDeliveryError | undefined;
  let deliveredResults: OutboundDeliveryResult[] = [];
  let commitHooksRun = false;
  const collectPayloadOutcome = (outcome: OutboundPayloadDeliveryOutcome): void => {
    if (!payloadOutcomes.includes(outcome)) {
      publicationCapture.captureOutcome(outcome);
      payloadOutcomes.push(outcome);
    }
  };
  const recordAttemptError = (error: unknown): void => {
    attemptError = owner.project(error, { results: deliveredResults, payloadOutcomes });
  };
  const runCommitHooksAfterAck = async (): Promise<void> => {
    if (postSendState !== "acked" || commitHooksRun) {
      return;
    }
    commitHooksRun = true;
    emitRecoveredMessageSentEvents(
      entry,
      messageSentEvents.map(({ event }) => event),
    );
    if (deliveredResults.length > 0) {
      await runOutboundDeliveryCommitHooks(deliveredResults);
    }
  };
  // Live producer rows can be observed between enqueue and platform I/O.
  // Fence recovery at the same SQLite claim before consuming an attempt;
  // an active live producer keeps its original renewable lease.
  const requiresProducerClaim =
    typeof entry.completionRetention === "object" ||
    entry.requiresProducerClaim === true ||
    typeof entry.producerClaimId === "string" ||
    typeof entry.platformSendAttemptId === "string";
  const producerClaimId = requiresProducerClaim
    ? await claimDeliveryPlatformSendAttempt(
        entry.id,
        opts.stateDir,
        reconciledPlatformSendStartedAt,
        reconciledPlatformSendAttemptId,
        stateContext,
        unknownSendReplay === "blind" ? true : undefined,
      )
    : undefined;
  if (requiresProducerClaim && !producerClaimId) {
    opts.log.info(`Recovery skipped for delivery ${entry.id}: producer ownership already claimed`);
    return "already-gone";
  }
  owner.claimId = recoveryPlatformAttemptId(entry, producerClaimId);
  // Recovery keeps its media lease until the adapter settles, even if the
  // canonical post-send marker has to finalize the queue with a direct ack.
  const persistPostSendState = () =>
    persistQueuedPostSendState(
      {
        owner,
        queuePolicy: entry.queuePolicy ?? "best_effort",
        preserveBatch: Boolean(producerClaimId),
        retainSpoolArtifacts: true,
        onPostSendMarkerError: (error) => {
          opts.log.warn(
            `Delivery entry ${entry.id} failed to persist post-send state; falling back to direct ack: ${formatErrorMessage(error)}`,
          );
        },
      },
      stateContext,
    );
  const reservation = await reserveDeliveryAttempt(
    entry.id,
    maxRetries,
    opts.stateDir,
    producerClaimId || undefined,
    stateContext,
  );
  if (reservation.status === "exhausted") {
    const errMsg = `delivery retry budget exhausted (${reservation.attemptCount}/${maxRetries})`;
    opts.onFailed?.(entry, errMsg);
    return settleQueuedFailure(
      { ...opts, error: errMsg, claimedAttemptId: producerClaimId },
      stateContext,
    );
  }
  const recoverySpoolPaths = collectEntrySpoolPaths(
    preparedOutboundPayloads(entry.preparedBatch),
    opts.stateDir,
  );
  let mediaRecoveryLeaseId: string | undefined;
  let generation: Awaited<ReturnType<typeof prepareOutboundDeliveryGeneration>> | undefined;
  let releaseWriterAuthority: (() => void) | undefined;
  try {
    // Unknown-send reconciliation above owns already-dispatched work. Only a new
    // dispatch requires current generation authority.
    if (entry.sessionGeneration !== undefined) {
      generation = await prepareOutboundDeliveryGeneration(entry.sessionGeneration);
    }
    // The pending row owns these artifacts until the lease exists. Fallback
    // acks may then remove replay intent without exposing active media to GC.
    mediaRecoveryLeaseId =
      recoverySpoolPaths.length > 0
        ? await createDeliveryQueueMediaRetention(
            recoverySpoolPaths,
            "outbound-media-recovery-lease",
            opts.stateDir,
            stateContext,
          )
        : undefined;
    const { release, ...deliveryParams } = await buildRecoveryDeliverParams(
      entry,
      opts.cfg,
      opts.stateDir,
      producerClaimId,
      stateContext,
    );
    releaseWriterAuthority = release;
    let dispatchAdmitted = false;
    const result = await deliver({
      ...deliveryParams,
      deliveryQueueOwner: owner,
      assertDirectAdapterHandoff: () => {
        deliveryParams.assertDirectAdapterHandoff?.();
        generation?.assertCurrent();
      },
      onCanonicalDeliveryResult: captureCanonicalResult,
      onPayloadDeliveryOutcome: collectPayloadOutcome,
      onMessageSentEvent: (event, sourceIndex) => messageSentEvents.push({ sourceIndex, event }),
      onPlatformSendStart: async () => {
        platformSendStarted = true;
      },
      onDeliveryResult: async (deliveryResult) => {
        if (!deliveredResults.includes(deliveryResult)) {
          captureCanonicalResult(deliveryResult);
          deliveredResults.push(deliveryResult);
        }
        postSendState ??= await persistPostSendState();
      },
      onPlatformSendDispatch: async () => {
        await deliveryParams.onPlatformSendDispatch?.();
        generation?.assertCurrent();
        if (dispatchAdmitted) {
          return;
        }
        if (opts.shouldContinue?.() === false) {
          throw new OutboundDeliveryAdmissionClosedError();
        }
        // One admitted attempt owns its complete adapter fanout. Later parts
        // must settle even when shutdown starts after the first dispatch.
        dispatchAdmitted = true;
      },
    });
    const results = isOutboundDeliveryResultArray(result) ? result : [];
    const failedOutcomes = payloadOutcomes.filter((outcome) => outcome.status === "failed");
    const adapterReturnedNoIdentity = payloadOutcomes.some(
      (outcome) =>
        outcome.status === "suppressed" && outcome.reason === "adapter_returned_no_identity",
    );
    if (
      publicationCapture.incompletePayloadSend ||
      adapterReturnedNoIdentity ||
      (results.length === 0 &&
        // Reported failures carry dispatch evidence and own retry classification.
        // Adapter handoff alone cannot override a proven pre-send failure.
        failedOutcomes.length === 0 &&
        platformSendStarted &&
        !areOutboundPayloadsIntentionallySuppressed(payloadOutcomes))
    ) {
      const error = publicationCapture.incompletePayloadSend
        ? "recovered platform send returned an incomplete physical result for the delivery batch"
        : "recovered platform send returned no delivery identity";
      await owner.fail(failDeliveryAfterPlatformSend, error);
      if (entry.deliveryCompletion) {
        await settleDurableDelivery(
          entry.deliveryCompletion,
          { platformSendStarted: true, memberEvidence: nativeMemberEvidence },
          opts.stateDir,
          stateContext,
        );
      }
      opts.onFailed?.(entry, error);
      opts.log.warn(`Delivery entry ${entry.id} ${error}; preserving unknown_after_send`);
      recordAttemptError(new Error(error));
      // The pending row still owns reconciliation. Emit its one stable terminal
      // only when recovery later acks or dead-letters that durable custody.
      return "failed";
    }
    if (results.length > 0) {
      deliveredResults = [...results];
    }
    const failedOutcome = failedOutcomes[0];
    if (failedOutcome) {
      // Returned best-effort failures and thrown failures share custody classification.
      throw new OutboundDeliveryError(formatErrorMessage(failedOutcome.error), {
        cause: new AggregateError(failedOutcomes.map((outcome) => outcome.error)),
        results,
        payloadOutcomes,
        stage: failedOutcome.stage,
      });
    }
    if (entry.deliveryCompletion) {
      const terminalResult = results.at(-1);
      await settleDurableDelivery(
        entry.deliveryCompletion,
        terminalResult
          ? {
              result: terminalResult,
              finalPhysicalReceipt: completeFinalPhysicalReceipt(),
              memberEvidence: nativeMemberEvidence,
              batch: {
                results,
                payloadCount: entry.preparedBatch.sourcePayloadCount,
                payloadOutcomes,
              },
            }
          : { platformSendStarted: false, memberEvidence: nativeMemberEvidence },
        opts.stateDir,
        stateContext,
      );
    }
    postSendState ??= results.length > 0 ? await persistPostSendState() : undefined;
    if (postSendState === "failed") {
      const errMsg = "recovered send completed but queue finalization failed";
      opts.onFailed?.(entry, errMsg);
      opts.log.warn(`Delivery entry ${entry.id} ${errMsg}; preserving unknown_after_send`);
      recordAttemptError(new Error(errMsg));
      return "failed";
    }
    if (postSendState !== "acked") {
      try {
        const evidence = publicationCapture.aggregatePublicationEvidence();
        await owner.ack({
          publicationEvidenceByPayload,
          publicationSuppressionsByPayload,
          ...publicationCapture.emptyBatchAckOptions(results.length, entry.completionRetention),
          ...(evidence
            ? {
                publicationEvidence: evidence,
                completionReceipt: { platformMessageId: evidence.platformMessageId },
              }
            : {}),
        });
        postSendState = "acked";
      } catch (ackErr) {
        if (ackErr instanceof DeliveryPublicationPendingError) throw ackErr;
        const ackError = `failed to ack recovered delivery: ${formatErrorMessage(ackErr)}`;
        if (results.length > 0) {
          await owner.fail(failDeliveryAfterPlatformSend, ackError);
          postSendState = "failed";
        } else {
          // Proven omission clears the handoff marker so a restart can safely retry.
          await owner.fail(
            areOutboundPayloadsIntentionallySuppressed(payloadOutcomes)
              ? failDeliveryBeforePlatformSend
              : failDelivery,
            ackError,
          );
        }
        opts.onFailed?.(entry, ackError);
        opts.log.warn(`Delivery entry ${entry.id} ${ackError}`);
        recordAttemptError(new Error(ackError));
        return "failed";
      }
    }
    await runCommitHooksAfterAck();
    emitQueuedDeliveryResults(entry, results, payloadOutcomes);
    opts.onRecovered?.(entry);
    opts.onDelivered?.(results, payloadOutcomes);
    return "recovered";
  } catch (err) {
    const publicationPending = findDeliveryPublicationPendingError(err);
    if (publicationPending) throw publicationPending;
    if (isOutboundDeliveryAdmissionClosedError(err)) {
      await restoreDeliveryAttemptBeforeDispatch(
        entry,
        reservation.attemptCount,
        opts.stateDir,
        producerClaimId,
        stateContext,
      );
      return "stopped";
    }
    const errMsg = formatErrorMessage(err);
    opts.onFailed?.(entry, errMsg);
    if (isOutboundDeliveryError(err)) {
      if (err.results.length > 0) {
        deliveredResults = [...err.results];
      }
      for (const outcome of err.payloadOutcomes) {
        collectPayloadOutcome(outcome);
      }
    }
    if (
      entry.deliveryCompletion?.kind === "pending-final" &&
      entry.deliveryCompletion.memberDeliveryIds
    ) {
      await settleDurableDelivery(
        entry.deliveryCompletion,
        { platformSendStarted: true, memberEvidence: nativeMemberEvidence },
        opts.stateDir,
        stateContext,
      );
    }
    recordAttemptError(err);
    const hasSendEvidence =
      deliveredResults.length > 0 ||
      postSendState !== undefined ||
      (isOutboundDeliveryError(err) && err.sentBeforeError);
    if (hasSendEvidence) {
      // A rejected batch can still contain successful earlier sends. Preserve
      // that concrete evidence so reconnect recovery never replays the batch.
      try {
        postSendState ??= await persistPostSendState();
        if (postSendState === "marked" && entry.retryAmbiguousFinalText === true) {
          await owner.fail(
            failDeliveryAfterPlatformSend,
            errMsg,
            deliveredResults.length === 0 && isAmbiguousDeliveryTransportError(err)
              ? true
              : undefined,
          );
        }
      } catch (persistErr) {
        // Never overwrite concrete send evidence with a generic retry state.
        opts.log.error(
          `Delivery entry ${entry.id} could not persist post-send evidence: ${formatErrorMessage(persistErr)}`,
        );
      }
      if (postSendState === "acked") {
        await runCommitHooksAfterAck();
        emitQueuedDeliveryResults(entry, deliveredResults, payloadOutcomes, () =>
          isOutboundDeliveryError(err) ? err.stage : "platform_send",
        );
      }
      opts.log.warn(
        `Delivery entry ${entry.id} partially sent before recovery failed; preserving unknown_after_send`,
      );
      return "failed";
    }
    if (owner.custody === "released") {
      // A best-effort pre-send marker fallback may ack the row before provider
      // I/O. Recovery then owns the stable queue terminal on provider rejection.
      emitQueuedDeliveryResults(entry, deliveredResults, payloadOutcomes, () =>
        isOutboundDeliveryError(err) ? err.stage : "platform_send",
      );
      return "failed";
    }
    const failureErrors = [
      err,
      ...payloadOutcomes.flatMap((outcome) => (outcome.status === "failed" ? [outcome.error] : [])),
    ];
    const permanentPlatformRejection = findTerminalBatchRejection(failureErrors);
    if (
      permanentPlatformRejection ||
      failureErrors.every((error) => isPermanentDeliveryError(formatErrorMessage(error)))
    ) {
      return settleQueuedFailure(
        {
          ...opts,
          error: errMsg,
          claimedAttemptId: producerClaimId,
          ...(permanentPlatformRejection
            ? { rejectionError: permanentPlatformRejection.message }
            : {}),
          events: messageSentEvents,
          // Identified results already exited through hasSendEvidence. These
          // canonical no-send decisions retain suppression reasons across restart.
          terminals: failedOutboundAuditTerminals({
            payloadCount: entry.preparedBatch.sourcePayloadCount,
            results: deliveredResults,
            payloadOutcomes,
            failureStage: "queue",
          }),
        },
        stateContext,
      );
    }
    return await recordRecoveryFailure(
      owner,
      errMsg,
      isProvenDeliveryNotSentError(err) ? failDeliveryBeforePlatformSend : failDelivery,
    );
  } finally {
    releaseWriterAuthority?.();
    generation?.release();
    // Early fallback acks make the row non-replayable before the adapter has
    // necessarily finished reading every payload. Release only after the whole
    // recovered attempt settles, and only if no pending row still owns it.
    await cancelDeliveryQueueMediaRetention(mediaRecoveryLeaseId, opts.stateDir, stateContext);
    const pending = await loadUnfinishedDelivery(entry.id, opts.stateDir, stateContext).catch(
      () => entry,
    );
    if (!pending) {
      await releaseSpoolArtifacts(recoverySpoolPaths, opts.stateDir);
    }
    if (attemptError) {
      if (!pending) {
        attemptError.queueCustody = "released";
      }
      opts.onAttemptFailed?.(attemptError);
    }
  }
}

type QueuedRecoveryContext =
  | {
      kind: "startup";
      summary: DeliveryRecoverySummary;
      deadline: number;
      onDeadlineExceeded: () => void;
    }
  | {
      kind: "drain";
      logLabel: string;
      selectEntry: (entry: QueuedDelivery, now: number) => DeliveryRecoveryDrainDecision;
    };

/** Startup and reconnect share custody, admission, retry, and settlement ordering. */
async function processQueuedRecovery(
  opts: EntryRecoveryOptions,
  context: QueuedRecoveryContext,
  stateContext: DeliveryQueueStateContext,
  internalDeliver?: InternalRecoveryDeliver,
): Promise<"continue" | "stop"> {
  const { entry, log } = opts;
  // Unproven legacy/corrupt publication custody must survive admission failures,
  // retry exhaustion and reconciliation adapters that may resend transactions.
  try {
    assertDeliveryPublicationOwner(entry);
  } catch (error) {
    log.warn(String(error));
    if (context.kind === "startup") context.summary.failed += 1;
    return "continue";
  }
  if (opts.shouldContinue?.() === false) {
    return "stop";
  }
  const label =
    context.kind === "startup" ? `Delivery ${entry.id}` : `${context.logLabel}: entry ${entry.id}`;
  if (entry.settlement) {
    await settleQueuedFailure({ ...opts, error: entry.settlement.error }, stateContext);
    return "continue";
  }
  if (!shouldInspectQueuedDelivery(entry, Date.now())) {
    if (context.kind === "startup") {
      log.info(`Recovery skipped for delivery ${entry.id}: active platform owner`);
    }
    return "continue";
  }
  const resolveAdmission = await prepareDeferredDeliveryAdmission(
    {
      cfg: opts.cfg,
      channel: entry.channel,
      to: entry.to,
      accountId: entry.accountId,
      phase: "recovery",
    },
    {
      agentId: entry.session?.agentId,
      assertCurrent: () => stateContext.workerContext.admission.assertCurrent(),
    },
  );
  if (opts.shouldContinue?.() === false) {
    return "stop";
  }
  const admission = resolveAdmission();
  if (admission.status !== "allowed") {
    const settled = await settleQueuedFailure({ ...opts, error: admission.reason }, stateContext);
    const logLabel = context.kind === "startup" ? "Recovery" : context.logLabel;
    if (settled === "already-gone") {
      log.info(
        `${logLabel}: entry ${entry.id} changed ownership before admission failure was persisted`,
      );
    } else {
      if (context.kind === "startup") {
        context.summary.failed += 1;
      }
      log.warn(
        `${logLabel}: entry ${entry.id} permanently rejected before recovery: ${admission.reason}`,
      );
    }
    return "continue";
  }
  const decision =
    context.kind === "drain" ? context.selectEntry(entry, Date.now()) : { match: true };
  if (!decision.match) {
    log.info(`${label} no longer matches, skipping`);
    return "continue";
  }
  const maxRetries = resolveMaxRetries(entry);
  const attemptCount = resolveDeliveryQueueAttemptCount(entry);
  if (attemptCount >= maxRetries && !needsUnknownSendReconciliation(entry)) {
    if (context.kind === "startup") {
      log.warn(`${label} exceeded max retries (${attemptCount}/${maxRetries}) — moving to failed/`);
      context.summary.skippedMaxRetries += 1;
    }
    const settled = await settleQueuedFailure(
      {
        ...opts,
        error: "delivery retry budget exhausted",
      },
      stateContext,
    );
    if (context.kind === "drain" && settled === "moved-to-failed") {
      log.warn(`${label} exceeded max retries and was moved to failed/`);
    }
    return "continue";
  }
  const eligibility = isDeliveryRecoveryRetryEligible(entry, Date.now());
  if (!decision.bypassBackoff && !eligibility.eligible) {
    if (context.kind === "startup") {
      context.summary.deferredBackoff += 1;
    }
    log.info(
      `${label} not ready for retry yet — backoff ${eligibility.remainingBackoffMs}ms remaining`,
    );
    return "continue";
  }
  if (
    (await recoveryCoordinator.waitForReplay(
      context.kind === "startup" ? context.deadline : undefined,
    )) === "deadline-exceeded"
  ) {
    if (context.kind === "startup") {
      context.onDeadlineExceeded();
    }
    return "stop";
  }
  // Pacing is the final await before a new durable attempt is admitted. A
  // lifecycle fence here leaves the untouched row and retry metadata intact.
  if (opts.shouldContinue?.() === false) {
    return "stop";
  }
  const result = await drainQueuedEntry(
    {
      ...opts,
      onRecovered: (recovered) => {
        if (context.kind === "startup") {
          context.summary.recovered += 1;
          log.info(`Recovered delivery ${recovered.id} on ${recovered.channel}`);
        } else {
          log.info(`${context.logLabel}: drained delivery ${recovered.id} on ${recovered.channel}`);
        }
      },
      onFailed: (failed, error) => {
        if (context.kind === "startup") {
          context.summary.failed += 1;
        }
        if (isPermanentDeliveryError(error)) {
          log.warn(`${label} hit permanent error — moving to failed/: ${error}`);
        } else {
          log.warn(
            context.kind === "startup"
              ? `Retry failed for delivery ${failed.id}: ${error}`
              : `${context.logLabel}: retry failed for entry ${failed.id}: ${error}`,
          );
        }
      },
    },
    stateContext,
    internalDeliver,
  );
  return result === "stopped" ? "stop" : "continue";
}

type LiveFinalDeliveryResult =
  | { status: "not-attempted" }
  | {
      status: "recovered";
      results: OutboundDeliveryResult[];
      payloadOutcomes: OutboundPayloadDeliveryOutcome[];
    }
  | {
      status: "failed";
      error: OutboundDeliveryError;
      results: OutboundDeliveryResult[];
      payloadOutcomes: OutboundPayloadDeliveryOutcome[];
    };

/** The live producer keeps its claim and waits for the same recovery owner as restart. */
export async function recoverLiveFinalDelivery(
  params: RecoveryOptions & {
    entryId: string;
  },
  stateContext: DeliveryQueueStateContext,
): Promise<LiveFinalDeliveryResult> {
  const entry = await loadUnfinishedDelivery(params.entryId, params.stateDir, stateContext);
  if (!entry || !canReplayAmbiguousFinalText(entry) || entry.settlement) {
    return { status: "not-attempted" };
  }
  const eligibility = isDeliveryRecoveryRetryEligible(entry, Date.now());
  if (!eligibility.eligible) {
    await sleep(eligibility.remainingBackoffMs);
  }
  const outcome: { value: LiveFinalDeliveryResult } = { value: { status: "not-attempted" } };
  const current = await loadUnfinishedDelivery(entry.id, params.stateDir, stateContext);
  if (!current) {
    return outcome.value;
  }
  await processQueuedRecovery(
    {
      ...params,
      entry: current,
      onDelivered: (delivered, outcomes) => {
        outcome.value = { status: "recovered", results: delivered, payloadOutcomes: outcomes };
      },
      onAttemptFailed: (error) => {
        outcome.value = {
          status: "failed",
          error,
          results: error.results,
          payloadOutcomes: error.payloadOutcomes,
        };
      },
    },
    {
      kind: "drain",
      logLabel: "Final delivery recovery",
      selectEntry: () => ({ match: true, bypassBackoff: true }),
    },
    stateContext,
  );
  if (outcome.value.status === "recovered") {
    return outcome.value;
  }
  const pending = await loadUnfinishedDelivery(entry.id, params.stateDir, stateContext);
  if (pending && resolveDeliveryQueueAttemptCount(pending) >= resolveMaxRetries(pending)) {
    const settled = await settleQueuedFailure(
      { ...params, entry: pending, error: pending.lastError ?? "delivery retry budget exhausted" },
      stateContext,
    );
    if (settled === "moved-to-failed" && outcome.value.status === "failed") {
      outcome.value.error.queueCustody = "released";
    }
  }
  return outcome.value;
}

export async function drainPendingDeliveriesCore(
  params: RecoveryOptions & {
    drainKey: string;
    logLabel: string;
    selectEntry: (entry: QueuedDelivery, now: number) => DeliveryRecoveryDrainDecision;
  },
  internalDeliver?: InternalRecoveryDeliver,
  stateContext = captureDeliveryQueueStateContext(params.stateDir),
): Promise<void> {
  const opts = { ...params, stateDir: stateContext.stateDir };
  const drained = await recoveryCoordinator.withDrain(opts.drainKey, async () => {
    await flushDeliveryPublications(
      { stateDir: opts.stateDir, onPending: opts.onPending },
      stateContext,
    );
    const now = Date.now();
    const matchingEntries = (await loadUnfinishedDeliveries(opts.stateDir, stateContext)).filter(
      (entry) => Boolean(entry.settlement) || opts.selectEntry(entry, now).match,
    );
    // Leased matches still need a later scan, but cannot acquire an inspection claim yet.
    if (matchingEntries.length > 0) {
      opts.onPending?.();
    }
    await recoveryCoordinator.scan({
      entries: matchingEntries.filter((entry) => shouldInspectQueuedDelivery(entry, now)),
      laneKey: (entry) => recoveryLaneKey(entry, opts.cfg, stateContext.stateDir),
      loadEntry: (id) => loadUnfinishedDelivery(id, opts.stateDir, stateContext),
      onMissingEntry: (entry) => {
        opts.log.info(`${opts.logLabel}: entry ${entry.id} already gone, skipping`);
      },
      // Poll-driven reconnect drains can repeat while a live send owns its
      // claim. Leave conflicts silent so reconnect polling cannot starve it.
      onEntry: (entry) =>
        processQueuedRecovery(
          { ...opts, entry },
          {
            kind: "drain",
            logLabel: opts.logLabel,
            selectEntry: opts.selectEntry,
          },
          stateContext,
          internalDeliver,
        ),
    });
  });
  if (!drained) {
    opts.log.info(`${opts.logLabel}: already in progress for ${opts.drainKey}, skipping`);
  }
}

/**
 * Scan the canonical delivery queue and retry any pending entries.
 * Doctor imports and prepares legacy entries before this runtime recovery pass.
 * Uses exponential backoff and moves entries that exhaust their retry budget to failed/.
 */
export async function recoverPendingDeliveries(
  params: RecoveryOptions & {
    /** Maximum wall-clock time for recovery in ms. Remaining entries are deferred to next startup. Default: 60 000. */
    maxRecoveryMs?: number;
  },
  internalDeliver?: InternalRecoveryDeliver,
  stateContext = captureDeliveryQueueStateContext(params.stateDir),
): Promise<DeliveryRecoverySummary> {
  const opts = { ...params, stateDir: stateContext.stateDir };
  await flushDeliveryPublications(
    { stateDir: opts.stateDir, onPending: opts.onPending },
    stateContext,
  );
  const pending = await loadUnfinishedDeliveries(opts.stateDir, stateContext);
  if (pending.length === 0) {
    return createEmptyDeliveryRecoverySummary();
  }
  opts.onPending?.();

  opts.log.info(`Found ${pending.length} pending delivery entries — starting recovery`);

  const deadline = resolveDeliveryRecoveryDeadlineMs(opts.maxRecoveryMs);
  const summary = createEmptyDeliveryRecoverySummary();
  const onDeadlineExceeded = () => {
    // Budget deferral is not an attempt; preserve pending rows and retry counts.
    opts.log.warn(`Recovery time budget exceeded — remaining entries deferred to next startup`);
  };
  await recoveryCoordinator.scan({
    entries: pending.filter((entry) => shouldInspectQueuedDelivery(entry, Date.now())),
    laneKey: (entry) => recoveryLaneKey(entry, opts.cfg, stateContext.stateDir),
    loadEntry: (id) => loadUnfinishedDelivery(id, opts.stateDir, stateContext),
    deadlineMs: deadline,
    onDeadlineExceeded,
    onClaimConflict: (entry) => {
      opts.log.info(`Recovery skipped for delivery ${entry.id}: already being processed`);
    },
    onMissingEntry: (entry) => {
      opts.log.info(`Recovery skipped for delivery ${entry.id}: already gone`);
    },
    onEntry: (entry) =>
      processQueuedRecovery(
        { ...opts, entry },
        {
          kind: "startup",
          summary,
          deadline,
          onDeadlineExceeded,
        },
        stateContext,
        internalDeliver,
      ),
  });

  opts.log.info(
    `Delivery recovery complete: ${summary.recovered} recovered, ${summary.failed} failed, ${summary.skippedMaxRetries} skipped (max retries), ${summary.deferredBackoff} deferred (backoff)`,
  );
  return summary;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
