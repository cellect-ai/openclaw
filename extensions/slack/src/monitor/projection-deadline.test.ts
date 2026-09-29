import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectionDeadline } from "./projection-deadline.js";

afterEach(() => vi.useRealTimers());

describe("projection read deadline", () => {
  it("bounds an in-flight SDK request and refuses subsequent reads", async () => {
    vi.useFakeTimers();
    const read = createProjectionDeadline();
    const pending = read(() => new Promise<never>(() => {}));
    const rejected = expect(pending).rejects.toThrow("deadline exceeded");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    const next = vi.fn(async () => "must not read");
    await expect(read(next)).rejects.toThrow("deadline exceeded");
    expect(next).not.toHaveBeenCalled();
  });

  it("clears its timer after success or failure", async () => {
    vi.useFakeTimers();
    const read = createProjectionDeadline();
    await expect(read(async () => "ok")).resolves.toBe("ok");
    await expect(
      read(async () => {
        throw new Error("SDK failure");
      }),
    ).rejects.toThrow("SDK failure");
    expect(vi.getTimerCount()).toBe(0);
  });
});
