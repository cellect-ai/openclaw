import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";

const LEGACY_KEYS = new Set([
  "id",
  "enqueuedAt",
  "retryCount",
  "acknowledgedAt",
  "completionRetention",
  "recoveryState",
]);

/** Exact shipped 10.4 terminal payload: proves obligation closure, never a provider result ID. */
export function isLegacySettledLifecycleObligation(value: unknown, expectedId: string): boolean {
  if (
    !isRecord(value) ||
    !/^lifecycle:[a-f0-9]{64}$/.test(expectedId) ||
    value.id !== expectedId ||
    Object.keys(value).some((key) => !LEGACY_KEYS.has(key)) ||
    value.retryCount !== 0 ||
    value.recoveryState !== "completed_bounded" ||
    !Number.isSafeInteger(value.acknowledgedAt) ||
    Number(value.acknowledgedAt) <= 0 ||
    value.enqueuedAt !== value.acknowledgedAt
  )
    return false;
  const retention = value.completionRetention;
  return (
    isRecord(retention) &&
    Object.keys(retention).length === 3 &&
    retention.idPrefix === "lifecycle:" &&
    retention.maxAgeMs === 30 * 86400_000 &&
    retention.maxEntries === 100_000
  );
}

/** Read raw terminal bytes before generic queue inflation can replace inconsistent payload IDs. */
export function hasLegacySettledLifecycleObligationInDatabase(
  database: OpenClawStateDatabase,
  expectedId: string,
): boolean {
  const queue = getNodeSqliteKysely<Pick<DB, "delivery_queue_entries">>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    queue
      .selectFrom("delivery_queue_entries")
      .select([
        "entry_json",
        "enqueued_at",
        "retry_count",
        "recovery_state",
        "last_attempt_at",
        "last_error",
        "platform_send_started_at",
      ])
      .where("queue_name", "=", "conversation-lifecycle-v2")
      .where("id", "=", expectedId)
      .where("status", "=", "completed"),
  );
  if (
    !row ||
    row.retry_count !== 0 ||
    row.recovery_state !== "completed_bounded" ||
    row.last_attempt_at !== null ||
    row.last_error !== null ||
    row.platform_send_started_at !== null
  )
    return false;
  let value: unknown;
  try {
    value = JSON.parse(row.entry_json);
  } catch {
    return false;
  }
  return (
    isRecord(value) &&
    value.enqueuedAt === row.enqueued_at &&
    isLegacySettledLifecycleObligation(value, expectedId)
  );
}
