import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  beginSessionWorkAdmission,
  consumeSessionWorkAdmissionHandoff,
  runExclusiveSessionLifecycleMutation,
  startSessionWorkAdmissionInterruption,
} from "./session-lifecycle-admission.js";

it("interrupts only the exact host execution and leaves unknown and other input admissions usable", async () => {
  const scope = "execution-selection.sqlite";
  const identities = ["agent:main:execution", "execution-session"];
  const selectedInterrupted = vi.fn(() => {
    selected.release();
    return { runId: "selected" };
  });
  const selected = await beginSessionWorkAdmission({
    scope,
    identities,
    executionRunId: "selected",
    assertAllowed: () => {},
    onInterrupt: selectedInterrupted,
  });
  const otherInterrupted = vi.fn();
  const other = await beginSessionWorkAdmission({
    scope,
    identities,
    executionRunId: "other",
    assertAllowed: () => {},
    onInterrupt: otherInterrupted,
  });
  const unknownInterrupted = vi.fn();
  const unknown = await beginSessionWorkAdmission({
    scope,
    identities,
    assertAllowed: () => {},
    onInterrupt: unknownInterrupted,
  });
  try {
    const interruption = startSessionWorkAdmissionInterruption({
      scope,
      identities,
      executionRunId: "selected",
    });
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
  const blocker = runExclusiveSessionLifecycleMutation("patch", {
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
  const selected = beginSessionWorkAdmission({
    scope,
    identities,
    executionRunId: "selected",
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
  const unknown = beginSessionWorkAdmission({
    scope,
    identities,
    assertAllowed: () => {},
    onInterrupt: unknownInterrupted,
  });
  try {
    const reason = new Error("selected execution Stop");
    const interruption = startSessionWorkAdmissionInterruption({
      scope,
      identities,
      executionRunId: "selected",
      reason,
    });
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

it.each(["selected", undefined])(
  "hands off %s execution custody without accepting conflicting ownership",
  async (executionRunId) => {
    const scope = "execution-handoff.sqlite";
    const identities = ["handoff-session"];
    const originalInterrupt = vi.fn();
    const admission = await beginSessionWorkAdmission({
      scope,
      identities,
      executionRunId,
      assertAllowed: () => {},
      onInterrupt: originalInterrupt,
    });
    const handoffId = admission.createHandoff();
    const adoptedInterrupt = vi.fn(() => {
      admission.release();
      return { runId: "selected" };
    });
    try {
      if (executionRunId !== undefined) {
        expect(
          consumeSessionWorkAdmissionHandoff({
            handoffId,
            scope,
            identities,
            executionRunId: "other",
            onInterrupt: adoptedInterrupt,
          }),
        ).toBeUndefined();
      }
      const adopted = consumeSessionWorkAdmissionHandoff({
        handoffId,
        scope,
        identities,
        executionRunId: "selected",
        onInterrupt: adoptedInterrupt,
      });
      expect(adopted).toBe(admission);
      await startSessionWorkAdmissionInterruption({ scope, identities, executionRunId: "selected" })
        .released;
      expect(adoptedInterrupt).toHaveBeenCalledOnce();
      expect(originalInterrupt).not.toHaveBeenCalled();
    } finally {
      admission.release();
    }
  },
);
