import type { MonitorSlackOpts } from "./types.js";

/** The monitor's existing status callback observes activity without admitting work. */
export function createSlackStatusEventTracker(setStatus: MonitorSlackOpts["setStatus"]) {
  return setStatus
    ? () => setStatus({ lastEventAt: Date.now(), lastInboundAt: Date.now() })
    : undefined;
}
