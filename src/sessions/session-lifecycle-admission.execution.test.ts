import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  beginSessionEffect,
  captureSessionWorkRunInterruptions,
  consumeSessionEffectHandoff,
  runSessionMutation,
} from "./session-controller.lifecycle.js";

function interruptExact(
  scope: string,
  identities: string[],
  runId: string,
  reason = new Error("Exact execution Stop"),
) {
  const owners = captureSessionWorkRunInterruptions({
    scope,
    identities,
    accept: (run) => run.runId === runId,
  });
  const interruptedRunIds = new Set<string>();
  for (const owner of owners) {
    if (owner.interrupt(reason)) interruptedRunIds.add(owner.run.runId);
  }
  return { interruptedRunIds, released: Promise.all(owners.map((owner) => owner.released)) };
}

it("interrupts only the exact host execution and leaves unknown and other input admissions usable", async () => {
  const scope = "execution-selection.sqlite";
  const identities = ["agent:main:execution", "execution-session"];
  const selectedInterrupted = vi.fn(() => {
    selected.release();
    return { runId: "selected" };
  });
  const selected = await beginSessionEffect({
    scope,
    identities,
    run: { runId: "selected" },
    assertAllowed: () => {},
    onInterrupt: selectedInterrupted,
  });
  const otherInterrupted = vi.fn();
  const other = await beginSessionEffect({
    scope,
    identities,
    run: { runId: "other" },
    assertAllowed: () => {},
    onInterrupt: otherInterrupted,
  });
  const unknownInterrupted = vi.fn();
  const unknown = await beginSessionEffect({
    scope,
    identities,
    assertAllowed: () => {},
    onInterrupt: unknownInterrupted,
  });
  try {
    const interruption = interruptExact(scope, identities, "selected");
    await interruption.released;
    expect([...interruption.interruptedRunIds]).toEqual(["selected"]);
    expect(selectedInterrupted).toHaveBeenCalledOnce();
    expect(otherInterrupted).not.toHaveBeenCalled();
    expect(unknownInterrupted).not.toHaveBeenCalled();
    expect(other.isActive()).toBe(true);
    expect(unknown.isActive()).toBe(true);
    expect(await other.run(async () => "other input executes")).toBe("other input executes");
    expect(await unknown.run(async () => "unknown input executes")).toBe("unknown input executes");
  } finally {
    selected.release();
    other.release();
    unknown.release();
  }
});

it("does not revoke an unbound pending admission while stopping an exact pending execution", async () => {
  const scope = "pending-execution-selection.sqlite";
  const identities = ["pending-session"];
  const entered = createDeferred();
  const release = createDeferred();
  const blocker = runSessionMutation({
    kind: "patch",
    policy: "wait",
    scope,
    identities,
    prepare: async () => {
      entered.resolve();
      await release.promise;
    },
    run: async () => {},
  });
  await entered.promise;
  const selectedInterrupted = vi.fn(() => ({ runId: "selected" }));
  const selected = beginSessionEffect({
    scope,
    identities,
    run: { runId: "selected" },
    assertAllowed: () => {},
    onInterrupt: selectedInterrupted,
  }).then(
    (lease) => {
      lease.release();
      return "incorrectly acquired";
    },
    (error: unknown) => error,
  );
  const unknownInterrupted = vi.fn();
  const unknown = beginSessionEffect({
    scope,
    identities,
    assertAllowed: () => {},
    onInterrupt: unknownInterrupted,
  });
  try {
    const reason = new Error("selected execution Stop");
    const interruption = interruptExact(scope, identities, "selected", reason);
    await interruption.released;
    expect(await selected).toBe(reason);
    expect(selectedInterrupted).toHaveBeenCalledOnce();
    expect(unknownInterrupted).not.toHaveBeenCalled();
    release.resolve();
    await blocker;
    const lease = await unknown;
    try {
      expect(await lease.run(async () => "pending input executes")).toBe("pending input executes");
    } finally {
      lease.release();
    }
  } finally {
    release.resolve();
    await blocker;
    await selected;
    (await unknown).release();
  }
});

it("hands off the captured execution once without moving its target or run identity", async () => {
  const scope = "execution-handoff.sqlite";
  const identities = ["agent:main:handoff-session"];
  const originalInterrupt = vi.fn();
  const admission = await beginSessionEffect({
    scope,
    identities,
    run: { runId: "selected" },
    onInterrupt: originalInterrupt,
  });
  const handoffId = admission.createHandoff();
  const adoptedInterrupt = vi.fn(() => {
    admission.release();
    return { runId: "selected" };
  });
  try {
    expect(
      consumeSessionEffectHandoff({
        handoffId,
        scope,
        identities: ["agent:main:other-session"],
        onInterrupt: adoptedInterrupt,
      }),
    ).toBeUndefined();
    expect(
      consumeSessionEffectHandoff({ handoffId, scope, identities, onInterrupt: adoptedInterrupt }),
    ).toBe(admission);
    expect(consumeSessionEffectHandoff({ handoffId, scope, identities })).toBeUndefined();
    expect(interruptExact(scope, identities, "other").interruptedRunIds.size).toBe(0);
    const interruption = interruptExact(scope, identities, "selected");
    await interruption.released;
    expect([...interruption.interruptedRunIds]).toEqual(["selected"]);
    expect(adoptedInterrupt).toHaveBeenCalledOnce();
    expect(originalInterrupt).not.toHaveBeenCalled();
  } finally {
    admission.release();
  }
});
