import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  emitAgentEvent,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "./agent-events.js";
import {
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
  sweepStaleRunContexts,
} from "./agent-run-registry.js";
import type { ConversationProjectionBinding } from "./conversation-lifecycle.js";
import { registerConversationLifecycleTransport } from "./conversation-lifecycle.js";
import * as custody from "./delivery-queue-sqlite.js";

describe("trusted durable lifecycle delivery recovery", () => {
  let stateDir: string;

  let stop: (() => void | Promise<void>)[];

  const binding: ConversationProjectionBinding = {
    environment: "test",
    conversationId: "conversation-1",
    roomId: "!room:test",
    bindingId: "binding-1",
    accountId: "bot",
    threadRootEventId: "$root",
    sessionKey: "agent:example:main",
    agentId: "example",
  };

  const publications: Array<{
    state: string;
    runId: string;
    generation: string;
    revision: number;
    roomId: string;
    transactionId: string;
  }> = [];

  const errors: Array<{ roomId?: string; reason?: string; failures?: number }> = [];

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-custody-"));
    resetAgentEventsForTest();
    rotateAgentEventLifecycleGeneration();
    publications.length = 0;
    errors.length = 0;
    stop = [];
  });

  afterEach(async () => {
    for (const close of stop) await close();
    resetAgentEventsForTest();
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function owner(runId: string) {
    registerAgentRunContext(runId, {
      sessionKey: binding.sessionKey,
      sessionId: "session",
      agentId: binding.agentId,
    });
  }

  function emit(runId: string, phase: string, data: Record<string, unknown> = {}) {
    emitAgentEvent({ runId, stream: "lifecycle", data: { phase, startedAt: 1, ...data } });
  }

  function install(
    options: {
      fail?: boolean | ((roomId: string, state: string, runId: string) => boolean | "refused");
      refused?: "M_FORBIDDEN" | "M_NOT_FOUND";
      resolve?: () => readonly ConversationProjectionBinding[];
      retired?: Parameters<typeof registerConversationLifecycleTransport>[0]["onRetiredProducer"];
    } = {},
  ) {
    const transport = registerConversationLifecycleTransport({
      transportId: "test-matrix",
      stateDir,
      resolveBindings: options.resolve ?? (() => [binding]),
      onRetiredProducer: options.retired,
      publish: async (_, event, transactionId) => {
        publications.push({ ...event, transactionId });
        const failure =
          typeof options.fail === "function"
            ? options.fail(event.roomId, event.state, event.runId)
            : options.fail;
        if (failure)
          throw Object.assign(new Error("network unavailable"), {
            errcode: failure === "refused" ? "M_FORBIDDEN" : options.refused,
          });
      },
      isDestinationGone: (error) => (error as { errcode?: string }).errcode !== undefined,
      onError: (_, detail) => {
        errors.push({ ...detail });
      },
    });
    stop.push(transport.stop);
    return transport;
  }

  it("reports a room that stays down at doubling failure counts only", async () => {
    const transport = install({ fail: true });
    owner("down");
    const clock = vi.spyOn(Date, "now");
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      clock.mockReturnValue(1_800_000_000_000 + attempt * 3_600_000);
      await transport.flush();
    }
    expect(publications).toHaveLength(5);
    expect(errors.map((error) => error.failures)).toEqual([1, 2, 4]);
  });

  it("parks a room the homeserver refuses, expires its old status and resumes on a new binding", async () => {
    let current = binding;
    let reachable = false;
    const transport = install({
      resolve: () => [current],
      fail: () => !reachable,
      refused: "M_FORBIDDEN",
    });
    const clock = vi.spyOn(Date, "now");
    const start = 1_800_000_000_000;
    clock.mockReturnValue(start);
    owner("orphan");
    emit("orphan", "end");
    await transport.flush();
    expect(errors).toEqual([{ roomId: binding.roomId, reason: "room_parked", failures: 1 }]);
    clock.mockReturnValue(start + 30 * 60_000);
    await transport.flush();
    expect(publications).toHaveLength(1);
    clock.mockReturnValue(start + 25 * 60 * 60_000);
    await transport.flush();
    expect(
      custody.loadDeliveryQueueEntries("conversation-lifecycle-v2", stateDir)[0],
    ).toMatchObject({ state: "completed", pending: [] });
    current = { ...binding, bindingId: "binding-rejoined" };
    reachable = true;
    owner("fresh");
    await transport.flush();
    expect(publications.slice(1).map((event) => [event.runId, event.state])).toEqual([
      ["fresh", "queued"],
    ]);
    expect(errors).toHaveLength(1);
  });

  it("recovers a transiently refused room at the next probe", async () => {
    let reachable = false;
    const transport = install({ fail: () => !reachable, refused: "M_FORBIDDEN" });
    const clock = vi.spyOn(Date, "now");
    const start = 1_800_000_000_000;
    clock.mockReturnValue(start);
    owner("blip");
    emit("blip", "start");
    emit("blip", "end");
    await transport.flush();
    reachable = true;
    clock.mockReturnValue(start + 30 * 60_000);
    await transport.flush();
    expect(publications).toHaveLength(1);
    clock.mockReturnValue(start + 61 * 60_000);
    await transport.flush();
    expect(publications.slice(1).map((event) => event.state)).toEqual([
      "queued",
      "running",
      "completed",
    ]);
    expect(errors).toEqual([{ roomId: binding.roomId, reason: "room_parked", failures: 1 }]);
  });

  it("tries a room that is gone once per probe interval", async () => {
    const transport = install({ fail: true, refused: "M_NOT_FOUND" });
    const clock = vi.spyOn(Date, "now");
    const start = 1_800_000_000_000;
    clock.mockReturnValue(start);
    owner("gone");
    emit("gone", "end");
    for (const minutes of [0, 30, 61, 90, 122, 150]) {
      clock.mockReturnValue(start + minutes * 60_000);
      await transport.flush();
    }
    expect(publications).toHaveLength(3);
    expect(errors.map((error) => error.reason)).toEqual(Array(3).fill("room_parked"));
  });

  it("reopens a parked room when a final result is accepted there", async () => {
    let reachable = false;
    const transport = install({ fail: () => !reachable, refused: "M_FORBIDDEN" });
    owner("final");
    emit("final", "end");
    await transport.flush();
    expect(errors.map((error) => error.reason)).toEqual(["room_parked"]);
    reachable = true;
    await transport.flush();
    expect(publications).toHaveLength(1);
    await transport.noteResult({
      runId: "final",
      generation: getAgentRunLifecycleGeneration(),
      bindingId: binding.bindingId,
      resultEventId: "$accepted-final",
    });
    await transport.flush();
    expect(publications.at(-1)).toMatchObject({
      state: "completed",
      resultEventId: "$accepted-final",
    });
  });

  it("closes a parked run that never ended once its status expires", async () => {
    const transport = install({ fail: true, refused: "M_FORBIDDEN" });
    const clock = vi.spyOn(Date, "now");
    const start = 1_800_000_000_000;
    clock.mockReturnValue(start);
    owner("stale");
    emit("stale", "start");
    await transport.flush();
    clock.mockReturnValue(start + 25 * 60 * 60_000);
    expect(sweepStaleRunContexts()).toBe(1);
    await transport.flush();
    expect(publications).toHaveLength(1);
    expect(
      custody.loadDeliveryQueueEntries("conversation-lifecycle-v2", stateDir)[0],
    ).toMatchObject({ state: "interrupted", pending: [] });
  });

  it("never replaces an interrupted whose response was lost before a reload", async () => {
    // The send reaches the room but its response is lost, so it stays queued.
    const first = install({ fail: (_, state) => state === "interrupted" });
    owner("lost-ack");
    emit("lost-ack", "start");
    await first.flush();
    const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60_000);
    expect(sweepStaleRunContexts()).toBe(1);
    await first.flush();
    expect(publications.at(-1)?.state).toBe("interrupted");
    await first.stop();
    const next = install();
    owner("lost-ack");
    emit("lost-ack", "end");
    later.mockReturnValue(Date.now() + 60 * 60_000);
    await next.flush();
    expect(publications.map((event) => event.state)).toEqual([
      "queued",
      "running",
      "interrupted",
      "interrupted",
    ]);
    expect(errors.map((error) => error.reason)).toEqual([
      "delivery_failed",
      "terminal_after_interrupted",
    ]);
    // The retry is the same Matrix transaction, so the homeserver deduplicates it.
    expect(publications[3]?.transactionId).toBe(publications[2]?.transactionId);
    expect(publications[3]).toMatchObject({ revision: 3 });
    expect(publications[3]?.transactionId.endsWith(":3")).toBe(true);
  });

  it("goes on looking for the binding of a live run after a reload", async () => {
    let current: ConversationProjectionBinding[] = [];
    const first = install({ resolve: () => current });
    owner("reloaded");
    emit("reloaded", "start");
    await first.flush();
    await first.stop();
    const next = install({ resolve: () => current });
    current = [binding];
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5_000);
    await next.flush();
    expect(publications.map((event) => event.state)).toEqual(["running"]);
  });

  it("holds a swept run that held an open approval across a transport reload", async () => {
    const first = install();
    owner("claimed");
    emit("claimed", "start");
    emitAgentEvent({
      runId: "claimed",
      stream: "approval",
      data: { phase: "requested", status: "pending", approvalId: "open" },
    });
    await first.stop();
    const next = install();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60_000);
    expect(sweepStaleRunContexts()).toBe(1);
    await next.flush();
    expect(publications.map((event) => event.state)).toEqual(["queued", "running", "waiting"]);
  });

  it("holds a swept run whose approval opened while its room was parked", async () => {
    let reachable = false;
    const transport = install({ fail: () => !reachable, refused: "M_FORBIDDEN" });
    const clock = vi.spyOn(Date, "now");
    const start = 1_800_000_000_000;
    clock.mockReturnValue(start);
    owner("parked");
    await transport.flush();
    emit("parked", "start");
    emitAgentEvent({
      runId: "parked",
      stream: "approval",
      data: { phase: "requested", status: "pending", approvalId: "open" },
    });
    reachable = true;
    clock.mockReturnValue(start + 61 * 60_000);
    expect(sweepStaleRunContexts()).toBe(1);
    await transport.flush();
    expect(publications.slice(1).map((event) => event.state)).toEqual([
      "queued",
      "running",
      "waiting",
    ]);
  });

  it("keeps the outcome of a run a parked room already knows about past expiry", async () => {
    let refusing = false;
    const transport = install({ fail: () => refusing, refused: "M_FORBIDDEN" });
    const clock = vi.spyOn(Date, "now");
    const start = 1_800_000_000_000;
    const states = (runId: string) =>
      publications.filter((event) => event.runId === runId).map((event) => event.state);
    clock.mockReturnValue(start);
    owner("older");
    clock.mockReturnValue(start + 1_000);
    owner("ghost");
    await transport.flush();
    refusing = true;
    for (const runId of ["older", "ghost"]) {
      emit(runId, "start");
      emit(runId, "end");
    }
    await transport.flush();
    clock.mockReturnValue(start + 25 * 60 * 60_000);
    await transport.flush();
    const rows = custody.loadDeliveryQueueEntries(
      "conversation-lifecycle-v2",
      stateDir,
    ) as unknown as Array<{ runId: string; pending: unknown[] }>;
    expect(rows.find((row) => row.runId === "ghost")?.pending).toMatchObject([
      { state: "completed" },
    ]);
    refusing = false;
    clock.mockReturnValue(start + 27 * 60 * 60_000);
    await transport.flush();
    expect(states("ghost")).toEqual(["queued", "completed"]);
    expect(states("older").at(-1)).toBe("completed");
  });

  it("sends a room's runs in admission order after a failed attempt", async () => {
    let failing = 1;
    const transport = install({ fail: () => failing-- > 0 });
    const clock = vi.spyOn(Date, "now");
    const start = 1_800_000_000_000;
    clock.mockReturnValue(start);
    owner("old");
    clock.mockReturnValue(start + 1_000);
    owner("new");
    await transport.flush();
    clock.mockReturnValue(start + 7_000);
    await transport.flush();
    expect(publications.map((event) => event.runId)).toEqual(["old", "old", "new"]);
  });

  it("keeps the outcome of a run whose only send lost its response before the room parked", async () => {
    let mode: "lost" | "refused" | "open" = "lost";
    const transport = install({
      fail: () => (mode === "open" ? false : mode === "refused" ? "refused" : true),
    });
    const clock = vi.spyOn(Date, "now");
    const start = 1_800_000_000_000;
    clock.mockReturnValue(start);
    owner("unconfirmed");
    await transport.flush();
    mode = "refused";
    emit("unconfirmed", "end");
    clock.mockReturnValue(start + 60_000);
    await transport.flush();
    clock.mockReturnValue(start + 25 * 60 * 60_000);
    await transport.flush();
    mode = "open";
    clock.mockReturnValue(start + 27 * 60 * 60_000);
    await transport.flush();
    expect(publications.at(-1)).toMatchObject({ runId: "unconfirmed", state: "completed" });
  });

  it("bounds the ownerless hold across repeated reloads", async () => {
    const approval = { phase: "requested", status: "pending", approvalId: "open" };
    let transport = install();
    owner("reloading");
    emit("reloading", "start");
    emitAgentEvent({ runId: "reloading", stream: "approval", data: approval });
    await transport.flush();
    const clock = vi.spyOn(Date, "now");
    const missing = Date.now() + 31 * 60_000;
    clock.mockReturnValue(missing);
    expect(sweepStaleRunContexts()).toBe(1);
    await transport.flush();
    for (const minutes of [20, 31]) {
      await transport.stop();
      transport = install();
      clock.mockReturnValue(missing + minutes * 60_000);
      await transport.flush();
    }
    expect(publications.map((event) => event.state)).toEqual([
      "queued",
      "running",
      "waiting",
      "interrupted",
    ]);
  });

  it("gives up status owed to a room that has refused for a month", async () => {
    let refusing = false;
    const transport = install({ fail: () => refusing, refused: "M_FORBIDDEN" });
    const clock = vi.spyOn(Date, "now");
    const start = 1_800_000_000_000;
    clock.mockReturnValue(start);
    owner("month");
    await transport.flush();
    refusing = true;
    emit("month", "end");
    await transport.flush();
    clock.mockReturnValue(start + 31 * 24 * 60 * 60_000);
    await transport.flush();
    await transport.flush();
    expect(publications).toHaveLength(2);
    expect(
      custody.loadDeliveryQueueEntries("conversation-lifecycle-v2", stateDir)[0],
    ).toMatchObject({ state: "completed", pending: [] });
    expect(errors.map((error) => error.reason)).toEqual(["room_parked", "status_abandoned"]);
  });

  it("sets aside a row that alone keeps failing so later runs in its room proceed", async () => {
    let healed = false;
    const transport = install({ fail: (_, __, runId) => runId === "poison" && !healed });
    const clock = vi.spyOn(Date, "now");
    const start = 1_800_000_000_000;
    const states = (runId: string) =>
      publications.filter((event) => event.runId === runId).map((event) => event.state);
    clock.mockReturnValue(start);
    owner("poison");
    clock.mockReturnValue(start + 1_000);
    owner("fine");
    for (let pass = 1; pass <= 6; pass += 1) {
      clock.mockReturnValue(start + pass * 600_000);
      await transport.flush();
    }
    expect(states("poison")).toEqual(Array(6).fill("queued"));
    expect(states("fine")).toEqual(["queued"]);
    expect(errors.map((error) => [error.reason, error.failures])).toEqual([
      ["delivery_failed", 1],
      ["delivery_failed", 2],
      ["delivery_failed", 4],
      ["row_stuck", 5],
    ]);
    emit("poison", "start");
    emit("poison", "end");
    clock.mockReturnValue(start + 7 * 600_000);
    await transport.flush();
    expect(states("poison")).toHaveLength(6);
    healed = true;
    clock.mockReturnValue(start + 13 * 600_000);
    await transport.flush();
    // Only the run's newest state follows; its superseded ones are never sent late.
    expect(states("poison").slice(6)).toEqual(["completed"]);
    const rows = custody.loadDeliveryQueueEntries(
      "conversation-lifecycle-v2",
      stateDir,
    ) as unknown as Array<{ runId: string; stuckAt?: number }>;
    expect(rows.find((row) => row.runId === "poison")?.stuckAt).toBeUndefined();
  });

  it("keeps backing off the room when the row after a failing one fails too", async () => {
    const transport = install({ fail: true });
    const clock = vi.spyOn(Date, "now");
    const start = 1_800_000_000_000;
    clock.mockReturnValue(start);
    owner("first");
    clock.mockReturnValue(start + 1_000);
    owner("second");
    for (let pass = 1; pass <= 7; pass += 1) {
      clock.mockReturnValue(start + pass * 600_000);
      await transport.flush();
    }
    expect(publications.map((event) => event.runId)).toEqual([
      ...Array(5).fill("first"),
      "second",
      "first",
      "first",
    ]);
    expect(errors.map((error) => error.reason)).not.toContain("row_stuck");
  });

  it("holds a run a full period again after it returned between two sweeps", async () => {
    const transport = install();
    owner("twice");
    emit("twice", "start");
    emitAgentEvent({
      runId: "twice",
      stream: "approval",
      data: { phase: "requested", status: "pending", approvalId: "open" },
    });
    await transport.flush();
    const clock = vi.spyOn(Date, "now");
    const first = Date.now() + 31 * 60_000;
    clock.mockReturnValue(first);
    expect(sweepStaleRunContexts()).toBe(1);
    await transport.flush();
    // The run returns without any lifecycle transition.
    owner("twice");
    await transport.flush();
    clock.mockReturnValue(first + 31 * 60_000);
    expect(sweepStaleRunContexts()).toBe(1);
    await transport.flush();
    expect(publications.map((event) => event.state)).toEqual(["queued", "running", "waiting"]);
    clock.mockReturnValue(first + 62 * 60_000);
    await transport.flush();
    expect(publications.at(-1)?.state).toBe("interrupted");
  });

  it("keeps the outcome of a run whose first send landed just before a restart", async () => {
    // The send reaches the room and the process dies before its response.
    let stopped: Promise<void> | undefined;
    const first = install({
      fail: () => {
        stopped = first.stop();
        return true;
      },
    });
    const clock = vi.spyOn(Date, "now");
    const start = 1_800_000_000_000;
    clock.mockReturnValue(start);
    owner("crashed");
    await first.flush();
    await stopped;
    expect(publications).toHaveLength(1);
    rotateAgentEventLifecycleGeneration();
    let refusing = true;
    const next = install({ fail: () => refusing, refused: "M_FORBIDDEN" });
    await next.flush();
    clock.mockReturnValue(start + 25 * 60 * 60_000);
    await next.flush();
    refusing = false;
    clock.mockReturnValue(start + 27 * 60 * 60_000);
    await next.flush();
    expect(publications.at(-1)).toMatchObject({ runId: "crashed", state: "interrupted" });
    expect(errors.map((error) => error.reason)).toEqual(["room_parked", "room_parked"]);
  });

  it("returns a set-aside run to normal delivery once it publishes", async () => {
    let healed = false;
    const transport = install({ fail: (_, __, runId) => runId === "poison" && !healed });
    const clock = vi.spyOn(Date, "now");
    const start = 1_800_000_000_000;
    clock.mockReturnValue(start);
    owner("poison");
    emit("poison", "start");
    clock.mockReturnValue(start + 1_000);
    owner("fine");
    for (let pass = 1; pass <= 6; pass += 1) {
      clock.mockReturnValue(start + pass * 600_000);
      await transport.flush();
    }
    expect(errors.at(-1)?.reason).toBe("row_stuck");
    healed = true;
    clock.mockReturnValue(start + 13 * 600_000);
    await transport.flush();
    emit("poison", "end");
    clock.mockReturnValue(start + 13 * 600_000 + 10_000);
    await transport.flush();
    expect(
      publications.filter((event) => event.runId === "poison").map((event) => event.state),
    ).toEqual([...Array(6).fill("queued"), "running", "completed"]);
  });
});
