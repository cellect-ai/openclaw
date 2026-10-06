import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  captureChannelReadAuthority,
  withChannelReadAuthority,
} from "../shared/channel-read-authority.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  emitAgentEvent,
  onAgentEvent,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "./agent-events.js";
import {
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
  sweepStaleRunContexts,
} from "./agent-run-registry.js";
import {
  registerConversationLifecycleTransport,
  type ConversationProjectionBinding,
} from "./conversation-lifecycle.js";
import * as custody from "./delivery-queue-sqlite.js";

describe("trusted durable conversation lifecycle", () => {
  let stateDir: string;
  let stop: (() => void)[];
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
  const failed = { roomId: binding.roomId, reason: "delivery_failed", failures: 1 };
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-custody-"));
    resetAgentEventsForTest();
    rotateAgentEventLifecycleGeneration();
    publications.length = 0;
    errors.length = 0;
    stop = [];
  });
  afterEach(async () => {
    for (const close of stop) close();
    resetAgentEventsForTest();
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  it("delivers and acknowledges retained terminal transitions without host data SQL", async () => {
    const transport = install();
    owner("worker-flush");
    emit("worker-flush", "start");
    emit("worker-flush", "end");
    const sql = observeHostDataSql();
    try {
      await transport.flush();
      expect(sql.calls.map((call) => call.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
      expect(publications.map((event) => event.state)).toEqual(["queued", "running", "completed"]);
    } finally {
      sql.restore();
    }
  });
  it("preserves a terminal appended while its predecessor is on the wire", async () => {
    const transport = registerConversationLifecycleTransport({
      transportId: "test-matrix",
      stateDir,
      resolveBindings: () => [binding],
      publish: async (_, event, transactionId) => {
        publications.push({ ...event, transactionId });
        if (event.state === "queued") emit("overlap", "end");
      },
      onError: () => {},
    });
    stop.push(transport.stop);
    owner("overlap");
    emit("overlap", "start");
    await transport.flush();
    expect(publications.map((event) => event.state)).toEqual(["queued", "running", "completed"]);
    const retained = custody.loadDeliveryQueueEntries("conversation-lifecycle-v2", stateDir)[0];
    expect(retained).toMatchObject({ state: "completed", pending: [] });
  });
  it("publishes retained status in transport custody after the producer read scope closes", async () => {
    let failFirstSend = true;
    const transport = registerConversationLifecycleTransport({
      transportId: "test-matrix",
      stateDir,
      resolveBindings: () => [binding],
      publish: async (_, event, transactionId) => {
        // Real Matrix bootstrap asserts any captured channel read authority.
        captureChannelReadAuthority()?.();
        expect(captureChannelReadAuthority()).toBeUndefined();
        publications.push({ ...event, transactionId });
        if (failFirstSend) {
          failFirstSend = false;
          throw new Error("temporary wire failure");
        }
      },
      onError: (_, detail) => {
        errors.push({ ...detail });
      },
    });
    stop.push(transport.stop);
    let producerAuthority: (() => void) | undefined;
    await withChannelReadAuthority(
      () => {},
      async () => {
        producerAuthority = captureChannelReadAuthority();
        owner("closed-producer");
        emit("closed-producer", "end");
        await transport.flush();
      },
    );
    expect(errors).toEqual([failed]);
    expect(() => producerAuthority?.()).toThrow("no longer active");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    await transport.flush();
    expect(publications.map((event) => event.state)).toEqual(["queued", "queued", "completed"]);
    expect(publications[1]?.transactionId).toBe(publications[0]?.transactionId);
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
    } = {},
  ) {
    const transport = registerConversationLifecycleTransport({
      transportId: "test-matrix",
      stateDir,
      resolveBindings: options.resolve ?? (() => [binding]),
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
  it("persists owning nonenumerable generation before observers, ignores silent time and preliminary answers", async () => {
    const transport = install();
    owner("run");
    const seen: number[] = [];
    stop.push(
      onAgentEvent((event) => {
        expect(Object.keys(event)).not.toContain("lifecycleGeneration");
        seen.push(custody.loadDeliveryQueueEntries("conversation-lifecycle-v2", stateDir).length);
      }),
    );
    emit("run", "start");
    await transport.flush();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000);
    emitAgentEvent({ runId: "run", stream: "assistant", data: { text: "preliminary" } });
    await transport.flush();
    expect(seen).toEqual([1, 1]);
    expect(publications.map((event) => event.state)).toEqual(["queued", "running"]);
    expect(publications[0]?.generation).toBe(getAgentRunLifecycleGeneration());
    expect(custody.loadDeliveryQueueEntries("conversation-lifecycle-v2", stateDir)).toHaveLength(1);
  });
  it("keeps two simultaneous runs independent and freezes the admitted room", async () => {
    let current = binding;
    const transport = install({ resolve: () => [current] });
    owner("first");
    owner("second");
    current = { ...binding, roomId: "!switched:test" };
    emit("first", "start");
    emit("second", "start");
    current = { ...binding, roomId: "!switched:test" };
    emit("first", "end");
    await transport.flush();
    expect(
      publications.filter((event) => event.runId === "first").map((event) => event.state),
    ).toEqual(["queued", "running", "completed"]);
    expect(
      publications.filter((event) => event.runId === "second").map((event) => event.state),
    ).toEqual(["queued", "running"]);
    expect(publications.every((event) => event.roomId === binding.roomId)).toBe(true);
  });
  it("replays persisted terminal after crash with the same transaction identity and never runs work", async () => {
    const first = install({ fail: true });
    owner("run");
    emit("run", "start");
    emit("run", "end");
    await first.flush();
    expect(errors).toEqual([failed]);
    const failedTransaction = publications[0]?.transactionId;
    first.stop();
    rotateAgentEventLifecycleGeneration();
    const next = install();
    await next.flush();
    expect(publications.slice(1).map((event) => event.state)).toEqual([
      "queued",
      "running",
      "completed",
    ]);
    expect(publications[1]?.transactionId).toBe(failedTransaction);
    // Terminal delivery is retained until a proved final visible result arrives.
    expect(custody.loadDeliveryQueueEntries("conversation-lifecycle-v2", stateDir)).toHaveLength(1);
  });
  it("marks a vanished process run interrupted only after replaying its retained start", async () => {
    const first = install({ fail: true });
    owner("lost");
    emit("lost", "start");
    await first.flush();
    expect(errors).toEqual([failed]);
    const oldGeneration = getAgentRunLifecycleGeneration();
    first.stop();
    rotateAgentEventLifecycleGeneration();
    const next = install();
    await next.flush();
    expect(publications.slice(1).map((event) => event.state)).toEqual([
      "queued",
      "running",
      "interrupted",
    ]);
    expect(publications.slice(1).every((event) => event.generation === oldGeneration)).toBe(true);
  });
  it("rejects forged ownership and an old-generation terminal event", async () => {
    const transport = install();
    emit("forged", "start");
    owner("current");
    emitAgentEvent({
      runId: "current",
      sessionId: "other",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1 },
    });
    emitAgentEvent({
      runId: "current",
      lifecycleGeneration: "retired",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await transport.flush();
    expect(publications.map((event) => [event.runId, event.state])).toEqual([
      ["current", "queued"],
    ]);
  });
  it("does not advertise start or terminal when durable custody fails", () => {
    install();
    owner("run");
    const observe = vi.fn();
    stop.push(onAgentEvent(observe));
    vi.spyOn(custody, "upsertDeliveryQueueEntry").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => emit("run", "start")).toThrow("disk full");
    expect(() => emit("run", "end")).toThrow("disk full");
    expect(observe).not.toHaveBeenCalled();
  });
  it("projects real approval transitions and canonical cancellation, not fallback errors", async () => {
    const transport = install();
    owner("run");
    emit("run", "start");
    emitAgentEvent({
      runId: "run",
      stream: "approval",
      data: { phase: "requested", status: "pending", approvalId: "first" },
    });
    emitAgentEvent({
      runId: "run",
      stream: "approval",
      data: { phase: "requested", status: "pending", approvalId: "second" },
    });
    emitAgentEvent({
      runId: "run",
      stream: "approval",
      data: { phase: "resolved", status: "approved", approvalId: "first" },
    });
    await transport.flush();
    expect(publications.at(-1)?.state).toBe("waiting");
    emitAgentEvent({
      runId: "run",
      stream: "approval",
      data: { phase: "resolved", status: "approved", approvalId: "second" },
    });
    emit("run", "error", { error: "fallback attempt" });
    emit("run", "end", { aborted: true });
    await transport.flush();
    expect(publications.map((event) => event.state)).toEqual([
      "queued",
      "running",
      "waiting",
      "running",
      "cancelled",
    ]);
  });
  it("recovers a crash before start as queued then interrupted, without admitting another execution", async () => {
    const first = install({ fail: true });
    owner("queued-crash");
    await first.flush();
    expect(errors).toEqual([failed]);
    first.stop();
    rotateAgentEventLifecycleGeneration();
    const next = install();
    await next.flush();
    expect(publications.slice(1).map((event) => event.state)).toEqual(["queued", "interrupted"]);
  });
  it("keeps a run alive across compaction onto a successor session", async () => {
    const transport = install();
    owner("compact");
    emit("compact", "start");
    await transport.flush();
    registerAgentRunContext("compact", { sessionId: "successor" });
    await transport.flush();
    emit("compact", "end");
    await transport.flush();
    expect(publications.map((event) => event.state)).toEqual(["queued", "running", "completed"]);
  });
  it("reports an idle swept run as interrupted and counts a real outcome that arrives too late", async () => {
    const transport = install();
    owner("silent");
    emit("silent", "start");
    await transport.flush();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60_000);
    expect(sweepStaleRunContexts()).toBe(1);
    await transport.flush();
    expect(publications.map((event) => event.state)).toEqual(["queued", "running", "interrupted"]);
    owner("silent");
    emit("silent", "end");
    emit("silent", "end");
    await transport.flush();
    expect(publications).toHaveLength(3);
    expect(errors).toEqual([
      { roomId: binding.roomId, reason: "terminal_after_interrupted", failures: 0 },
    ]);
  });
  it("replaces an unsent interrupted with the real outcome of a falsely swept run", async () => {
    let reachable = false;
    const transport = install({ fail: () => !reachable });
    owner("revived");
    emit("revived", "start");
    await transport.flush();
    const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60_000);
    expect(sweepStaleRunContexts()).toBe(1);
    await transport.flush();
    expect(
      custody.loadDeliveryQueueEntries("conversation-lifecycle-v2", stateDir)[0],
    ).toMatchObject({ state: "interrupted" });
    owner("revived");
    emit("revived", "end");
    reachable = true;
    later.mockReturnValue(Date.now() + 60 * 60_000);
    await transport.flush();
    expect(publications.map((event) => event.state)).toEqual([
      "queued",
      "queued",
      "queued",
      "running",
      "completed",
    ]);
    expect(errors.map((error) => error.reason)).toEqual(["delivery_failed", "delivery_failed"]);
  });
  it("holds a swept run that had an open approval until it returns or stays gone", async () => {
    const transport = install();
    for (const runId of ["returns", "gone"]) {
      owner(runId);
      emit(runId, "start");
      emitAgentEvent({
        runId,
        stream: "approval",
        data: { phase: "requested", status: "pending", approvalId: "open" },
      });
    }
    await transport.flush();
    const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60_000);
    expect(sweepStaleRunContexts()).toBe(2);
    await transport.flush();
    expect(publications.map((event) => event.state)).not.toContain("interrupted");
    owner("returns");
    emitAgentEvent({
      runId: "returns",
      stream: "approval",
      data: { phase: "resolved", status: "approved", approvalId: "open" },
    });
    emit("returns", "end");
    later.mockReturnValue(Date.now() + 31 * 60_000);
    await transport.flush();
    const states = (runId: string) =>
      publications.filter((event) => event.runId === runId).map((event) => event.state);
    expect(states("returns")).toEqual(["queued", "running", "waiting", "running", "completed"]);
    expect(states("gone")).toEqual(["queued", "running", "waiting", "interrupted"]);
  });
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
    transport.noteResult({
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
    first.stop();
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
    first.stop();
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
    first.stop();
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
      transport.stop();
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
    expect(states("poison")).toEqual(Array(5).fill("queued"));
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
    expect(states("poison")).toHaveLength(5);
    healed = true;
    clock.mockReturnValue(start + 13 * 600_000);
    await transport.flush();
    // Only the run's newest state follows; its superseded ones are never sent late.
    expect(states("poison").slice(5)).toEqual(["completed"]);
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
    const first = install({
      fail: () => {
        first.stop();
        return true;
      },
    });
    const clock = vi.spyOn(Date, "now");
    const start = 1_800_000_000_000;
    clock.mockReturnValue(start);
    owner("crashed");
    await first.flush();
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
  it("reports a timed-out run as interrupted", async () => {
    const transport = install();
    owner("slow");
    emit("slow", "start");
    emit("slow", "end", { status: "timeout" });
    await transport.flush();
    expect(publications.map((event) => event.state)).toEqual(["queued", "running", "interrupted"]);
  });
  it("retries an unreachable room on its own schedule without holding back another room", async () => {
    const dead = { ...binding, roomId: "!dead:test", bindingId: "binding-dead" };
    let reachable = false;
    const transport = install({
      resolve: () => [dead, binding],
      fail: (roomId) => roomId === dead.roomId && !reachable,
    });
    const states = (roomId: string) =>
      publications.filter((event) => event.roomId === roomId).map((event) => event.state);
    owner("run");
    emit("run", "start");
    emit("run", "end");
    await transport.flush();
    expect(states(binding.roomId)).toEqual(["queued", "running", "completed"]);
    expect(states(dead.roomId)).toEqual(["queued"]);
    expect(errors).toEqual([{ roomId: dead.roomId, reason: "delivery_failed", failures: 1 }]);
    reachable = true;
    await transport.flush();
    expect(states(dead.roomId)).toEqual(["queued"]);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    await transport.flush();
    expect(states(dead.roomId)).toEqual(["queued", "queued", "running", "completed"]);
    expect(states(binding.roomId)).toHaveLength(3);
  });
  it("sheds superseded states of an unreachable room and never its terminal", async () => {
    let reachable = false;
    const transport = install({ fail: () => !reachable });
    const rows = () =>
      custody.loadDeliveryQueueEntries("conversation-lifecycle-v2", stateDir) as unknown as Array<{
        runId: string;
        pending: Array<{ state: string }>;
      }>;
    for (let run = 0; run < 8; run += 1) {
      owner(`busy-${run}`);
      emit(`busy-${run}`, "start");
      for (let approval = 0; approval < 16; approval += 1) {
        for (const [phase, status] of [
          ["requested", "pending"],
          ["resolved", "approved"],
        ]) {
          emitAgentEvent({
            runId: `busy-${run}`,
            stream: "approval",
            data: { phase, status, approvalId: `approval-${approval}` },
          });
        }
      }
      emit(`busy-${run}`, "end");
    }
    // Each run held 35 transitions; the per-run cap keeps the newest 32.
    expect(rows().map((row) => row.pending.length)).toEqual(Array(8).fill(32));
    expect(rows().every((row) => row.pending.at(-1)?.state === "completed")).toBe(true);
    await transport.flush();
    expect(errors.map((error) => error.reason)).toEqual(["backlog_capped", "delivery_failed"]);
    // The room is now over its cap: a further run keeps only its newest state.
    owner("late");
    emit("late", "start");
    emit("late", "end");
    expect(rows().find((row) => row.runId === "late")?.pending).toMatchObject([
      { state: "completed" },
    ]);
    reachable = true;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    await transport.flush();
    expect(publications.filter((event) => event.runId === "late").at(-1)?.state).toBe("completed");
    expect(publications.filter((event) => event.state === "completed")).toHaveLength(9);
  });
  it("publishes the current state once a binding appears after the run started", async () => {
    let current: ConversationProjectionBinding[] = [];
    const transport = install({ resolve: () => current });
    owner("late");
    emit("late", "start");
    emitAgentEvent({
      runId: "late",
      stream: "approval",
      data: { phase: "requested", status: "pending", approvalId: "open" },
    });
    await transport.flush();
    current = [binding];
    await transport.flush();
    expect(publications).toEqual([]);
    expect(transport.resolveRun("late", binding.sessionKey)).toBeUndefined();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5_000);
    await transport.flush();
    expect(publications.map((event) => event.state)).toEqual(["waiting"]);
    expect(publications[0]).toMatchObject({ roomId: binding.roomId, revision: 1 });
    expect(transport.resolveRun("late", binding.sessionKey)?.bindings).toEqual([binding]);
    emitAgentEvent({
      runId: "late",
      stream: "approval",
      data: { phase: "resolved", status: "approved", approvalId: "open" },
    });
    emit("late", "end");
    await transport.flush();
    expect(publications.map((event) => event.state)).toEqual(["waiting", "running", "completed"]);
  });
  it("adopts a late binding on the run's next transition without waiting for the retry", async () => {
    let current: ConversationProjectionBinding[] = [];
    const transport = install({ resolve: () => current });
    owner("next");
    current = [binding];
    emit("next", "start");
    await transport.flush();
    expect(publications.map((event) => event.state)).toEqual(["running"]);
  });
  it("never adopts another session's or agent's binding, or a run that ended unbound", async () => {
    let current: ConversationProjectionBinding[] = [
      { ...binding, sessionKey: "agent:example:other" },
      { ...binding, bindingId: "binding-2", agentId: "other" },
    ];
    const transport = install({ resolve: () => current });
    owner("foreign");
    emit("foreign", "start");
    owner("ended");
    emit("ended", "start");
    emit("ended", "end");
    const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5_000);
    await transport.flush();
    expect(publications).toEqual([]);
    current = [{ ...binding, roomId: "!other:test" }];
    later.mockReturnValue(Date.now() + 5_000);
    await transport.flush();
    expect(publications.map((event) => [event.runId, event.state, event.roomId])).toEqual([
      ["foreign", "running", "!other:test"],
    ]);
  });
  it("fails admission before returning acceptance when the initial obligation cannot be persisted", () => {
    install();
    vi.spyOn(custody, "upsertDeliveryQueueEntry").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => owner("unaccepted")).toThrow("disk full");
    expect(publications).toEqual([]);
  });
  it("does not project hidden maintenance or heartbeat executions", async () => {
    const transport = install();
    for (const [runId, flags] of [
      ["maintenance", { projectSessionLifecycle: false }],
      ["heartbeat", { isHeartbeat: true }],
    ] as const) {
      registerAgentRunContext(runId, {
        sessionKey: binding.sessionKey,
        sessionId: "session",
        agentId: binding.agentId,
        ...flags,
      });
      emit(runId, "start");
      emit(runId, "end");
    }
    await transport.flush();
    expect(publications).toEqual([]);
  });
  it.each(["before-terminal", "after-terminal"] as const)(
    "rendezvous final acceptance %s without making preliminary text terminal",
    async (order) => {
      const transport = install();
      owner("final");
      emit("final", "start");
      emitAgentEvent({ runId: "final", stream: "assistant", data: { text: "preliminary" } });
      const result = {
        runId: "final",
        generation: getAgentRunLifecycleGeneration(),
        bindingId: binding.bindingId,
        resultEventId: "$accepted-final",
      };
      if (order === "before-terminal") transport.noteResult(result);
      emit("final", "end");
      await transport.flush();
      if (order === "after-terminal") {
        expect(publications.at(-1)).not.toHaveProperty("resultEventId");
        transport.noteResult(result);
        await transport.flush();
      }
      expect(publications.at(-1)).toMatchObject({
        state: "completed",
        resultEventId: "$accepted-final",
      });
      const count = publications.length;
      transport.noteResult(result);
      await transport.flush();
      expect(publications).toHaveLength(count);
      expect(custody.loadDeliveryQueueEntries("conversation-lifecycle-v2", stateDir)).toHaveLength(
        0,
      );
    },
  );
});
