import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeSessionColorValue,
  normalizeSessionIconValue,
} from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { inspectLegacyRequesterRecovery } from "./legacy-requester-recovery.js";
import { SessionStoreMigrationRequiredError } from "./migration-required.js";
import type { CompletedFinalDelivery } from "./pending-final-delivery-types.js";
import { hasLegacySessionEntryState } from "./session-entry-state-format.js";
import { assertSupportedSessionStoreEntry } from "./supported-session-store.js";
import type { PendingTranscriptRepairState, SessionEntry } from "./types.js";

function normalizeSessionEntryArchiveReason(
  value: unknown,
): SessionEntry["archiveReason"] | undefined {
  return value === "manual" ||
    value === "active-session-cap" ||
    value === "age-retention" ||
    value === "stale-dashboard" ||
    value === "restart-recovery"
    ? value
    : undefined;
}

export function normalizeOptionalTimestamp(value: unknown): number | undefined {
  return value === undefined ? undefined : (asNonNegativeFiniteNumber(value) ?? 0);
}

/** Removes retired and projected fields before a session entry is persisted or returned. */
export function projectCanonicalSessionEntryShape(
  value: Partial<
    Record<
      | keyof SessionEntry
      | "sessionFile"
      | "transcriptPath"
      | "conversationLink"
      | "mainRestartRecovery"
      | "resumeAfterRestart"
      | "titleRefinement"
      | "owner"
      | "participants"
      | "participantCount",
      unknown
    >
  >,
): SessionEntry {
  assertSupportedSessionStoreEntry(value);
  const requesterRecovery = inspectLegacyRequesterRecovery(value);
  if (requesterRecovery) {
    throw new SessionStoreMigrationRequiredError(requesterRecovery.warning);
  }
  if (hasLegacySessionEntryState(value)) {
    throw new SessionStoreMigrationRequiredError(
      "Legacy session entry state requires migration; stop the Gateway and run openclaw doctor --fix.",
    );
  }
  const {
    sessionFile: _retiredSessionFile,
    transcriptPath: _retiredTranscriptPath,
    conversationLink: _retiredConversationLink,
    titleRefinement: _retiredTitleRefinement,
    owner: _projectedOwner,
    participants: _projectedParticipants,
    participantCount: _projectedParticipantCount,
    ...canonicalValue
  } = value;
  // Keep only the cycle for startup's upgrade bridge; never restore execution snapshots.
  // Remove once stable includes the graceful-restart redesign (#185730).
  const recovery = canonicalValue.mainRestartRecovery;
  if (
    isRecord(recovery) &&
    typeof recovery.cycleId === "string" &&
    recovery.cycleId.length > 0 &&
    !recovery.tombstone
  ) {
    canonicalValue.mainRestartRecovery = { cycleId: recovery.cycleId };
  } else {
    delete canonicalValue.mainRestartRecovery;
  }
  // Retired execution-recovery metadata is inert on existing installs.
  for (const key of Object.keys(canonicalValue)) {
    if (
      key === "pendingExecNotifications" ||
      key === "subagentRecovery" ||
      key.startsWith("restartRecovery")
    ) {
      Reflect.deleteProperty(canonicalValue, key);
    }
  }
  const setOptionalField = (key: keyof typeof canonicalValue, normalized: unknown) => {
    if (normalized) {
      canonicalValue[key] = normalized;
    } else {
      delete canonicalValue[key];
    }
  };
  setOptionalField(
    "clientCapabilities",
    Array.isArray(canonicalValue.clientCapabilities)
      ? [
          ...new Set(
            canonicalValue.clientCapabilities.filter(
              (cap): cap is string => typeof cap === "string",
            ),
          ),
        ].toSorted()
      : undefined,
  );
  const icon =
    typeof canonicalValue.icon === "string" ? normalizeSessionIconValue(canonicalValue.icon) : null;
  setOptionalField("icon", icon);
  const color =
    typeof canonicalValue.color === "string"
      ? normalizeSessionColorValue(canonicalValue.color)
      : null;
  setOptionalField("color", color);
  setOptionalField(
    "pendingFinalDelivery",
    normalizePendingFinalDelivery(canonicalValue.pendingFinalDelivery),
  );
  setOptionalField(
    "pendingDeliveryNotice",
    normalizePendingDeliveryNotice(canonicalValue.pendingDeliveryNotice),
  );
  if (canonicalValue.completedFinalDeliveries !== undefined) {
    const receipts = canonicalValue.completedFinalDeliveries;
    if (!Array.isArray(receipts) || receipts.length > 64)
      throw new Error("Invalid native final receipt history");
    canonicalValue.completedFinalDeliveries = receipts.map(normalizeCompletedFinalDelivery);
  }
  setOptionalField(
    "pendingTranscriptRepair",
    normalizePendingTranscriptRepair(canonicalValue.pendingTranscriptRepair),
  );
  setOptionalField("fallbackNotice", normalizeFallbackNotice(canonicalValue.fallbackNotice));
  setOptionalField("memoryFlush", normalizeMemoryFlush(canonicalValue.memoryFlush));
  const archiveReason = normalizeSessionEntryArchiveReason(canonicalValue.archiveReason);
  if (canonicalValue.archivedAt !== undefined) {
    setOptionalField("archiveReason", archiveReason);
  } else {
    delete canonicalValue.archivedBy;
    delete canonicalValue.archiveReason;
  }
  // An archived entry never carries a snooze: automatic archival (cap, age,
  // stale-dashboard) writes archive facts without the patch path, and a later
  // restore must not resurface a still-hidden session.
  if (
    canonicalValue.archivedAt !== undefined ||
    typeof canonicalValue.snoozedUntil !== "number" ||
    !Number.isFinite(canonicalValue.snoozedUntil) ||
    canonicalValue.snoozedUntil <= 0
  ) {
    delete canonicalValue.snoozedUntil;
    delete canonicalValue.snoozedAt;
  }
  return canonicalValue as unknown as SessionEntry;
}

