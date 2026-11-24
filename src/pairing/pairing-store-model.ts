import crypto from "node:crypto";
import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { resolvePairingRequestAccountId } from "./pairing-store-keys.js";
import type {
  PairingChannel,
  PairingRequestRecord,
  PairingRequestStatus,
} from "./pairing-store.types.js";

const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_MAX_ATTEMPTS = 500;
/**
 * How long a request stays approvable. An hour was short enough that a request
 * could become unapprovable before anyone looked at it, so this is a multi-day
 * window instead. Expiry no longer deletes the record: the request stays
 * listable as `expired`, because an access request nobody answered is exactly
 * the thing an operator must still be able to see.
 */
export const CHANNEL_PAIRING_PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A pending request older than this is conspicuous rather than merely waiting. */
export const CHANNEL_PAIRING_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
export const CHANNEL_PAIRING_PENDING_MAX = 3;
/** Retained non-pending records per channel account. Bounds the history table. */
export const CHANNEL_PAIRING_HISTORY_MAX = 25;

type PairingRequest = PairingRequestRecord;

/** Stable opaque id for approving a request without exposing its human pairing code. */
export function resolveChannelPairingRequestId(
  channel: PairingChannel,
  request: PairingRequest,
): string {
  const accountId = resolvePairingRequestAccountId(request);
  return crypto
    .createHash("sha256")
    .update(`${channel}\0${accountId}\0${request.id}\0${request.createdAt}`)
    .digest("base64url")
    .slice(0, 32);
}

function isExpired(entry: PairingRequest, nowMs: number): boolean {
  const createdAt = parseDateStringTimestampMs(entry.createdAt);
  return createdAt === undefined || nowMs - createdAt > CHANNEL_PAIRING_PENDING_TTL_MS;
}

/** Effective status, adding the derived `expired` to what the row stores. */
export function resolvePairingRequestStatus(
  entry: PairingRequest,
  nowMs: number = Date.now(),
): PairingRequestStatus {
  return entry.status === "pending" && isExpired(entry, nowMs) ? "expired" : entry.status;
}

/** Only a request that is still pending occupies a slot or can be approved. */
export function isPairingRequestPending(entry: PairingRequest, nowMs: number): boolean {
  return resolvePairingRequestStatus(entry, nowMs) === "pending";
}

/** The instant a pending request stops being approvable. */
export function resolvePairingRequestExpiresAt(entry: PairingRequest): string {
  const createdAt = parseDateStringTimestampMs(entry.createdAt) ?? 0;
  return new Date(createdAt + CHANNEL_PAIRING_PENDING_TTL_MS).toISOString();
}

/** A pending request left unanswered past the staleness window. */
export function isPairingRequestStale(entry: PairingRequest, nowMs: number = Date.now()): boolean {
  if (!isPairingRequestPending(entry, nowMs)) {
    return false;
  }
  const createdAt = parseDateStringTimestampMs(entry.createdAt);
  return createdAt !== undefined && nowMs - createdAt >= CHANNEL_PAIRING_STALE_AFTER_MS;
}

/** How long a pending request has waited, for logs and operator surfaces. */
export function resolvePairingRequestAgeMs(
  entry: PairingRequest,
  nowMs: number = Date.now(),
): number {
  const createdAt = parseDateStringTimestampMs(entry.createdAt);
  return createdAt === undefined ? 0 : Math.max(0, nowMs - createdAt);
}

function resolveLastSeenAt(entry: PairingRequest): number {
  return (
    parseDateStringTimestampMs(entry.lastSeenAt) ?? parseDateStringTimestampMs(entry.createdAt) ?? 0
  );
}

/** Orders retained history oldest-first so the oldest record is evicted first. */
function resolveHistoryOrder(entry: PairingRequest): number {
  return parseDateStringTimestampMs(entry.resolvedAt ?? "") ?? resolveLastSeenAt(entry);
}

export function requestMatchesAccountId(
  entry: PairingRequest,
  normalizedAccountId: string,
): boolean {
  return !normalizedAccountId || resolvePairingRequestAccountId(entry) === normalizedAccountId;
}

function groupIndexesByAccount(
  reqs: PairingRequest[],
  include: (entry: PairingRequest) => boolean,
): Map<string, Array<{ index: number; request: PairingRequest }>> {
  const grouped = new Map<string, Array<{ index: number; request: PairingRequest }>>();
  for (const [index, entry] of reqs.entries()) {
    if (!include(entry)) {
      continue;
    }
    const accountId = resolvePairingRequestAccountId(entry);
    const current = grouped.get(accountId);
    if (current) {
      current.push({ index, request: entry });
    } else {
      grouped.set(accountId, [{ index, request: entry }]);
    }
  }
  return grouped;
}

function collectExcessIndexes(params: {
  grouped: Map<string, Array<{ index: number; request: PairingRequest }>>;
  max: number;
  order: (entry: PairingRequest) => number;
  dropped: Set<number>;
}): void {
  for (const entries of params.grouped.values()) {
    if (entries.length <= params.max) {
      continue;
    }
    const sorted = entries.toSorted(
      (left, right) => params.order(left.request) - params.order(right.request),
    );
    for (const { index } of sorted.slice(0, sorted.length - params.max)) {
      params.dropped.add(index);
    }
  }
}

/**
 * Caps pending slots and retained history independently, per account. Retention
 * is what makes an unanswered request visible later, so a resolved record must
 * never consume a pending slot and a pending request must never be evicted to
 * make room for history.
 */
function pruneExcessRequestsByAccount(
  reqs: PairingRequest[],
  params: { maxPending: number; maxHistory: number; nowMs: number },
) {
  const droppedIndexes = new Set<number>();
  if (params.maxPending > 0) {
    collectExcessIndexes({
      grouped: groupIndexesByAccount(reqs, (entry) => isPairingRequestPending(entry, params.nowMs)),
      max: params.maxPending,
      order: resolveLastSeenAt,
      dropped: droppedIndexes,
    });
  }
  if (params.maxHistory >= 0) {
    collectExcessIndexes({
      grouped: groupIndexesByAccount(
        reqs,
        (entry) => !isPairingRequestPending(entry, params.nowMs),
      ),
      max: params.maxHistory,
      order: resolveHistoryOrder,
      dropped: droppedIndexes,
    });
  }
  return droppedIndexes.size === 0
    ? { requests: reqs, removed: false }
    : { requests: reqs.filter((_, index) => !droppedIndexes.has(index)), removed: true };
}

export function pruneRequests(reqs: PairingRequest[], nowMs: number) {
  return pruneExcessRequestsByAccount(reqs, {
    maxPending: CHANNEL_PAIRING_PENDING_MAX,
    maxHistory: CHANNEL_PAIRING_HISTORY_MAX,
    nowMs,
  });
}

function randomCode(): string {
  // Human-friendly: 8 chars, upper, no ambiguous chars (0O1I).
  let out = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    out += PAIRING_CODE_ALPHABET[crypto.randomInt(0, PAIRING_CODE_ALPHABET.length)];
  }
  return out;
}

export function generateUniqueCode(existing: Set<string>): string {
  for (let attempt = 0; attempt < PAIRING_CODE_MAX_ATTEMPTS; attempt += 1) {
    const code = randomCode();
    if (!existing.has(code)) {
      return code;
    }
  }
  throw new Error(
    `failed to generate unique pairing code after ${PAIRING_CODE_MAX_ATTEMPTS} attempts; existing code count: ${existing.size}`,
  );
}
