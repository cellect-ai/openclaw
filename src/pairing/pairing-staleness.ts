// Periodic escalation for DM access requests nobody has answered.
//
// Notifying on arrival is not enough on its own: the failure this exists for
// was a request that sat unanswered for over a month, and one missed line at
// the start is indistinguishable from silence. A pending request therefore
// gets louder on a schedule instead of only once.
import { listPairingChannels } from "../channels/plugins/pairing.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { formatPairingListHint } from "./pairing-request-notice.js";
import { resolvePairingRequestAccountId } from "./pairing-store-sqlite.js";
import {
  CHANNEL_PAIRING_STALE_AFTER_MS,
  isPairingRequestStale,
  listChannelPairingRequests,
  resolvePairingRequestAgeMs,
} from "./pairing-store.js";
import type { PairingChannel } from "./pairing-store.types.js";

/** How often the sweep looks. One escalation per request per interval. */
export const PAIRING_STALENESS_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
/**
 * Delay before the first pass. Channel plugins register during startup and
 * `listPairingChannels()` is empty until they do, so an immediate sweep would
 * report nothing on exactly the restart that should re-announce an old request.
 */
export const PAIRING_STALENESS_SWEEP_START_DELAY_MS = 60 * 1000;

export type PairingStalenessLogger = { warn: (message: string) => void };

function formatAgeHours(ageMs: number): string {
  return `${Math.floor(ageMs / (60 * 60 * 1000))}h`;
}

/**
 * Logs one warning per stale pending request. Deliberately re-logs every sweep:
 * the point is that an unanswered request keeps costing attention, and an
 * operator's log alerting sees a recurring warning instead of one lost line.
 * Returns the number of stale requests found, for tests and callers.
 */
export async function sweepStalePairingRequests(params: {
  channels?: PairingChannel[];
  env?: NodeJS.ProcessEnv;
  log: PairingStalenessLogger;
  nowMs?: number;
}): Promise<number> {
  const env = params.env ?? process.env;
  const nowMs = params.nowMs ?? Date.now();
  const channels = params.channels ?? listPairingChannels();
  let stale = 0;
  for (const channel of channels) {
    // Per-channel failures must not hide the remaining channels' requests.
    let requests: Awaited<ReturnType<typeof listChannelPairingRequests>>;
    try {
      requests = await listChannelPairingRequests(channel, env);
    } catch (err) {
      params.log.warn(`pairing staleness sweep failed for ${channel}: ${String(err)}`);
      continue;
    }
    for (const request of requests) {
      if (!isPairingRequestStale(request, nowMs)) {
        continue;
      }
      stale += 1;
      const accountId = resolvePairingRequestAccountId(request);
      const senderId = request.meta?.senderId ?? request.id;
      params.log.warn(
        `DM access request unanswered for ${formatAgeHours(resolvePairingRequestAgeMs(request, nowMs))} ` +
          `on ${channel}:${accountId} from ${senderId}. ` +
          `Approve or dismiss it: ${formatPairingListHint({ channel, accountId, senderId })}`,
      );
    }
  }
  return stale;
}

/**
 * Starts the sweep on the gateway's lifecycle. The first pass runs immediately
 * so a gateway that restarts with an old pending request still says so.
 */
export function startPairingStalenessSweep(params?: {
  env?: NodeJS.ProcessEnv;
  intervalMs?: number;
  startDelayMs?: number;
  log?: PairingStalenessLogger;
}): () => void {
  const log = params?.log ?? createSubsystemLogger("pairing");
  const intervalMs = params?.intervalMs ?? PAIRING_STALENESS_SWEEP_INTERVAL_MS;
  const run = () => {
    void sweepStalePairingRequests({
      ...(params?.env ? { env: params.env } : {}),
      log,
    }).catch((err: unknown) => {
      log.warn(`pairing staleness sweep failed: ${String(err)}`);
    });
  };
  let interval: ReturnType<typeof setInterval> | undefined;
  const start = setTimeout(() => {
    run();
    interval = setInterval(run, intervalMs);
    interval.unref?.();
  }, params?.startDelayMs ?? PAIRING_STALENESS_SWEEP_START_DELAY_MS);
  start.unref?.();
  return () => {
    clearTimeout(start);
    if (interval) {
      clearInterval(interval);
    }
  };
}

/** Re-exported so callers describing the sweep do not reach into the store. */
export { CHANNEL_PAIRING_STALE_AFTER_MS };
