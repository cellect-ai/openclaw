import { describe, expect, it, vi } from "vitest";
import {
  RECONCILE_BATCH_SIZE,
  RECONCILE_HISTORY_BATCH_SIZE,
  reconcileRetryDelay,
  createLiveChannelRetryGate,
  takePendingOrRotatingBatch,
  takeSweepBatch,
} from "./reconciliation-batch.js";

describe("projection reconciliation batching", () => {
  it("backs off repeated live hook failures per thread and resets only on successful delivery", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const gate = createLiveChannelRetryGate();
      expect(gate.admit("failed-thread")).toBe(true);
      expect(gate.admit("other-thread")).toBe(true);
      for (let event = 0; event < 29; event++) {
        vi.advanceTimersByTime(1000);
        expect(gate.admit("failed-thread")).toBe(false);
      }
      vi.advanceTimersByTime(1000);
      expect(gate.admit("failed-thread")).toBe(true);
      vi.advanceTimersByTime(30_000);
      expect(gate.admit("failed-thread")).toBe(false);
      vi.advanceTimersByTime(30_000);
      expect(gate.admit("failed-thread")).toBe(true);
      for (const delay of [120_000, 240_000, 300_000, 300_000]) {
        vi.advanceTimersByTime(delay - 1);
        expect(gate.admit("failed-thread")).toBe(false);
        vi.advanceTimersByTime(1);
        expect(gate.admit("failed-thread")).toBe(true);
      }
      gate.succeeded("failed-thread");
      expect(gate.admit("failed-thread")).toBe(true);
      expect(gate.admit("failed-thread")).toBe(false);
      gate.reset();
      expect(gate.admit("failed-thread")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it("finishes a sweep without repeating work before rotating", () => {
    const seen = new Set<string>();
    const keys = Array.from({ length: 12 }, (_, index) => `key-${String(index).padStart(2, "0")}`);
    expect([...takeSweepBatch(keys, seen, 8)]).toEqual(keys.slice(0, 8));
    expect([...takeSweepBatch(keys, seen, 8)]).toEqual(keys.slice(8));
    expect([...takeSweepBatch(keys, seen, 8)]).toEqual(keys.slice(0, 8));
  });

  it("drops retired keys and handles an empty inventory", () => {
    const seen = new Set(["retired"]);
    expect([...takeSweepBatch(["current"], seen, 8)]).toEqual(["current"]);
    expect(seen).toEqual(new Set(["current"]));
    expect([...takeSweepBatch([], seen, 8)]).toEqual([]);
    expect(takePendingOrRotatingBatch([], new Set(), "cursor", 8)).toEqual({
      batch: new Set(),
      cursor: "cursor",
    });
  });

  it("prioritizes never-repaired items before rotating completed items", () => {
    const keys = ["a", "b", "c", "d"];
    const first = takePendingOrRotatingBatch(keys, new Set(["a", "b"]), "", 3);
    expect([...first.batch]).toEqual(["c", "d"]);
    const next = takePendingOrRotatingBatch(keys, new Set(keys), first.cursor, 3);
    expect([...next.batch]).toEqual(["a", "b", "c"]);
  });

  it("uses a one-at-a-time budget for historical snapshots", () => {
    expect(RECONCILE_BATCH_SIZE).toBe(1);
    expect(RECONCILE_HISTORY_BATCH_SIZE).toBe(1);
  });
  it("backs failed sources off exponentially from five minutes to an hour", () => {
    expect([1, 2, 3, 4, 5, 12].map((failures) => reconcileRetryDelay(failures) / 60_000)).toEqual([
      5, 10, 20, 40, 60, 60,
    ]);
  });
});
