import { createReplyTimingTracker, type ReplyTimingLogParams } from "./reply-timing-tracker.js";

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

export function logReplyResolverTiming(
  tracker: ReturnType<typeof createReplyTimingTracker<ReplyTimingLogParams>>,
  details: { surface: string; messageId?: string; sessionKey?: string; agentId: string },
  outcome: string,
  reason?: string,
  error?: string,
): void {
  tracker.logIfSlow({
    message: `reply resolver timings surface=${details.surface} messageId=${details.messageId ?? "unknown"} sessionKey=${details.sessionKey ?? "unknown"} agentId=${details.agentId}`,
    outcome,
    reason,
    error,
    details,
  });
}
