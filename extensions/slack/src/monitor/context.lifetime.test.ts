import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { createMonitorTestContext } from "./monitor-context.test-support.js";
import { prewarmSlackRuntimeContext } from "./runtime-policy.js";

const resolveUsers = vi.hoisted(() => vi.fn());
vi.mock("../resolve-users.js", () => ({ resolveSlackUserAllowlist: resolveUsers }));

it.each(["abort", "close"] as const)(
  "retires an admitted policy on monitor %s without changing config or installation",
  async (kind) => {
    const abort = new AbortController();
    const ctx = createMonitorTestContext({ abortSignal: abort.signal });
    const admitted = await ctx.readRuntimeContext();
    expect(admitted.isRuntimePolicyCurrent()).toBe(true);
    if (kind === "abort") abort.abort();
    else ctx.closeRuntimeContext();
    expect(admitted.isRuntimePolicyCurrent()).toBe(false);
    await expect(ctx.readRuntimeContext()).rejects.toThrow("monitor is no longer current");
    const replacement = createMonitorTestContext({
      cfg: ctx.cfg,
      installationIdentity: ctx.installationIdentity,
    });
    expect((await replacement.readRuntimeContext()).isRuntimePolicyCurrent()).toBe(true);
    expect(admitted.isRuntimePolicyCurrent()).toBe(false);
  },
);

it("settles speculative native policy prewarm when the monitor aborts during name lookup", async () => {
  const entered = createDeferred<void>();
  const release = createDeferred<[]>();
  resolveUsers.mockImplementationOnce(() => {
    entered.resolve();
    return release.promise;
  });
  const abort = new AbortController();
  const log = vi.fn();
  const ctx = createMonitorTestContext({
    abortSignal: abort.signal,
    installationIdentity: { kind: "workspace", teamId: "T_EXPECTED" },
    cfg: {
      channels: {
        slack: { enabled: true, dangerouslyAllowNameMatching: true, allowFrom: ["reviewer"] },
      },
    },
    runtime: { log, error: vi.fn(), exit: vi.fn() },
  });
  const prewarm = prewarmSlackRuntimeContext(ctx);
  await entered.promise;
  abort.abort();
  release.resolve([]);
  await expect(prewarm).resolves.toBeUndefined();
  expect(log).toHaveBeenCalledWith(expect.stringContaining("policy prewarm failed"));
  await expect(ctx.readRuntimeContext()).rejects.toThrow("monitor is no longer current");
});
