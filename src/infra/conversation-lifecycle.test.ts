import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitAgentEvent,
  onAgentEvent,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "./agent-events.js";
import { getAgentRunLifecycleGeneration, registerAgentRunContext } from "./agent-run-registry.js";
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
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-custody-"));
    resetAgentEventsForTest();
    rotateAgentEventLifecycleGeneration();
    publications.length = 0;
    stop = [];
  });
  afterEach(() => {
    for (const close of stop) close();
    resetAgentEventsForTest();
    vi.restoreAllMocks();
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
    options: { fail?: boolean; resolve?: () => readonly ConversationProjectionBinding[] } = {},
  ) {
    const transport = registerConversationLifecycleTransport({
      transportId: "test-matrix",
      stateDir,
      resolveBindings: options.resolve ?? (() => [binding]),
      publish: async (_, event, transactionId) => {
        publications.push({ ...event, transactionId });
        if (options.fail) throw new Error("network unavailable");
      },
      onError: () => {},
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
    await expect(first.flush()).rejects.toThrow("network unavailable");
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
  it("marks a vanished process run unknown only after replaying its retained start", async () => {
    const first = install({ fail: true });
    owner("lost");
    emit("lost", "start");
    await expect(first.flush()).rejects.toThrow();
    const oldGeneration = getAgentRunLifecycleGeneration();
    first.stop();
    rotateAgentEventLifecycleGeneration();
    const next = install();
    await next.flush();
    expect(publications.slice(1).map((event) => event.state)).toEqual([
      "queued",
      "running",
      "unknown",
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
  it("recovers a crash before start as queued then unknown, without admitting another execution", async () => {
    const first = install({ fail: true });
    owner("queued-crash");
    await expect(first.flush()).rejects.toThrow();
    first.stop();
    rotateAgentEventLifecycleGeneration();
    const next = install();
    await next.flush();
    expect(publications.slice(1).map((event) => event.state)).toEqual(["queued", "unknown"]);
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
