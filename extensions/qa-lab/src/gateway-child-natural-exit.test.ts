import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForQaGatewayNaturalExit } from "./gateway-child-process.js";

afterEach(() => vi.useRealTimers());

function child() {
  return {
    pid: 123,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(),
  };
}

describe("owned natural gateway exit", () => {
  it("does not cross the exact-child barrier until natural close, and never sends a signal", async () => {
    const process = child();
    const closed = createDeferred<void>();
    const groupAlive = vi.fn(() => false);
    const waiting = waitForQaGatewayNaturalExit(process, closed.promise, {
      isProcessGroupAlive: groupAlive,
    });
    expect(groupAlive).not.toHaveBeenCalled();
    process.exitCode = 0;
    closed.resolve();
    await expect(waiting).resolves.toEqual({ pid: 123, exitCode: 0, signalCode: null });
    expect(groupAlive).toHaveBeenCalledExactlyOnceWith(123);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it.each(["nonzero", "signal", "changed-owner", "descendant"] as const)(
    "refuses %s instead of manufacturing successful replacement",
    async (fault) => {
      const process = child();
      const closed = createDeferred<void>();
      const waiting = waitForQaGatewayNaturalExit(process, closed.promise, {
        isProcessGroupAlive: () => fault === "descendant",
      });
      process.exitCode = fault === "nonzero" ? 1 : 0;
      if (fault === "signal") process.signalCode = "SIGKILL";
      if (fault === "changed-owner") process.pid = 124;
      closed.resolve();
      await expect(waiting).rejects.toThrow(/Owned gateway/);
      expect(process.kill).not.toHaveBeenCalled();
    },
  );

  it("times out without falling back to SIGTERM or SIGKILL", async () => {
    vi.useFakeTimers();
    const process = child();
    const closed = createDeferred<void>();
    const waiting = waitForQaGatewayNaturalExit(process, closed.promise, { timeoutMs: 10 });
    const rejected = expect(waiting).rejects.toThrow("did not exit naturally");
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("fails closed on Windows unless an explicit process-tree inspector is supplied", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    if (!descriptor) throw new Error("Missing process platform descriptor");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const owned = child();
      owned.exitCode = 0;
      await expect(waitForQaGatewayNaturalExit(owned, Promise.resolve())).rejects.toThrow(
        "unsupported on Windows",
      );
      const inspect = vi.fn(() => false);
      await expect(
        waitForQaGatewayNaturalExit(owned, Promise.resolve(), { isProcessGroupAlive: inspect }),
      ).resolves.toEqual({ pid: 123, exitCode: 0, signalCode: null });
      expect(inspect).toHaveBeenCalledExactlyOnceWith(123);
      expect(owned.kill).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  });
});
