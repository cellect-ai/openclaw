import { type OpenClawConfig } from "../../config/config.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { createReplyTimingTracker, type ReplyTimingLogParams } from "./reply-timing-tracker.js";

export function createReplyPhaseTracer(
  resolverTiming: ReturnType<typeof createReplyTimingTracker<ReplyTimingLogParams>>,
  cfg: OpenClawConfig,
  traceAttributes: NonNullable<Parameters<typeof measureDiagnosticsTimelineSpan>[2]>["attributes"],
) {
  return <T>(name: string, run: () => Promise<T> | T): Promise<T> =>
    resolverTiming.measure(name, () =>
      measureDiagnosticsTimelineSpan(name, run, {
        phase: "agent-turn",
        config: cfg,
        attributes: traceAttributes,
      }),
    );
}
