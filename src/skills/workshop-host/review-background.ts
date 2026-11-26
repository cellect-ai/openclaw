import { onGatewayWorkMetricsChanged } from "../../infra/gateway-work-metrics-events.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import {
  getActiveSessionRunCount,
  isSessionRunActive,
} from "../../sessions/session-controller.queries.js";

/** Shared cancellation policy; each caller keeps ownership of its run registration/admission. */
export function captureSkillReviewBackground(sessionId: string, upstream?: AbortSignal) {
  const foreground = new AbortController();
  const yieldToForeground = () => {
    const ownRun = isSessionRunActive(sessionId) ? 1 : 0;
    if (getActiveSessionRunCount() > ownRun)
      foreground.abort(new DOMException("Skill review yielded to foreground work", "AbortError"));
  };
  const unsubscribe = onGatewayWorkMetricsChanged(yieldToForeground);
  const signal = AbortSignal.any([
    getGatewayRestartDrainSignal(),
    foreground.signal,
    ...(upstream ? [upstream] : []),
  ]);
  return {
    signal,
    assertCurrent() {
      yieldToForeground();
      signal.throwIfAborted();
    },
    [Symbol.dispose]() {
      unsubscribe();
    },
  };
}
