import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { persistDispatchTerminal } from "./chat-send-dispatch-terminal.js";

it.each([true, false])(
  "scheduler close joins the accepted native attempt (commit: %s)",
  async (commit) => {
    const time = createGatewaySchedulerClock(1000);
    const scheduler = createTestGatewayScheduler(time.clock);
    const pending = createDeferred<boolean>();
    const publish = vi.fn(() => pending.promise);
    const receipt = persistDispatchTerminal({
      id: "owned-terminal",
      scheduler,
      publish,
      onFailure: vi.fn(),
    });
    let settled = false;
    void receipt.then(() => {
      settled = true;
    });
    scheduler.beginClose();
    await Promise.resolve();
    expect(settled).toBe(false);
    if (commit) pending.resolve(true);
    else pending.reject(new Error("native failed"));
    await expect(receipt).resolves.toBe(commit ? "accepted" : "closed");
    await scheduler.stop();
    expect(publish).toHaveBeenCalledOnce();
  },
);

it("keeps one native scheduler job through repeated failed attempts", async () => {
  const time = createGatewaySchedulerClock(1000);
  const scheduler = createTestGatewayScheduler(time.clock);
  const publish = vi
    .fn()
    .mockRejectedValueOnce(new Error("first"))
    .mockRejectedValueOnce(new Error("second"))
    .mockResolvedValue(true);
  const onFailure = vi.fn();
  const receipt = persistDispatchTerminal({ id: "same-occurrence", scheduler, publish, onFailure });
  await vi.waitFor(() => expect(scheduler.nextWakeAtMs).toBe(6000));
  await time.advanceTo(6000);
  await vi.waitFor(() => expect(scheduler.nextWakeAtMs).toBe(16000));
  await time.advanceTo(16000);
  await expect(receipt).resolves.toBe("accepted");
  expect(onFailure.mock.calls).toEqual([[1], [2]]);
  expect(scheduler.nextWakeAtMs).toBeNull();
  await scheduler.stop();
});
