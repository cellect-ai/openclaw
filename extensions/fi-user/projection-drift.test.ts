import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import {
  DRIFT_ACTIVITY_SETTLE_MS,
  DRIFT_DECLINED_BACKOFF_MS,
  DRIFT_REFRESH_BACKOFF_MS,
  DRIFT_SUSPECT_REPLAN_MS,
  DRIFT_SOURCE_CHECK_MS,
  createProjectionDriftScheduler,
  runProjectionDriftPass,
} from "./projection-drift.js";

const TICK = 60_000;
const rooms = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    roomId: `!room${String(index).padStart(3, "0")}`,
    sessionKey: `agent:cellect-fi-admin:slack:channel:c123:thread:1700000000.${String(index).padStart(6, "0")}`,
  }));
const clean = { converged: true, invariantsOk: true };
const drifted = { converged: false, invariantsOk: false };

function clock() {
  let at = 1_000_000_000;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe("projection drift scheduler", () => {
  it("checks source history even when the partial Matrix mirror is structurally clean", async () => {
    const time = clock();
    const drift = createProjectionDriftScheduler(time.now);
    const bound = rooms(1);
    const api = { logger: { info: vi.fn(), warn: vi.fn() } } as unknown as OpenClawPluginApi;
    const publish = vi.fn(
      async (params: Parameters<Parameters<typeof runProjectionDriftPass>[0]["publish"]>[0]) => {
        params.onResult?.("existing");
        return true;
      },
    );
    const result = await runProjectionDriftPass({
      api,
      drift,
      inventory: { list: async () => bound, plan: async () => clean },
      bindings: bound,
      budget: 1,
      configured: [],
      active: () => true,
      channelAccount: () => "fi-admin",
      publish,
    });
    expect(result).toMatchObject({ refreshed: 1, refreshFailed: 0 });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: bound[0]!.sessionKey,
        projectionRoomId: bound[0]!.roomId,
        accountId: "fi-admin",
        reconcile: true,
        refresh: true,
      }),
    );
  });

  it.each(["false", "no-receipt"])(
    "does not claim a source refresh succeeded with %s",
    async (outcome) => {
      const time = clock();
      const drift = createProjectionDriftScheduler(time.now);
      const bound = rooms(1);
      const api = { logger: { info: vi.fn(), warn: vi.fn() } } as unknown as OpenClawPluginApi;
      const result = await runProjectionDriftPass({
        api,
        drift,
        inventory: { list: async () => bound, plan: async () => drifted },
        bindings: bound,
        budget: 1,
        configured: [],
        active: () => true,
        channelAccount: () => "fi-admin",
        publish: async () => outcome !== "false",
      });
      expect(result).toMatchObject({ refreshed: 0, refreshFailed: 1 });
    },
  );

  it("plans every one of 300 rooms within 30 ticks", () => {
    const time = clock();
    const drift = createProjectionDriftScheduler(time.now);
    const bound = rooms(300);
    const seen = new Set<string>();
    for (let tick = 0; tick < 30; tick++) {
      for (const roomId of drift.selectPlans(bound)) {
        seen.add(roomId);
        drift.recordPlan(roomId, clean);
      }
      time.advance(TICK);
    }
    expect(seen.size).toBe(300);
  });

  it("plans at least four rooms per tick for small inventories and caps priority work", () => {
    const time = clock();
    const drift = createProjectionDriftScheduler(time.now);
    const bound = rooms(20);
    expect(drift.selectPlans(bound)).toHaveLength(4);
    for (const room of bound) {
      drift.noteActivity(room.sessionKey);
    }
    time.advance(DRIFT_ACTIVITY_SETTLE_MS);
    // Four priority rooms, four rotation rooms: activity never starves the rotation.
    const planned = drift.selectPlans(bound);
    expect(planned).toHaveLength(8);
  });

  it("plans a room with settled Slack or Matrix activity ahead of the rotation", () => {
    const time = clock();
    const drift = createProjectionDriftScheduler(time.now);
    const bound = rooms(40);
    for (const roomId of drift.selectPlans(bound)) {
      drift.recordPlan(roomId, clean);
    }
    time.advance(TICK);
    drift.noteActivity(bound[30]?.sessionKey);
    drift.noteActivity(bound[35]?.roomId);
    // Live delivery is still settling: not yet prioritised.
    expect(drift.selectPlans(bound).slice(0, 2)).not.toContain(bound[35]?.roomId);
    time.advance(DRIFT_ACTIVITY_SETTLE_MS);
    const planned = drift.selectPlans(bound);
    expect(planned.slice(0, 2).toSorted()).toEqual([bound[30]?.roomId, bound[35]?.roomId]);
    for (const roomId of planned) {
      drift.recordPlan(roomId, clean);
    }
    time.advance(TICK);
    // Activity is consumed by the plan that followed it.
    expect(drift.selectPlans(bound).slice(0, 2)).not.toContain(bound[30]?.roomId);
  });

  it("re-plans a room whose invariants or plan failed ahead of the rotation", () => {
    const time = clock();
    const drift = createProjectionDriftScheduler(time.now);
    const bound = rooms(200);
    const first = drift.selectPlans(bound);
    drift.recordPlan(first[0] ?? "", { converged: true, invariantsOk: false });
    drift.recordPlan(first[1] ?? "", undefined);
    for (const roomId of first.slice(2)) {
      drift.recordPlan(roomId, clean);
    }
    time.advance(DRIFT_SUSPECT_REPLAN_MS - TICK);
    expect(drift.selectPlans(bound).slice(0, 2)).not.toContain(first[0]);
    time.advance(TICK);
    expect(drift.selectPlans(bound).slice(0, 2)).toEqual([first[0], first[1]]);
    expect(drift.summary()).toMatchObject({ invariant: 1, planFailed: 1, drifted: 0 });
  });

  it("checks clean and drifted rooms within the budget, oldest source attempts first", () => {
    const time = clock();
    const drift = createProjectionDriftScheduler(time.now);
    const bound = rooms(4);
    drift.noteActivity(bound[3]?.sessionKey);
    time.advance(DRIFT_ACTIVITY_SETTLE_MS);
    for (const roomId of drift.selectPlans(bound)) {
      drift.recordPlan(roomId, roomId === bound[0]?.roomId ? clean : drifted);
    }
    expect(drift.selectRefreshes(bound, 2)).toEqual([bound[3]?.roomId, bound[1]?.roomId]);
    expect(drift.selectRefreshes(bound, 0)).toEqual([]);
    // A room removed from the inventory loses its recovery state.
    time.advance(TICK);
    drift.selectPlans([]);
    expect(drift.selectRefreshes(bound, 3)).toEqual([]);
  });

  it("keeps source failure backoff across clean Matrix plans, resetting only after publication", () => {
    const time = clock();
    const drift = createProjectionDriftScheduler(time.now);
    const bound = rooms(1);
    const tick = (verdict: typeof clean) => {
      for (const planned of drift.selectPlans(bound)) {
        drift.recordPlan(planned, verdict);
      }
      const refreshes = drift.selectRefreshes(bound, 1);
      for (const refreshed of refreshes) {
        drift.recordRefresh(refreshed);
      }
      time.advance(TICK);
      return refreshes.length;
    };
    const refreshTimes: number[] = [];
    // One day of ticks while the room never converges (e.g. Fi refuses it).
    for (let minute = 0; minute < 24 * 60; minute++) {
      if (tick(drifted)) {
        refreshTimes.push(minute);
      }
    }
    // First refresh at once, then 1 h, 3 h, 9 h apart: never once per tick.
    expect(refreshTimes).toHaveLength(4);
    expect(refreshTimes[1]! - refreshTimes[0]!).toBeGreaterThanOrEqual(
      DRIFT_REFRESH_BACKOFF_MS[0] / TICK,
    );
    expect(refreshTimes[3]! - refreshTimes[2]!).toBeGreaterThanOrEqual(
      DRIFT_REFRESH_BACKOFF_MS[2] / TICK,
    );
    // A clean Matrix plan does not prove that Slack was read successfully.
    for (let minute = 0; minute < 40; minute++) {
      tick(clean);
    }
    expect(drift.summary().drifted).toBe(0);
    expect(tick(clean)).toBe(0);
    drift.recordPublished(bound[0]!.roomId);
    time.advance(DRIFT_SOURCE_CHECK_MS);
    expect(tick(clean)).toBe(1);
  });

  it("does not refresh a room Fi declined until it has new activity or a week passes", () => {
    const time = clock();
    const drift = createProjectionDriftScheduler(time.now);
    const bound = rooms(1);
    const room = bound[0]!;
    const tick = () => {
      for (const planned of drift.selectPlans(bound)) {
        drift.recordPlan(planned, clean);
      }
      const refreshes = drift.selectRefreshes(bound, 1);
      time.advance(TICK);
      return refreshes;
    };
    expect(tick()).toEqual([room.roomId]);
    drift.recordRefresh(room.roomId);
    drift.recordDeclined(room.roomId);
    let refreshes = 0;
    for (let minute = 0; minute < 2 * 24 * 60; minute++) {
      refreshes += tick().length;
    }
    expect(refreshes).toBe(0);
    expect(drift.summary()).toMatchObject({ drifted: 0, declined: 1 });
    // New activity in the room (e.g. someone used Claw in it again) re-admits it.
    drift.noteActivity(room.sessionKey);
    time.advance(DRIFT_ACTIVITY_SETTLE_MS);
    expect(tick()).toEqual([room.roomId]);
    // Without activity, the week-long backoff still expires.
    const quiet = createProjectionDriftScheduler(time.now);
    for (const planned of quiet.selectPlans(bound)) {
      quiet.recordPlan(planned, drifted);
    }
    quiet.recordRefresh(room.roomId);
    quiet.recordDeclined(room.roomId);
    time.advance(DRIFT_DECLINED_BACKOFF_MS);
    for (const planned of quiet.selectPlans(bound)) {
      quiet.recordPlan(planned, drifted);
    }
    expect(quiet.selectRefreshes(bound, 1)).toEqual([room.roomId]);
  });

  it("never refreshes or prioritises a drifted room with no human member, until one joins", () => {
    const time = clock();
    const drift = createProjectionDriftScheduler(time.now);
    const bound = rooms(40);
    const unread = { ...drifted, hasHumanMember: false };
    const target = bound[0]!.roomId;
    let refreshes = 0;
    let plans = 0;
    for (let minute = 0; minute < 60; minute++) {
      const planned = drift.selectPlans(bound);
      plans += planned.filter((roomId) => roomId === target).length;
      for (const roomId of planned) {
        drift.recordPlan(roomId, roomId === target ? unread : clean);
      }
      for (const roomId of drift.selectRefreshes(bound, 5)) {
        refreshes += Number(roomId === target);
        drift.recordRefresh(roomId);
        drift.recordPublished(roomId);
      }
      time.advance(TICK);
    }
    expect(refreshes).toBe(0);
    // Planned by the rotation only (40 rooms at 4 per tick: every 10 ticks).
    expect(plans).toBe(6);
    expect(drift.summary()).toMatchObject({ unread: 1, drifted: 0 });
    // A reader joins: the next plan that sees drift with a human refreshes it.
    let refreshed: string[] = [];
    for (let minute = 0; minute < 10 && !refreshed.length; minute++) {
      for (const roomId of drift.selectPlans(bound)) {
        drift.recordPlan(roomId, roomId === target ? { ...drifted, hasHumanMember: true } : clean);
      }
      refreshed = drift.selectRefreshes(bound, 5).filter((roomId) => roomId === target);
      time.advance(TICK);
    }
    expect(refreshed).toEqual([target]);
  });

  it("does not let new activity bypass a failed attempt after a previous decline", () => {
    const time = clock();
    const drift = createProjectionDriftScheduler(time.now);
    const bound = rooms(1);
    const room = bound[0]!;
    drift.selectPlans(bound);
    drift.recordPlan(room.roomId, drifted);
    drift.recordRefresh(room.roomId);
    drift.recordDeclined(room.roomId);
    time.advance(TICK);
    drift.noteActivity(room.sessionKey);
    time.advance(DRIFT_ACTIVITY_SETTLE_MS);
    expect(drift.selectRefreshes(bound, 1)).toEqual([room.roomId]);
    drift.recordRefresh(room.roomId); // source fails, no accepted publication
    time.advance(TICK);
    drift.noteActivity(room.sessionKey);
    time.advance(DRIFT_ACTIVITY_SETTLE_MS);
    drift.recordPlan(room.roomId, drifted);
    expect(drift.selectRefreshes(bound, 1)).toEqual([]);
  });

  it("forgets rooms that are no longer bound", () => {
    const time = clock();
    const drift = createProjectionDriftScheduler(time.now);
    const bound = rooms(3);
    for (const roomId of drift.selectPlans(bound)) {
      drift.recordPlan(roomId, drifted);
    }
    expect(drift.summary().tracked).toBe(3);
    drift.selectPlans(bound.slice(0, 1));
    expect(drift.summary()).toMatchObject({ tracked: 1, drifted: 1 });
  });

  it("does not starve quiet source checks when the same rooms stay active", () => {
    const time = clock();
    const drift = createProjectionDriftScheduler(time.now);
    const bound = rooms(20);
    const checked = new Set<string>();
    for (let minute = 0; minute < 20; minute++) {
      for (const room of bound.slice(0, 12)) {
        drift.noteActivity(room.sessionKey);
      }
      time.advance(DRIFT_ACTIVITY_SETTLE_MS);
      for (const roomId of drift.selectPlans(bound)) {
        drift.recordPlan(roomId, clean);
      }
      for (const roomId of drift.selectRefreshes(bound, 1)) {
        checked.add(roomId);
        drift.recordRefresh(roomId);
        drift.recordPublished(roomId);
      }
    }
    expect(checked.size).toBe(20);
  });
});
