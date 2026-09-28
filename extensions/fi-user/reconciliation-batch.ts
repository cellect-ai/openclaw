// The periodic reconciler shares a single gateway with live chat, Matrix
// projection, Slack Socket Mode, and Discord.  It may not admit a burst of
// independent network repairs just because each individual repair is bounded.
// One maintenance item per lane is the maximum; the owning scheduler rotates
// lanes so ACL repair, historical recovery, and direct-message recovery remain
// fair without competing with a live turn.
export const RECONCILE_BATCH_SIZE = 1;

// Reading a Slack history and serializing it into a projection is materially
// more expensive than reconciling a room's membership.  Keep repair work
// responsive by admitting one historical snapshot at a time; live delivery is
// still immediate and is deliberately not subject to this maintenance budget.
export const RECONCILE_HISTORY_BATCH_SIZE = 1;
/** Default full-snapshot refreshes of drifted bound rooms per reconciler tick. */
export const RECONCILE_FULL_REFRESH_BUDGET = 1;

// Backlog recovery remains globally serialized: a reconciliation pass admits
// at most one maintenance item from one lane.  While durable work remains we
// schedule the next pass promptly instead of sleeping a full minute between
// items.  The network operation itself must settle before this delay starts,
// so this cannot create concurrent Slack/Fi repair bursts.
export const RECONCILE_BACKLOG_DELAY_MS = 1_000;
export const RECONCILE_IDLE_DELAY_MS = 60_000;

// A source that failed is not new work. Retrying it on the backlog cadence
// turned a handful of broken Slack roots into a permanent one-second loop
// against Fi, Matrix and Slack, so each failure waits exponentially longer
// (5 min doubling to 1 h) and is reported instead of keeping a scan open.
const RECONCILE_RETRY_BASE_MS = 300_000;
const RECONCILE_RETRY_MAX_MS = 3_600_000;

export function reconcileRetryDelay(
  failures: number,
  baseMs = RECONCILE_RETRY_BASE_MS,
  maxMs = RECONCILE_RETRY_MAX_MS,
): number {
  return Math.min(baseMs * 2 ** Math.max(0, failures - 1), maxMs);
}

// A DM whose snapshot failed has had its readers revoked, so it heals on a
// much shorter backoff than a historical source: 30 s doubling to 5 min.
export function directRetryDelay(failures: number): number {
  return reconcileRetryDelay(failures, 30_000, 300_000);
}

export type ProjectionMaintenanceLane = "channel" | "detached" | "direct";

export function nextMaintenanceLane(lane: ProjectionMaintenanceLane): ProjectionMaintenanceLane {
  return lane === "channel" ? "detached" : lane === "detached" ? "direct" : "channel";
}

export function takeSweepBatch(
  keys: readonly string[],
  seen: Set<string>,
  limit: number,
): Set<string> {
  const current = new Set(keys);
  for (const key of seen) {
    if (!current.has(key)) {
      seen.delete(key);
    }
  }
  if (keys.length > 0 && keys.every((key) => seen.has(key))) {
    seen.clear();
  }
  const batch = new Set(keys.filter((key) => !seen.has(key)).slice(0, limit));
  for (const key of batch) {
    seen.add(key);
  }
  return batch;
}

export function takePendingOrRotatingBatch(
  keys: readonly string[],
  completed: ReadonlySet<string>,
  cursor: string,
  limit: number,
): { batch: Set<string>; cursor: string } {
  const pending = keys.filter((key) => !completed.has(key));
  const ordered = pending.length
    ? pending
    : [...keys.filter((key) => key > cursor), ...keys.filter((key) => key <= cursor)];
  const batch = new Set(ordered.slice(0, limit));
  return { batch, cursor: [...batch].at(-1) ?? cursor };
}
