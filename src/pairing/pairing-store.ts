// Persists pairing challenges and approved channel account bindings in shared SQLite state.
import crypto from "node:crypto";
import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeNullableString,
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { getPairingAdapter } from "../channels/plugins/pairing.js";
import type { ChannelPairingAdapter } from "../channels/plugins/pairing.types.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveAllowFromAccountId } from "./pairing-store-keys.js";
import {
  readChannelPairingState,
  readChannelPairingStateFromDatabase,
  resolvePairingRequestAccountId,
  sqliteOptionsForEnv,
  writeChannelPairingStateToDatabase,
} from "./pairing-store-sqlite.js";
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

export type PairingRequest = PairingRequestRecord;

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

function normalizePairingAccountId(accountId?: string): string {
  return normalizeLowercaseStringOrEmpty(accountId);
}

function requestMatchesAccountId(entry: PairingRequest, normalizedAccountId: string): boolean {
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

function pruneRequests(reqs: PairingRequest[], nowMs: number) {
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

function generateUniqueCode(existing: Set<string>): string {
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

function normalizeId(value: string | number): string {
  return normalizeStringifiedOptionalString(value) ?? "";
}

function resolvePairingAdapter(
  channel: PairingChannel,
  pairingAdapter?: ChannelPairingAdapter,
): ChannelPairingAdapter | undefined {
  return pairingAdapter ?? getPairingAdapter(channel) ?? undefined;
}

function normalizeAllowEntry(
  channel: PairingChannel,
  entry: string,
  pairingAdapter?: ChannelPairingAdapter,
): string {
  const trimmed = entry.trim();
  if (!trimmed || trimmed === "*") {
    return "";
  }
  const adapter = resolvePairingAdapter(channel, pairingAdapter);
  const normalized = adapter?.normalizeAllowEntry ? adapter.normalizeAllowEntry(trimmed) : trimmed;
  const normalizedEntry = normalizeOptionalString(normalized) ?? "";
  return normalizedEntry === "*" ? "" : normalizedEntry;
}

function normalizeAllowFromInput(
  channel: PairingChannel,
  entry: string | number,
  pairingAdapter?: ChannelPairingAdapter,
): string {
  return normalizeAllowEntry(channel, normalizeId(entry), pairingAdapter);
}

function readAllowFromState(channel: PairingChannel, env: NodeJS.ProcessEnv, accountId?: string) {
  const resolvedAccountId = resolveAllowFromAccountId(accountId);
  return (readChannelPairingState(channel, env).allowFrom?.[resolvedAccountId] ?? []).slice();
}

async function updateAllowFromStoreEntry(
  params: AllowFromStoreEntryUpdateParams & {
    apply: (current: string[], normalized: string) => string[] | null;
  },
): Promise<{ changed: boolean; allowFrom: string[] }> {
  const assertCurrent = params.assertCurrent;
  const env = params.env ?? process.env;
  const accountId = resolveAllowFromAccountId(params.accountId);
  const normalized = normalizeAllowFromInput(params.channel, params.entry, params.pairingAdapter);
  return runOpenClawStateWriteTransaction((database) => {
    const state = readChannelPairingStateFromDatabase(database, params.channel);
    const current = (state.allowFrom?.[accountId] ?? []).slice();
    if (!normalized) {
      return { changed: false, allowFrom: current };
    }
    const next = params.apply(current, normalized);
    if (!next) {
      return { changed: false, allowFrom: current };
    }
    state.allowFrom ??= {};
    state.allowFrom[accountId] = next;
    assertCurrent?.();
    writeChannelPairingStateToDatabase(database, params.channel, state);
    return { changed: true, allowFrom: next };
  }, sqliteOptionsForEnv(env));
}

export async function readChannelAllowFromStore(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): Promise<string[]> {
  return readAllowFromState(channel, env, accountId);
}

export function readChannelAllowFromStoreSync(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): string[] {
  return readAllowFromState(channel, env, accountId);
}

type AllowFromStoreEntryUpdateParams = {
  channel: PairingChannel;
  entry: string | number;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
  pairingAdapter?: ChannelPairingAdapter;
  assertCurrent?: () => void;
};

export async function addChannelAllowFromStoreEntry(
  params: AllowFromStoreEntryUpdateParams,
): Promise<{ changed: boolean; allowFrom: string[] }> {
  return updateAllowFromStoreEntry({
    ...params,
    apply: (current, normalized) =>
      current.includes(normalized) ? null : [...current, normalized],
  });
}

export async function removeChannelAllowFromStoreEntry(
  params: AllowFromStoreEntryUpdateParams,
): Promise<{ changed: boolean; allowFrom: string[] }> {
  return updateAllowFromStoreEntry({
    ...params,
    apply: (current, normalized) => {
      const next = current.filter((entry) => entry !== normalized);
      return next.length === current.length ? null : next;
    },
  });
}

/**
 * Every retained request for the channel: pending, expired, approved and
 * dismissed. Callers that only want actionable ones filter on
 * {@link resolvePairingRequestStatus}.
 */
export async function listChannelPairingRequests(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): Promise<PairingRequest[]> {
  return runOpenClawStateWriteTransaction((database) => {
    const state = readChannelPairingStateFromDatabase(database, channel);
    const capped = pruneRequests(state.requests, Date.now());
    if (capped.removed) {
      state.requests = capped.requests;
      writeChannelPairingStateToDatabase(database, channel, state);
    }
    const normalizedAccountId = normalizePairingAccountId(accountId);
    return capped.requests
      .filter((entry) => requestMatchesAccountId(entry, normalizedAccountId))
      .toSorted((left, right) => {
        const createdOrder = left.createdAt.localeCompare(right.createdAt);
        if (createdOrder !== 0) {
          return createdOrder;
        }
        const accountOrder = resolvePairingRequestAccountId(left).localeCompare(
          resolvePairingRequestAccountId(right),
        );
        return accountOrder || left.id.localeCompare(right.id);
      });
  }, sqliteOptionsForEnv(env));
}

export async function upsertChannelPairingRequest(params: {
  channel: PairingChannel;
  id: string | number;
  accountId: string;
  meta?: Record<string, string | undefined | null>;
  env?: NodeJS.ProcessEnv;
  /** Extension channels can pass their adapter directly to bypass registry lookup. */
  pairingAdapter?: ChannelPairingAdapter;
}): Promise<{ code: string; created: boolean }> {
  const env = params.env ?? process.env;
  return runOpenClawStateWriteTransaction((database) => {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const id = normalizeId(params.id);
    const accountId = normalizePairingAccountId(params.accountId) || DEFAULT_ACCOUNT_ID;
    const baseMeta = params.meta
      ? Object.fromEntries(
          Object.entries(params.meta)
            .map(([key, value]) => [key, normalizeOptionalString(value) ?? ""] as const)
            .filter(([, value]) => Boolean(value)),
        )
      : undefined;
    const meta = { ...baseMeta, accountId };
    const state = readChannelPairingStateFromDatabase(database, params.channel);
    let requests = state.requests;
    const existingIndex = requests.findIndex(
      (request) => request.id === id && requestMatchesAccountId(request, accountId),
    );
    const existing = existingIndex >= 0 ? requests[existingIndex] : undefined;
    const existingCodes = new Set(
      requests.map((request) => (normalizeOptionalString(request.code) ?? "").toUpperCase()),
    );

    // A still-pending request is reused, so a repeat sender keeps one code and
    // gets the reminder rather than a second challenge.
    if (existing && isPairingRequestPending(existing, nowMs)) {
      const code = normalizeOptionalString(existing.code) || generateUniqueCode(existingCodes);
      requests[existingIndex] = {
        id,
        code,
        createdAt: existing.createdAt,
        lastSeenAt: now,
        status: "pending",
        meta,
      };
      state.requests = pruneRequests(requests, nowMs).requests;
      writeChannelPairingStateToDatabase(database, params.channel, state);
      return { code, created: false };
    }

    const capped = pruneRequests(requests, nowMs);
    requests = capped.requests;
    // An expired, dismissed or previously approved record is history, not a
    // live request: the sender asking again starts a fresh one with a new code.
    const retainedIndex = existing
      ? requests.findIndex(
          (request) => request.id === id && requestMatchesAccountId(request, accountId),
        )
      : -1;
    const pendingCount = requests.filter(
      (request, index) =>
        index !== retainedIndex &&
        requestMatchesAccountId(request, accountId) &&
        isPairingRequestPending(request, nowMs),
    ).length;
    if (CHANNEL_PAIRING_PENDING_MAX > 0 && pendingCount >= CHANNEL_PAIRING_PENDING_MAX) {
      if (capped.removed) {
        state.requests = requests;
        writeChannelPairingStateToDatabase(database, params.channel, state);
      }
      return { code: "", created: false };
    }

    const code = generateUniqueCode(existingCodes);
    const created: PairingRequest = {
      id,
      code,
      createdAt: now,
      lastSeenAt: now,
      status: "pending",
      meta,
    };
    state.requests =
      retainedIndex >= 0
        ? requests.map((request, index) => (index === retainedIndex ? created : request))
        : [...requests, created];
    writeChannelPairingStateToDatabase(database, params.channel, state);
    return { code, created: true };
  }, sqliteOptionsForEnv(env));
}

type ResolvePairingRequestParams = {
  channel: PairingChannel;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
  pairingAdapter?: ChannelPairingAdapter;
  matches: (request: PairingRequest) => boolean;
  approve: boolean;
};

async function resolveChannelPairingRequest(
  params: ResolvePairingRequestParams,
): Promise<{ id: string; entry: PairingRequest } | null> {
  const env = params.env ?? process.env;
  return runOpenClawStateWriteTransaction((database) => {
    const nowMs = Date.now();
    const state = readChannelPairingStateFromDatabase(database, params.channel);
    const pruned = pruneRequests(state.requests, nowMs);
    const accountId = normalizePairingAccountId(params.accountId);
    // Only a live request resolves. An expired one stays listed as expired and
    // has to be asked for again, so an approval always answers a request the
    // sender still wants rather than reviving a code that aged out of a chat log.
    const index = pruned.requests.findIndex(
      (request) =>
        requestMatchesAccountId(request, accountId) &&
        isPairingRequestPending(request, nowMs) &&
        params.matches(request),
    );
    if (index < 0) {
      if (pruned.removed) {
        state.requests = pruned.requests;
        writeChannelPairingStateToDatabase(database, params.channel, state);
      }
      return null;
    }
    const entry = pruned.requests[index];
    if (!entry) {
      return null;
    }
    const resolved: PairingRequest = {
      ...entry,
      status: params.approve ? "approved" : "dismissed",
      resolvedAt: new Date(nowMs).toISOString(),
    };
    pruned.requests[index] = resolved;
    state.requests = pruneRequests(pruned.requests, nowMs).requests;

    if (params.approve) {
      const allowAccountId = resolveAllowFromAccountId(
        normalizeOptionalString(params.accountId) ?? normalizeOptionalString(entry.meta?.accountId),
      );
      const currentAllow = state.allowFrom?.[allowAccountId] ?? [];
      const adapter = resolvePairingAdapter(params.channel, params.pairingAdapter);
      // Channels with key-bound handoffs can persist an opaque approval token
      // derived from request metadata instead of a durable sender allowlist id.
      const approvalEntry = adapter?.resolveApprovalStoreEntry
        ? adapter.resolveApprovalStoreEntry({
            id: entry.id,
            ...(entry.meta ? { meta: entry.meta } : {}),
          })
        : entry.id;
      const normalizedAllow =
        approvalEntry == null
          ? ""
          : normalizeAllowFromInput(params.channel, approvalEntry, adapter);
      if (normalizedAllow && !currentAllow.includes(normalizedAllow)) {
        state.allowFrom ??= {};
        state.allowFrom[allowAccountId] = [...currentAllow, normalizedAllow];
      }
    }

    writeChannelPairingStateToDatabase(database, params.channel, state);
    return { id: resolved.id, entry: resolved };
  }, sqliteOptionsForEnv(env));
}

export async function approveChannelPairingCode(params: {
  channel: PairingChannel;
  code: string;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
  pairingAdapter?: ChannelPairingAdapter;
}): Promise<{ id: string; entry: PairingRequest } | null> {
  const code = (normalizeNullableString(params.code) ?? "").toUpperCase();
  if (!code) {
    return null;
  }
  return resolveChannelPairingRequest({
    ...params,
    matches: (request) => request.code.toUpperCase() === code,
    approve: true,
  });
}

/** Approves a pending request by opaque id without exposing its pairing code. */
export async function approveChannelPairingRequest(params: {
  channel: PairingChannel;
  requestId: string;
  accountId: string;
  env?: NodeJS.ProcessEnv;
  pairingAdapter?: ChannelPairingAdapter;
}): Promise<{ id: string; entry: PairingRequest } | null> {
  const requestId = normalizeOptionalString(params.requestId);
  if (!requestId) {
    return null;
  }
  return resolveChannelPairingRequest({
    ...params,
    matches: (request) => resolveChannelPairingRequestId(params.channel, request) === requestId,
    approve: true,
  });
}

/** Dismisses a pending request without blocking the sender from requesting again. */
export async function dismissChannelPairingRequest(params: {
  channel: PairingChannel;
  requestId: string;
  accountId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ id: string; entry: PairingRequest } | null> {
  const requestId = normalizeOptionalString(params.requestId);
  if (!requestId) {
    return null;
  }
  return resolveChannelPairingRequest({
    ...params,
    matches: (request) => resolveChannelPairingRequestId(params.channel, request) === requestId,
    approve: false,
  });
}
