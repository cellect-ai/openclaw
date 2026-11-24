import { resolveMessageReceiptPrimaryId } from "../../channels/message/receipt.js";
import {
  countPhysicalOutboundSends,
  type OutboundDeliveryResult,
  type OutboundPayloadDeliveryOutcome,
} from "./deliver-types.js";
import {
  createDeliveryPlacementEvidenceRecorder,
  deliveryPlacementMatchesContext,
} from "./delivery-placement-evidence.js";
import type {
  DeliveryPublicationEvidence,
  PayloadPublicationEvidence,
  PayloadPublicationSuppression,
} from "./delivery-queue-publication.types.js";
import { normalizeTargetForProvider } from "./target-normalization.js";

export function capturePayloadPublicationSuppression(
  outcome: OutboundPayloadDeliveryOutcome,
): PayloadPublicationSuppression | undefined {
  return outcome.status === "suppressed" && outcome.reason !== "adapter_returned_no_identity"
    ? Object.freeze({ sourceIndex: outcome.index, reason: outcome.reason })
    : undefined;
}

export function hasCompletePayloadSuppression(
  parts: readonly PayloadPublicationSuppression[],
  sourcePayloadCount: number,
): boolean {
  return (
    sourcePayloadCount > 0 &&
    parts.length === sourcePayloadCount &&
    parts
      .toSorted((a, b) => a.sourceIndex - b.sourceIndex)
      .every((part, index) => part.sourceIndex === index)
  );
}

/** Capture before caller hooks can mutate the native outcome or provider receipt. */
export function capturePayloadPublicationEvidence(
  outcome: OutboundPayloadDeliveryOutcome,
  destination: DeliveryPublicationEvidence["destination"],
  captured?: WeakMap<OutboundDeliveryResult, DeliveryPublicationEvidence>,
): PayloadPublicationEvidence | undefined {
  if (outcome.status !== "sent" || outcome.incompleteReason) return undefined;
  const parts = captured ? outcome.results.map((result) => captured.get(result)) : undefined;
  if (parts?.some((part) => !part)) return undefined;
  const evidence = parts
    ? mergeDeliveryPublicationEvidence(parts.filter((part) => part !== undefined))
    : captureDeliveryPublicationEvidence(outcome.results, destination);
  return evidence ? { sourceIndex: outcome.index, evidence } : undefined;
}

export function mergeDeliveryPublicationEvidence(
  parts: readonly DeliveryPublicationEvidence[],
): DeliveryPublicationEvidence | undefined {
  const last = parts.at(-1);
  if (!last) return undefined;
  if (
    parts.some(
      (part) =>
        part.destination.channel !== last.destination.channel ||
        part.destination.to !== last.destination.to ||
        (part.destination.accountId ?? "default") !== (last.destination.accountId ?? "default") ||
        String(part.destination.threadId ?? "") !== String(last.destination.threadId ?? ""),
    )
  ) {
    throw new Error("Delivery publication received contradictory destination evidence");
  }
  const { primaryPlatformMessageId, resultCount: _lastCount, ...lastEvidence } = last;
  const resultCount = parts.reduce((count, part) => count + (part.resultCount ?? 0), 0);
  const completeNativeEvidence =
    Number.isSafeInteger(resultCount) &&
    resultCount > 0 &&
    parts.every(
      (part) =>
        typeof part.primaryPlatformMessageId === "string" &&
        Boolean(part.primaryPlatformMessageId.trim()) &&
        Number.isSafeInteger(part.resultCount) &&
        Number(part.resultCount) > 0,
    );
  return {
    ...lastEvidence,
    ...(completeNativeEvidence ? { primaryPlatformMessageId, resultCount } : {}),
    platformMessageIds: parts.flatMap((part) => part.platformMessageIds),
    placement: {
      channels: parts.flatMap((part) => part.placement.channels),
      targets: parts.flatMap((part) => part.placement.targets),
      threads: parts.flatMap((part) => part.placement.threads),
      invalid: parts.some((part) => part.placement.invalid),
    },
  };
}

/** Select the actual final physical provider event and retain every placement observation. */
export function captureDeliveryPublicationEvidence(
  results: readonly OutboundDeliveryResult[],
  destination: DeliveryPublicationEvidence["destination"],
): DeliveryPublicationEvidence | undefined {
  const placement = createDeliveryPlacementEvidenceRecorder();
  const platformMessageIds: string[] = [];
  for (const result of results) {
    if (result.outcome === "not_sent") continue;
    placement.observe(result);
    const parts = result.receipt?.parts.toSorted((a, b) => a.index - b.index);
    const ids = parts?.length
      ? parts.map((part) => part.platformMessageId)
      : result.receipt?.platformMessageIds.length
        ? result.receipt.platformMessageIds
        : [result.messageId];
    platformMessageIds.push(...ids.map((id) => id.trim()).filter(Boolean));
  }
  const platformMessageId = platformMessageIds.at(-1);
  if (!platformMessageId) return undefined;
  const observed = placement.snapshot();
  if (!deliveryPlacementMatchesContext(observed, destination)) {
    throw new Error(
      "Delivery publication received contradictory destination evidence PROBE " +
        JSON.stringify({ observed, destination }),
    );
  }
  const primaryIds = results.map((result) =>
    result.outcome === "not_sent"
      ? undefined
      : ((result.receipt ? resolveMessageReceiptPrimaryId(result.receipt) : undefined) ??
        (result.messageId.trim() || undefined)),
  );
  const primaryPlatformMessageId = primaryIds.at(-1);
  const resultCount = countPhysicalOutboundSends(results);
  const completeNativeEvidence =
    primaryPlatformMessageId &&
    primaryIds.every(Boolean) &&
    Number.isSafeInteger(resultCount) &&
    resultCount > 0;
  return {
    ...(completeNativeEvidence ? { primaryPlatformMessageId, resultCount } : {}),
    destination: {
      channel: destination.channel,
      to: destination.to,
      accountId: destination.accountId,
      threadId: destination.threadId,
    },
    normalizedTarget:
      normalizeTargetForProvider(destination.channel, destination.to) ?? destination.to,
    platformMessageId,
    platformMessageIds,
    placement: {
      ...observed,
      targets: observed.targets.map(
        (target) => normalizeTargetForProvider(destination.channel, target) ?? target,
      ),
    },
  };
}
