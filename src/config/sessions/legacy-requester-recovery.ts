import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export type LegacyRequesterRecoveryRefusal = {
  reason: "pending-reply" | "pending-delivery" | "recovery-cycle" | "interrupted-claim";
  warning: string;
};

/**
 * Inspect raw legacy state before canonical decoding drops the retired slots.
 * Attribution (including an exact transcript event) is not a retained authenticated
 * source. The shipped fork stored no native profile/scope/channel authorization
 * snapshot, so current identity linkage cannot authorize its unfinished recovery.
 * This returns no executable authority and never modifies the record.
 */
export function inspectLegacyRequesterRecovery(
  entry: Record<string, unknown>,
): LegacyRequesterRecoveryRefusal | undefined {
  const hasRequester =
    entry.restartRecoverySourceIngress === "channel" ||
    [
      "restartRecoveryRequesterAccountId",
      "restartRecoveryRequesterSenderId",
      "restartRecoveryRequesterEventId",
      "restartRecoveryRequesterChatId",
    ].some((key) => entry[key] !== undefined);
  if (!hasRequester) return undefined;

  const cycle = isRecord(entry.mainRestartRecovery) ? entry.mainRestartRecovery : undefined;
  // Explicit terminal recovery is governed by the native raw tombstone migration:
  // its run/generation checks, verified backup, and unresolved-delivery report.
  // It is never an automatic continuation or authorization to resend.
  if (cycle && isRecord(cycle.tombstone)) return undefined;

  const refusal = (reason: LegacyRequesterRecoveryRefusal["reason"]) => ({
    reason,
    warning:
      "Unresolved legacy requester recovery has no retained native authenticated source. Preserve the original session entry and transcript; inspect the pending work and delivery outcome before continuing through a new authenticated request. Stored sender/event attribution and current profile linkage do not authorize replay.",
  });
  if (
    entry.restartRecoveryBeforeAgentReplyState === "admitted" ||
    entry.restartRecoveryBeforeAgentReplyState === "pending" ||
    entry.restartRecoveryBeforeAgentReplyState === "continue"
  )
    return refusal("pending-reply");
  if (entry.restartRecoveryDeliveryReceiptState === "terminal-pending") {
    return refusal("pending-delivery");
  }
  const runId = normalizeOptionalString(entry.restartRecoveryDeliveryRunId);
  const sourceId = normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId);
  const pending = isRecord(entry.pendingFinalDelivery) ? entry.pendingFinalDelivery : undefined;
  const deliverySettled =
    pending &&
    Array.isArray(pending.deliveries) &&
    pending.deliveries.length > 0 &&
    pending.deliveries.every(
      (delivery) =>
        isRecord(delivery) && (delivery.state === "delivered" || delivery.state === "suppressed"),
    );
  if (
    (pending &&
      !deliverySettled &&
      (!pending.sourceRunId ||
        pending.sourceRunId === runId ||
        pending.sourceRunId === sourceId)) ||
    entry.pendingFinalDelivery === true ||
    normalizeOptionalString(entry.pendingFinalDeliveryText)
  )
    return refusal("pending-delivery");
  // A cycle is durable unfinished custody even after the old six-hour resume
  // window. Do not silently retire it because it is old or malformed.
  if (entry.mainRestartRecovery !== undefined) return refusal("recovery-cycle");
  const interrupted = entry.status === "interrupted" || entry.abortedLastRun === true;
  const ownsCurrentRun =
    runId && (runId === entry.activeWriterRunId || runId === entry.lifecycleRunId);
  const explicitlyTerminal =
    Array.isArray(entry.restartRecoveryTerminalRunIds) &&
    sourceId &&
    entry.restartRecoveryTerminalRunIds.includes(sourceId);
  if (
    (!explicitlyTerminal && interrupted && (runId || sourceId)) ||
    (ownsCurrentRun && (entry.status === "running" || entry.status === "queued"))
  )
    return refusal("interrupted-claim");
  // Sender/event residue alone, or an explicitly terminal source without another
  // pending obligation, must not veto unrelated current sessions.
  return undefined;
}
