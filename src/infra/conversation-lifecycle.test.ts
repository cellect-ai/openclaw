import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
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
  awaitAgentRunAdmission,
  getAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
  sweepStaleRunContexts,
} from "./agent-run-registry.js";
import type { ConversationProjectionBinding } from "./conversation-lifecycle.js";
import { registerConversationLifecycleTransport } from "./conversation-lifecycle.js";
import * as custody from "./delivery-queue-sqlite.js";
import * as worker from "./delivery-queue-worker-store.js";

describe("trusted durable conversation lifecycle", () => {
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
    for (const close of stop) await close();
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
  it("reconciles commit followed by a lost ordinary worker reply without duplicate terminal", async () => {
    const transport = install();
    await transport.ready;
    owner("lost-reply");
    await awaitAgentRunAdmission("lost-reply", getAgentRunContext("lost-reply"));
    await transport.flush();
    const execute = worker.executeDeliveryQueueOperation;
    let lost = false;
    vi.spyOn(worker, "executeDeliveryQueueOperation").mockImplementation(async (...args) => {
      const result = await execute(...args);
      if (!lost && args[2].type === "deliveryQueue.lifecycleRecord") {
        lost = true;
        throw new Error("committed response was lost");
      }
      return result;
    });
    emit("lost-reply", "end");
    await awaitAgentRunAdmission("lost-reply", getAgentRunContext("lost-reply"));
    await transport.flush();
    expect(lost).toBe(true);
    expect(publications.map((event) => [event.state, event.revision])).toEqual([
      ["queued", 1],
      ["completed", 2],
    ]);
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
  it("publishes a newly committed room while a different room is on the wire", async () => {
    const other = {
      ...binding,
      roomId: "!other:test",
      bindingId: "other",
      sessionKey: "agent:example:other",
    };
    const firstOnWire = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    const otherOnWire = createDeferred<void>();
    const order: string[] = [];
    const transport = registerConversationLifecycleTransport({
      transportId: "test-matrix",
      stateDir,
      resolveBindings: ({ sessionKey }) => [sessionKey === other.sessionKey ? other : binding],
      publish: async (_, event) => {
        if (event.state !== "queued") {
          return;
        }
        order.push(event.runId);
        if (event.runId === "first") {
          firstOnWire.resolve();
          await releaseFirst.promise;
        } else if (event.runId === "other-room") {
          otherOnWire.resolve();
        }
      },
      onError: (error) => {
        throw error;
      },
    });
    stop.push(() => releaseFirst.resolve(), transport.stop);
    owner("first");
    await firstOnWire.promise;
    owner("same-room");
    await awaitAgentRunAdmission("same-room", getAgentRunContext("same-room"));
    owner("other-room", other);
    await otherOnWire.promise;
    expect(order).toEqual(["first", "other-room"]);
    releaseFirst.resolve();
    await transport.flush();
    expect(order).toEqual(["first", "other-room", "same-room"]);
  });

  it("acknowledges a sent status while an unrelated lifecycle write is waiting", async () => {
    const firstOnWire = createDeferred<string>();
    const releaseFirst = createDeferred<void>();
    const pendingWrite = createDeferred<void>();
    const releaseWriter = createDeferred<void>();
    const acknowledged = createDeferred<void>();
    const execute = worker.executeDeliveryQueueOperation;
    vi.spyOn(worker, "executeDeliveryQueueOperation").mockImplementation(async (...args) => {
      const command = args[2];
      if (
        command.type === "deliveryQueue.lifecycleRecord" &&
        command.input.event.runId === "pending"
      ) {
        pendingWrite.resolve();
        await releaseWriter.promise;
      }
      const result = await execute(...args);
      if (command.type === "deliveryQueue.lifecycleAck" && command.input.id === sentId) {
        acknowledged.resolve();
      }
      return result;
    });
    const other = {
      ...binding,
      roomId: "!other:test",
      bindingId: "other",
      sessionKey: "agent:example:other",
    };
    const transport = registerConversationLifecycleTransport({
      transportId: "test-matrix",
      stateDir,
      resolveBindings: ({ sessionKey }) => [sessionKey === other.sessionKey ? other : binding],
      publish: async (_, event, transactionId) => {
        if (event.runId === "first") {
          firstOnWire.resolve(transactionId.slice(0, transactionId.lastIndexOf(":")));
          await releaseFirst.promise;
        }
      },
      onError: (error) => {
        throw error;
      },
    });
    stop.push(() => {
      releaseFirst.resolve();
      releaseWriter.resolve();
    }, transport.stop);
    owner("first");
    const sentId = await firstOnWire.promise;
    owner("pending", other);
    await pendingWrite.promise;
    releaseFirst.resolve();
    await acknowledged.promise;
    releaseWriter.resolve();
    await transport.flush();
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
  function owner(runId: string, target = binding) {
    registerAgentRunContext(runId, {
      sessionKey: target.sessionKey,
      sessionId: "session",
      agentId: target.agentId,
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
  it("recovers prior-generation terminal producers even after every status was acknowledged", async () => {
    const retired = vi.fn(async (_source, assertRetired: () => void) => {
      assertRetired();
    });
    const original = install({ retired });
    owner("final-open-at-crash");
    emit("final-open-at-crash", "end");
    await original.flush();
    expect(retired).not.toHaveBeenCalled();
    expect(
      custody.loadDeliveryQueueEntries("conversation-lifecycle-v2", stateDir)[0],
    ).toMatchObject({ state: "completed", pending: [] });
    await original.stop();
    rotateAgentEventLifecycleGeneration();
    const recovered = install({ retired });
    await recovered.flush();
    await recovered.flush();
    expect(retired).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "final-open-at-crash", sessionId: "session", binding }),
      expect.any(Function),
    );
    const retainedAssertion = retired.mock.calls.at(-1)![1];
    rotateAgentEventLifecycleGeneration();
    expect(retainedAssertion).toThrow("lost its native owner");
  });
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
    await first.stop();
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
    await first.stop();
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
  it("does not advertise start or terminal when durable custody fails", async () => {
    const transport = install();
    await transport.ready;
    owner("run");
    await awaitAgentRunAdmission("run", getAgentRunContext("run"));
    await transport.flush();
    const observe = vi.fn();
    stop.push(onAgentEvent(observe));
    vi.spyOn(worker, "executeDeliveryQueueOperation").mockRejectedValue(new Error("disk full"));
    emit("run", "start");
    emit("run", "end");
    await expect(transport.flush()).rejects.toThrow("disk full");
    expect(observe).not.toHaveBeenCalled();
    stop.splice(stop.indexOf(transport.stop), 1);
    await expect(transport.stop()).rejects.toThrow("disk full");
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
    await first.stop();
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

  it("keeps the state of an unbound run that is swept and returns", async () => {
    let current: ConversationProjectionBinding[] = [];
    const transport = install({ resolve: () => current });
    owner("unbound");
    emit("unbound", "start");
    const clock = vi.spyOn(Date, "now");
    const swept = Date.now() + 31 * 60_000;
    clock.mockReturnValue(swept);
    expect(sweepStaleRunContexts()).toBe(1);
    await transport.flush();
    owner("unbound");
    current = [binding];
    clock.mockReturnValue(swept + 60_000);
    await transport.flush();
    expect(publications.map((event) => event.state)).toEqual(["running"]);
  });
  it("does not set aside the oldest row when an outage ends before the next row is tried", async () => {
    let failing = Infinity;
    const transport = install({ fail: () => failing-- > 0 });
    const clock = vi.spyOn(Date, "now");
    const start = 1_800_000_000_000;
    clock.mockReturnValue(start);
    owner("old");
    emit("old", "start");
    clock.mockReturnValue(start + 1_000);
    owner("new");
    for (let pass = 1; pass <= 5; pass += 1) {
      // The server returns right after the oldest row's fifth failed send.
      if (pass === 5) failing = 1;
      clock.mockReturnValue(start + pass * 600_000);
      await transport.flush();
    }
    expect(errors.map((error) => error.reason)).not.toContain("row_stuck");
    expect(publications.slice(5).map((event) => [event.runId, event.state])).toEqual([
      ["new", "queued"],
      ["old", "queued"],
      ["old", "running"],
    ]);
    emit("old", "end");
    clock.mockReturnValue(start + 5 * 600_000 + 10_000);
    await transport.flush();
    expect(publications.at(-1)).toMatchObject({ runId: "old", state: "completed" });
  });
  it("reports a set-aside row that keeps failing and gives it up after a month", async () => {
    const transport = install({ fail: (_, __, runId) => runId === "poison" });
    const clock = vi.spyOn(Date, "now");
    const start = 1_800_000_000_000;
    clock.mockReturnValue(start);
    owner("poison");
    emit("poison", "end");
    clock.mockReturnValue(start + 1_000);
    owner("fine");
    for (let pass = 1; pass <= 5; pass += 1) {
      clock.mockReturnValue(start + pass * 600_000);
      await transport.flush();
    }
    for (let hour = 2; hour <= 4; hour += 1) {
      clock.mockReturnValue(start + hour * 3_700_000);
      await transport.flush();
    }
    expect(errors.slice(3).map((error) => [error.reason, error.failures])).toEqual([
      ["row_stuck", 5],
      ["row_stuck", 1],
      ["row_stuck", 2],
    ]);
    const sends = publications.length;
    clock.mockReturnValue(start + 31 * 24 * 60 * 60_000);
    await transport.flush();
    await transport.flush();
    expect(publications).toHaveLength(sends);
    expect(errors.at(-1)?.reason).toBe("status_abandoned");
    const rows = custody.loadDeliveryQueueEntries(
      "conversation-lifecycle-v2",
      stateDir,
    ) as unknown as Array<{ runId: string; pending: unknown[]; stuckAt?: number }>;
    expect(rows.find((row) => row.runId === "poison")).toMatchObject({ pending: [] });
    expect(rows.find((row) => row.runId === "poison")?.stuckAt).toBeUndefined();
    expect(errors.filter((error) => error.reason === "status_abandoned")).toHaveLength(1);
  });
  it("holds a run again that returned while its room stayed parked", async () => {
    let refusing = true;
    const transport = install({ fail: () => refusing, refused: "M_FORBIDDEN" });
    const clock = vi.spyOn(Date, "now");
    const start = 1_800_000_000_000;
    const minute = 60_000;
    clock.mockReturnValue(start);
    owner("parked-twice");
    await transport.flush();
    clock.mockReturnValue(start + 29 * minute);
    emit("parked-twice", "start");
    emitAgentEvent({
      runId: "parked-twice",
      stream: "approval",
      data: { phase: "requested", status: "pending", approvalId: "open" },
    });
    clock.mockReturnValue(start + 61 * minute);
    expect(sweepStaleRunContexts()).toBe(1);
    await transport.flush();
    // The run returns without a transition while the room is still parked.
    owner("parked-twice");
    await transport.flush();
    clock.mockReturnValue(start + 92 * minute);
    expect(sweepStaleRunContexts()).toBe(1);
    refusing = false;
    clock.mockReturnValue(start + 122 * minute);
    await transport.flush();
    expect(publications.map((event) => event.state)).not.toContain("interrupted");
    expect(publications.at(-1)?.state).toBe("waiting");
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
  it("fails admission before returning acceptance when the initial obligation cannot be persisted", async () => {
    const transport = install();
    await transport.ready;
    await transport.flush();
    vi.spyOn(worker, "executeDeliveryQueueOperation").mockRejectedValue(new Error("disk full"));
    owner("unaccepted");
    await expect(
      awaitAgentRunAdmission("unaccepted", getAgentRunContext("unaccepted")),
    ).rejects.toThrow("disk full");
    expect(publications).toEqual([]);
    stop.splice(stop.indexOf(transport.stop), 1);
    await expect(transport.stop()).rejects.toThrow("disk full");
  });
  it("does not project hidden maintenance or heartbeat executions", async () => {
    const transport = install();
    for (const [runId, flags] of [
      ["maintenance", { projectSessionLifecycle: false }],
      ["heartbeat", { projectSessionActive: false, projectSessionLifecycle: false }],
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
      if (order === "before-terminal") await transport.noteResult(result);
      emit("final", "end");
      await transport.flush();
      if (order === "after-terminal") {
        expect(publications.at(-1)).not.toHaveProperty("resultEventId");
        await transport.noteResult(result);
        await transport.flush();
      }
      expect(publications.at(-1)).toMatchObject({
        state: "completed",
        resultEventId: "$accepted-final",
      });
      const count = publications.length;
      await transport.noteResult(result);
      await transport.flush();
      expect(publications).toHaveLength(count);
      expect(custody.loadDeliveryQueueEntries("conversation-lifecycle-v2", stateDir)).toHaveLength(
        0,
      );
    },
  );
});
