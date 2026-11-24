import type { PluginStateOperationHandler } from "openclaw/plugin-sdk/plugin-state-runtime";

export const NOTICE_COOLDOWN_MS = 30 * 60 * 1000;
export const NOTICE_WINDOW_MS = 60 * 60 * 1000;
export const NOTICE_WINDOW_CAP = 5;
export const NOTICE_STORE_OPTIONS = {
  namespace: "admin-action-notices",
  maxEntries: 1_000,
  defaultTtlMs: NOTICE_WINDOW_MS,
  overflowPolicy: "reject-new" as const,
};

export type NoticeClaim = {
  countPrefix: string;
  dedupeKey: string;
  countKey: string;
  claimId: string;
};
export type NoticeOperations = {
  claim: { input: NoticeClaim; output: { ok: true } | { ok: false; reason: "duplicate" | "cap" } };
  release: { input: NoticeClaim; output: undefined };
};

/** The native worker transaction owns the whole admission, including deployed legacy rows. */
export const runNoticeOperation: PluginStateOperationHandler<NoticeOperations> = (command, tx) => {
  const { countPrefix, dedupeKey, countKey, claimId } = command.input;
  if (command.type === "release") {
    for (const key of [dedupeKey, countKey]) {
      const row = tx.lookup(0, key);
      if (row && typeof row === "object" && "claimId" in row && row.claimId === claimId) {
        tx.delete(0, key);
      }
    }
    return undefined;
  }
  // entries/lookup exclude expired rows using the worker's transaction clock.
  // Older {at} rows continue to count without rewriting or extending their TTL.
  if (
    tx.entries(0).filter((entry) => entry.key.startsWith(countPrefix)).length >= NOTICE_WINDOW_CAP
  ) {
    return { ok: false, reason: "cap" };
  }
  if (tx.lookup(0, dedupeKey) !== undefined) {
    return { ok: false, reason: "duplicate" };
  }
  const value = { at: Date.now(), claimId };
  tx.set(0, dedupeKey, value, { ttlMs: NOTICE_COOLDOWN_MS });
  tx.set(0, countKey, value, { ttlMs: NOTICE_WINDOW_MS });
  return { ok: true };
};
