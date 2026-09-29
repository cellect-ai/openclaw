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
const RECONCILE_BACKLOG_DELAY_MS = 1_000;
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

/** Coalesce new hook failures during an outage; live events still project immediately. */
export function createLiveChannelRetryGate() {
  const failures = new Map<string, { count: number; nextAt: number }>();
  return {
    admit(sessionKey: string): boolean {
      const at = Date.now();
      const previous = failures.get(sessionKey);
      if (previous && at < previous.nextAt) {
        return false;
      }
      const count = (previous?.count ?? 0) + 1;
      failures.set(sessionKey, { count, nextAt: at + reconcileRetryDelay(count, 30_000, 300_000) });
      return true;
    },
    succeeded: (sessionKey: string) => failures.delete(sessionKey),
    reset: () => failures.clear(),
  };
}

export type ProjectionMaintenanceLane = "channel" | "detached" | "direct";

function nextMaintenanceLane(lane: ProjectionMaintenanceLane): ProjectionMaintenanceLane {
  return lane === "channel" ? "detached" : lane === "detached" ? "direct" : "channel";
}

/** One reconciler pass: a woken session in its own lane, or the rotation's lane. */
export type ReconcilePass = {
  lane: ProjectionMaintenanceLane;
  sessionKey?: string;
  attempts: number;
};

/**
 * The reconciler's timing. Maintenance lanes rotate on their own schedule;
 * woken sessions (live activity) are served one per pass ahead of it without
 * moving the rotation or its schedule, so frequent activity cannot starve a
 * lane.
 */
export function createReconcileSchedule() {
  const woken = new Map<string, { lane: ProjectionMaintenanceLane; attempts: number }>();
  let lane: ProjectionMaintenanceLane = "channel";
  let rotationDueAt = 0;
  return {
    reset(firstDelayMs: number) {
      woken.clear();
      lane = "channel";
      rotationDueAt = Date.now() + firstDelayMs;
    },
    wake(sessionKey: string, wokenLane: ProjectionMaintenanceLane) {
      woken.set(sessionKey, { lane: wokenLane, attempts: 0 });
    },
    take(): ReconcilePass {
      const next = woken.entries().next();
      if (next.done) {
        return { lane, attempts: 0 };
      }
      const [sessionKey, entry] = next.value;
      woken.delete(sessionKey);
      return { sessionKey, ...entry };
    },
    /**
     * A woken pass that failed before serving its session gets up to three
     * tries, so an inventory outage does not lose live activity. A newer wake
     * for the same session supersedes it.
     */
    requeue(pass: ReconcilePass) {
      if (pass.sessionKey && pass.attempts < 3 && !woken.has(pass.sessionKey)) {
        woken.set(pass.sessionKey, { lane: pass.lane, attempts: pass.attempts + 1 });
      }
    },
    /** Records a finished pass and returns the delay before the next one. */
    finish(pass: ReconcilePass, backlog: boolean): number {
      const now = Date.now();
      const rotationDelay = backlog ? RECONCILE_BACKLOG_DELAY_MS : RECONCILE_IDLE_DELAY_MS;
      if (pass.sessionKey) {
        // A woken pass only pulls the rotation forward when it uncovered a backlog.
        rotationDueAt = Math.min(rotationDueAt, now + rotationDelay);
      } else {
        lane = nextMaintenanceLane(lane);
        rotationDueAt = now + rotationDelay;
      }
      return woken.size ? RECONCILE_BACKLOG_DELAY_MS : Math.max(0, rotationDueAt - now);
    },
  };
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
