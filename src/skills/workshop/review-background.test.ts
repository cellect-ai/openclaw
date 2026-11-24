import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  active: 0,
  own: false,
  listener: () => {},
  stop: vi.fn(),
  drain: new AbortController(),
}));
vi.mock("../../infra/gateway-work-metrics-events.js", () => ({
  onGatewayWorkMetricsChanged: (listener: () => void) => {
    state.listener = listener;
    return state.stop;
  },
}));
vi.mock("../../process/gateway-work-admission.js", () => ({
  getGatewayRestartDrainSignal: () => state.drain.signal,
}));
vi.mock("../../sessions/session-controller.queries.js", () => ({
  getActiveSessionRunCount: () => state.active,
  isSessionRunActive: () => state.own,
}));
import { captureSkillReviewBackground } from "./review-background.js";
afterEach(() => {
  state.active = 0;
  state.own = false;
  state.drain = new AbortController();
  vi.clearAllMocks();
});
it("ignores its own cron run and yields as soon as foreground work appears", () => {
  state.active = 1;
  state.own = true;
  {
    using review = captureSkillReviewBackground("own");
    review.assertCurrent();
    state.active = 2;
    state.listener();
    expect(() => review.assertCurrent()).toThrow("foreground");
  }
  expect(state.stop).toHaveBeenCalledOnce();
});
it.each(["drain", "cron-cancel"] as const)("retains %s cancellation", (kind) => {
  const cron = new AbortController();
  using review = captureSkillReviewBackground("own", cron.signal);
  (kind === "drain" ? state.drain : cron).abort(new Error(kind));
  expect(() => review.assertCurrent()).toThrow(kind);
});