/** Removes the runtime-only skill catalog without mutating the live session snapshot. */
export function stripRuntimeOnlySessionSkillsFields(entry: SessionEntry): SessionEntry {
  const snapshot = entry.skillsSnapshot;
  if (snapshot?.resolvedSkills === undefined && snapshot?.discoverySkills === undefined) {
    return entry;
  }
  const {
    resolvedSkills: _dropResolved,
    discoverySkills: _dropDiscovery,
    ...skillsSnapshot
  } = snapshot;
  return { ...entry, skillsSnapshot };
}

export function normalizePendingFinalDelivery(
  value: unknown,
): SessionEntry["pendingFinalDelivery"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const createdAt = normalizeOptionalTimestamp(value.createdAt);
  if (createdAt === undefined) {
    return undefined;
  }
  const intentId = normalizeOptionalString(value.intentId);
  const sourceRunId = normalizeOptionalString(value.sourceRunId);
  const sourceMessageId = normalizeOptionalString(value.sourceMessageId);
  const deliveries = normalizePendingFinalDeliveries(value.deliveries);
  const sourceGeneration = normalizeOptionalString(value.sourceGeneration);
  if (
    value.dispatchState !== undefined &&
    ((value.dispatchState !== "open" && value.dispatchState !== "closed") ||
      !sourceRunId ||
      !sourceGeneration ||
      !Array.isArray(value.deliveries) ||
      (deliveries?.length ?? 0) !== value.deliveries.length ||
      new Set(deliveries?.map(({ id }) => id)).size !== (deliveries?.length ?? 0) ||
      (value.dispatchClosure !== undefined &&
        value.dispatchClosure !== "completed" &&
        value.dispatchClosure !== "retired"))
  ) {
    throw new Error("Invalid native final dispatch custody");
  }
  const base: Omit<NonNullable<SessionEntry["pendingFinalDelivery"]>, "kind" | "text"> = {
    createdAt,
    ...(isRecord(value.context) ? { context: value.context } : {}),
    ...(intentId ? { intentId } : {}),
    ...(sourceRunId ? { sourceRunId } : {}),
    ...(sourceMessageId ? { sourceMessageId } : {}),
    ...(deliveries ? { deliveries } : {}),
    ...(value.dispatchState
      ? {
          dispatchState: value.dispatchState as "open" | "closed",
          sourceGeneration,
          ...(value.dispatchClosure === "retired" || value.dispatchClosure === "completed"
            ? { dispatchClosure: value.dispatchClosure }
            : {}),
          deliveries: deliveries ?? [],
          ...(value.projectionConsumers !== undefined
            ? { projectionConsumers: normalizeProjectionConsumers(value.projectionConsumers) }
            : {}),
        }
      : {}),
  };
  if (value.kind === "transport-only") {
    return { kind: "transport-only", ...base };
  }
  const text = normalizeOptionalString(value.text);
  return value.kind === "replayable" && text ? { kind: "replayable", text, ...base } : undefined;
}

function normalizeProjectionConsumers(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    value.some((id) => typeof id !== "string" || !id || id.length > 256) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("Invalid native final projection consumers");
  }
  return value as string[];
}

function normalizeCompletedFinalDelivery(value: unknown): CompletedFinalDelivery {
  if (
    !isRecord(value) ||
    !normalizeOptionalString(value.sessionId) ||
    !normalizeOptionalString(value.intentId) ||
    !normalizeOptionalString(value.sourceRunId) ||
    !normalizeOptionalString(value.sourceGeneration) ||
    !Number.isSafeInteger(value.completedAt) ||
    Number(value.completedAt) < 0 ||
    !Array.isArray(value.deliveries) ||
    (value.closure !== "completed" && value.closure !== "retired")
  ) {
    throw new Error("Invalid native final completion receipt");
  }
  const deliveries = normalizePendingFinalDeliveries(value.deliveries) ?? [];
  if (
    deliveries.length !== value.deliveries.length ||
    new Set(deliveries.map(({ id }) => id)).size !== deliveries.length ||
    deliveries.some(({ state }) => state !== "delivered" && state !== "suppressed")
  )
    throw new Error("Unsettled native final completion receipt");
  return {
    sessionId: value.sessionId as string,
    intentId: value.intentId as string,
    sourceRunId: value.sourceRunId as string,
    sourceGeneration: value.sourceGeneration as string,
    completedAt: value.completedAt as number,
    closure: value.closure === "retired" ? "retired" : "completed",
    ...(isRecord(value.context) ? { context: value.context } : {}),
    deliveries,
    projectionConsumers: normalizeProjectionConsumers(value.projectionConsumers),
  };
}

