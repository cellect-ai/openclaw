import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  drainRequiredAgentRunPersistence,
  emitAgentEventIfCurrent,
  onAgentEvent,
  prepareAgentEventForRunContext,
  registerAgentEventPersistenceHandler,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "./agent-events.js";
import {
  awaitAgentRunAdmission,
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunAdmissionHandler,
  registerAgentRunContext,
} from "./agent-run-registry.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("required event custody", () => {
  beforeEach(() => resetAgentEventsForTest());
  afterEach(() => resetAgentEventsForTest());
  const event = { runId: "required-custody", stream: "tool", data: { phase: "start" } };

  it("preserves synchronous native observer dispatch without required persistence", () => {
    const observe = vi.fn();
    onAgentEvent(observe);
    expect(emitAgentEventIfCurrent(event)).toBe(true);
    expect(observe).toHaveBeenCalledOnce();
  });

  it("retains the occurrence cohort and ordering until its writes commit", async () => {
    registerAgentRunContext(event.runId, { agentId: "test" });
    const first = deferred();
    let calls = 0;
    registerAgentEventPersistenceHandler(() => (++calls === 1 ? first.promise : Promise.resolve()));
    const seen: number[] = [];
    onAgentEvent((value) => seen.push(value.seq));
    expect(emitAgentEventIfCurrent(event)).toBe(true);
    const later = vi.fn();
    onAgentEvent(later);
    expect(emitAgentEventIfCurrent(event)).toBe(true);
    await Promise.resolve();
    expect(seen).toEqual([]);
    first.resolve();
    await drainRequiredAgentRunPersistence();
    expect(seen).toEqual([1, 2]);
    expect(later).toHaveBeenCalledOnce();
    expect(later.mock.calls[0][0].seq).toBe(2);
  });

  it("rejects admission and shutdown on a required commit failure without notifying observers", async () => {
    const write = deferred();
    registerAgentRunAdmissionHandler(() => write.promise);
    registerAgentRunContext(event.runId, { agentId: "test" });
    const admission = awaitAgentRunAdmission(event.runId, getAgentRunContext(event.runId));
    const rejection = expect(admission).rejects.toThrow("required commit failed");
    const observe = vi.fn();
    onAgentEvent(observe);
    expect(emitAgentEventIfCurrent(event)).toBe(true);
    write.reject(new Error("required commit failed"));
    await rejection;
    await expect(drainRequiredAgentRunPersistence()).rejects.toThrow("required commit failed");
    expect(observe).not.toHaveBeenCalled();
  });

  it("cannot publish a delayed occurrence into a successor lifecycle generation", async () => {
    registerAgentRunContext(event.runId, { agentId: "test" });
    const write = deferred();
    registerAgentEventPersistenceHandler(() => write.promise);
    const observe = vi.fn();
    onAgentEvent(observe);
    expect(emitAgentEventIfCurrent(event)).toBe(true);
    rotateAgentEventLifecycleGeneration();
    write.resolve();
    await expect(drainRequiredAgentRunPersistence()).rejects.toThrow("owner changed");
    expect(observe).not.toHaveBeenCalled();
  });

  it("cannot retarget a delayed occurrence to a replacement registration in the same generation", async () => {
    registerAgentRunContext(event.runId, { agentId: "test", sessionId: "original" });
    const write = deferred();
    registerAgentEventPersistenceHandler(() => write.promise);
    const observe = vi.fn();
    onAgentEvent(observe);
    emitAgentEventIfCurrent(event);
    clearAgentRunContext(event.runId);
    registerAgentRunContext(event.runId, { agentId: "test", sessionId: "successor" });
    write.resolve();
    await expect(drainRequiredAgentRunPersistence()).rejects.toThrow("owner changed");
    expect(observe).not.toHaveBeenCalled();
  });

  it("retries the same occurrence without another sequence or observer delivery", async () => {
    registerAgentRunContext(event.runId, { agentId: "test" });
    const original = getAgentRunContext(event.runId)!;
    const commit = vi
      .fn()
      .mockRejectedValueOnce(new Error("write refused"))
      .mockResolvedValue(undefined);
    registerAgentEventPersistenceHandler(() => ({ run: commit }));
    const observe = vi.fn();
    onAgentEvent(observe);
    const occurrence = prepareAgentEventForRunContext(event, original)!;
    await expect(occurrence.pending).rejects.toThrow("write refused");
    expect(observe).not.toHaveBeenCalled();
    await occurrence.retry();
    await occurrence.retry();
    await drainRequiredAgentRunPersistence();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledOnce();
    expect(observe.mock.calls[0][0].seq).toBe(1);
  });

  it("suppresses a captured subscriber that unsubscribes before commit", async () => {
    const write = deferred();
    registerAgentEventPersistenceHandler(() => write.promise);
    const observe = vi.fn();
    const off = onAgentEvent(observe);
    emitAgentEventIfCurrent(event);
    off();
    write.resolve();
    await drainRequiredAgentRunPersistence();
    expect(observe).not.toHaveBeenCalled();
  });

  it("settles only the retried owner's failure while another occurrence remains failed", async () => {
    const commits = new Map(
      ["first", "second"].map((runId) => [
        runId,
        vi
          .fn()
          .mockRejectedValueOnce(new Error(`${runId} failed`))
          .mockResolvedValue(undefined),
      ]),
    );
    registerAgentEventPersistenceHandler((occurrence) => ({ run: commits.get(occurrence.runId)! }));
    const observed: string[] = [];
    onAgentEvent((occurrence) => observed.push(`${occurrence.runId}:${occurrence.seq}`));
    const capture = (runId: string) => {
      registerAgentRunContext(runId, { agentId: "test" });
      return prepareAgentEventForRunContext({ ...event, runId }, getAgentRunContext(runId)!)!;
    };
    const first = capture("first");
    const second = capture("second");
    await Promise.allSettled([first.pending, second.pending]);
    await first.retry();
    await expect(drainRequiredAgentRunPersistence()).rejects.toThrow("second failed");
    expect(observed).toEqual(["first:1"]);
    await second.retry();
    await first.retry();
    await drainRequiredAgentRunPersistence();
    expect(observed).toEqual(["first:1", "second:1"]);
    for (const commit of commits.values()) expect(commit).toHaveBeenCalledTimes(2);
  });
});