function normalizePendingFinalDeliveries(
  value: unknown,
): NonNullable<NonNullable<SessionEntry["pendingFinalDelivery"]>["deliveries"]> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const deliveries: NonNullable<NonNullable<SessionEntry["pendingFinalDelivery"]>["deliveries"]> =
    value.flatMap((item) => {
      const id = isRecord(item) ? normalizeOptionalString(item.id) : undefined;
      const state = isRecord(item) ? item.state : undefined;
      const receipt = isRecord(item) && isRecord(item.receipt) ? item.receipt : undefined;
      const platformMessageId = normalizeOptionalString(receipt?.platformMessageId);
      const resultCount = receipt?.resultCount;
      return id &&
        (state === "prepared" ||
          state === "queued" ||
          state === "delivered" ||
          state === "suppressed" ||
          state === "unknown")
        ? [
            {
              id,
              state,
              ...(platformMessageId && Number.isSafeInteger(resultCount) && Number(resultCount) > 0
                ? {
                    receipt: {
                      platformMessageId,
                      resultCount: Number(resultCount),
                      ...(normalizeOptionalString(receipt?.finalPlatformMessageId)
                        ? {
                            finalPlatformMessageId: normalizeOptionalString(
                              receipt?.finalPlatformMessageId,
                            ),
                          }
                        : {}),
                    },
                  }
                : {}),
            },
          ]
        : [];
    });
  return deliveries.length > 0 ? deliveries : undefined;
}

function normalizePendingDeliveryNotice(
  value: unknown,
): SessionEntry["pendingDeliveryNotice"] | undefined {
  if (!isRecord(value) || !isRecord(value.context)) {
    return undefined;
  }
  const createdAt = normalizeOptionalTimestamp(value.createdAt);
  const intentId = normalizeOptionalString(value.intentId);
  const sourceMessageId = normalizeOptionalString(value.sourceMessageId);
  return createdAt !== undefined &&
    intentId &&
    (value.state === "owed" || value.state === "unresolved" || value.state === "acknowledged")
    ? {
        createdAt,
        context: value.context,
        intentId,
        state: value.state,
        ...(sourceMessageId ? { sourceMessageId } : {}),
      }
    : undefined;
}

function normalizePendingTranscriptRepair(
  value: unknown,
): SessionEntry["pendingTranscriptRepair"] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const normalized: NonNullable<SessionEntry["pendingTranscriptRepair"]> = [];
  for (const item of value) {
    const record = normalizePendingTranscriptRepairRecord(item);
    if (record) {
      normalized.push(record);
    }
  }
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePendingTranscriptRepairRecord(
  value: unknown,
): PendingTranscriptRepairState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = normalizeOptionalString(value.id);
  const text = normalizeOptionalString(value.text);
  const createdAt = normalizeOptionalTimestamp(value.createdAt);
  if (!id || !text || createdAt === undefined) {
    return undefined;
  }
  const provider = normalizeOptionalString(value.provider);
  const model = normalizeOptionalString(value.model);
  return {
    id,
    text,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    createdAt,
  };
}

export function normalizeFallbackNotice(
  value: unknown,
): SessionEntry["fallbackNotice"] | undefined {
  if (!isRecord(value) || value.kind !== "active") {
    return undefined;
  }
  const selectedModel = normalizeOptionalString(value.selectedModel);
  const activeModel = normalizeOptionalString(value.activeModel);
  const reason = normalizeOptionalString(value.reason);
  return selectedModel && activeModel
    ? { kind: "active", selectedModel, activeModel, ...(reason ? { reason } : {}) }
    : undefined;
}

export function normalizeMemoryFlush(value: unknown): SessionEntry["memoryFlush"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const compactionCount = normalizeCount(value.compactionCount);
  if (value.kind === "succeeded" && compactionCount !== undefined) {
    return { kind: "succeeded", compactionCount };
  }
  const failureCount = normalizeCount(value.failureCount);
  if (value.kind !== "failed" || !failureCount) {
    return undefined;
  }
  return {
    kind: "failed",
    ...(compactionCount !== undefined ? { compactionCount } : {}),
    failureCount,
  };
}

export function normalizeCount(value: unknown): number | undefined {
  const number = asNonNegativeFiniteNumber(value);
  return number === undefined ? undefined : Math.floor(number);
}
