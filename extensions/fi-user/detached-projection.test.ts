import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelProjectionParams } from "./channel-projection.js";
import { createDetachedProjectionReconciler, planProjectionRoom } from "./detached-projection.js";
import { reconcileRetryDelay } from "./reconciliation-batch.js";
const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  listSessionKeys: (...args: unknown[]) =>
    mocks.list(...args).map(({ sessionKey }: { sessionKey: string }) => sessionKey),
  getSessionEntry: mocks.get,
  sessionDeliveryOrigin: (entry: unknown) => entry,
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("native parent-session Slack history discovery", () => {
  function fixture(agentId = "cellect-fi-admin") {
    const sessionKey = `agent:${agentId}:slack:group:c123`;
    const entry = { accountId: agentId, nativeChannelId: "C123" };
    mocks.list.mockReturnValue([{ sessionKey, entry }]);
    mocks.get.mockReturnValue(entry);
    const readHistoryPage = vi.fn().mockResolvedValue({ roots: [], nextCursor: undefined });
    const scope = {
      workspaceId: "T123",
      channelId: "C123",
      memberSenderIds: ["U111"],
      readHistoryPage,
      readThread: vi.fn(),
    };
    const readChannel = vi.fn().mockResolvedValue(scope);
    const api = {
      config: {
        bindings: [{ agentId, match: { channel: "slack", accountId: agentId } }],
      },
      runtime: {
        channel: { runtimeContexts: { get: () => ({ workspaceId: "T123", readChannel }) } },
      },
      logger: { warn: vi.fn(), info: vi.fn() },
    } as unknown as OpenClawPluginApi;
    const publish = vi.fn(async (params: ChannelProjectionParams) => {
      params.onResult?.("created");
      return true;
    });
    return { api, sessionKey, readHistoryPage, readChannel, publish };
  }
  it("pages beyond one root batch without fabricating sessions or starving failed roots", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const roots = Array.from(
      { length: 12 },
      (_, index) => `1700000000.${String(index).padStart(6, "0")}`,
    );
    f.readHistoryPage
      .mockResolvedValueOnce({ roots, nextCursor: "older" })
      .mockResolvedValueOnce({ roots: ["1600000000.000001"], nextCursor: undefined });
    let failed = false;
    f.publish.mockImplementation(async (params) => {
      if (!failed) {
        failed = true;
        throw new Error("transient");
      }
      params.onResult?.("created");
      return true;
    });
    const { reconcile } = createDetachedProjectionReconciler(f.api, f.publish);
    const connection = { baseUrl: "https://fi.example", token: "test" };
    const signal = new AbortController().signal;
    expect(await reconcile(connection, [], signal, new Set())).toMatchObject({
      pending: 1,
      actionable: 1,
      error: 1,
    });
    for (let index = 0; index < 11; index++) {
      await reconcile(connection, [], signal, new Set());
    }
    // The failed root waits out its backoff without holding the scan open.
    expect(await reconcile(connection, [], signal, new Set())).toMatchObject({
      pending: 0,
      actionable: 0,
      error: 1,
      created: 12,
    });
    await reconcile(connection, [], signal, new Set());
    expect(f.publish).toHaveBeenCalledTimes(13);
    await vi.advanceTimersByTimeAsync(reconcileRetryDelay(1));
    await reconcile(connection, [], signal, new Set());
    expect(await reconcile(connection, [], signal, new Set())).toMatchObject({
      pending: 0,
      error: 0,
      created: 1,
    });
    expect(f.publish).toHaveBeenCalledTimes(14);
    expect(f.readHistoryPage.mock.calls).toEqual([[undefined], ["older"], [undefined]]);
    for (const [params] of f.publish.mock.calls) {
      expect(params).toMatchObject({
        sessionKey: f.sessionKey,
        detachedSource: { workspaceId: "T123", channelId: "C123" },
        discover: true,
      });
    }
  });
  it("discovers superadmin parent-channel history through its configured Slack account", async () => {
    const f = fixture("cellect-main");
    f.readHistoryPage.mockResolvedValue({ roots: ["1700000000.000001"], nextCursor: undefined });
    const { reconcile } = createDetachedProjectionReconciler(f.api, f.publish);
    await reconcile(
      { baseUrl: "https://fi.example", token: "test" },
      [],
      new AbortController().signal,
      new Set(),
    );
    expect(f.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:cellect-main:slack:group:c123",
        detachedSource: expect.objectContaining({ channelId: "C123" }),
        discover: true,
      }),
    );
  });
  it("revokes an existing detached room when its native parent disappears", async () => {
    const f = fixture();
    mocks.list.mockReturnValue([]);
    mocks.get.mockReturnValue(undefined);
    const source = {
      provider: "slack" as const,
      workspaceId: "T123",
      channelId: "C123",
      rootMessageId: "1700000000.000001",
    };
    const { reconcile } = createDetachedProjectionReconciler(f.api, f.publish);
    const result = await reconcile(
      { baseUrl: "https://fi.example", token: "test" },
      [{ sessionKey: f.sessionKey, roomId: "!room", externalSource: source }],
      new AbortController().signal,
      new Set(),
    );
    expect(result.unavailable).toBe(1);
    expect(f.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        unavailable: true,
        reconcile: true,
        projectionRoomId: "!room",
        detachedSource: source,
      }),
    );
    expect(f.readChannel).not.toHaveBeenCalled();
  });
  it("bounds existing detached-room repair and reports the remaining backlog", async () => {
    const f = fixture();
    const bindings = Array.from({ length: 12 }, (_, index) => ({
      sessionKey: f.sessionKey,
      roomId: `!room${String(index).padStart(2, "0")}`,
      sourceAccountId: "fi-admin",
      externalSource: {
        provider: "slack" as const,
        workspaceId: "T123",
        channelId: "C123",
        rootMessageId: `1700000000.${String(index).padStart(6, "0")}`,
      },
    }));
    const { reconcile } = createDetachedProjectionReconciler(f.api, f.publish);
    const first = await reconcile(
      { baseUrl: "https://fi.example", token: "test" },
      bindings,
      new AbortController().signal,
      new Set(),
    );
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(first.pending).toBe(11);
    let latest = first;
    for (let index = 1; index < 12; index++) {
      latest = await reconcile(
        { baseUrl: "https://fi.example", token: "test" },
        bindings,
        new AbortController().signal,
        new Set(),
      );
    }
    expect(f.publish).toHaveBeenCalledTimes(12);
    expect(latest.pending).toBe(0);
  });
  describe("drifted existing rooms", () => {
    it("keeps the readers-only pass and leaves planning to the drift pass", async () => {
      const f = fixture();
      const plan = vi.fn(async () => ({ converged: false, invariantsOk: false }));
      const readChannel = f.readChannel;
      (f.api.runtime.channel.runtimeContexts as unknown as { get: (key: unknown) => unknown }).get =
        () => ({ workspaceId: "T123", readChannel, list: async () => [], plan });
      const { reconcile } = createDetachedProjectionReconciler(f.api, f.publish);
      await reconcile(
        { baseUrl: "https://fi.example", token: "test" },
        [0, 1].map((index) => ({
          sessionKey: f.sessionKey,
          roomId: `!room${index}`,
          sourceAccountId: "cellect-fi-admin",
          externalSource: {
            provider: "slack" as const,
            workspaceId: "T123",
            channelId: "C123",
            rootMessageId: `1700000000.00000${index}`,
          },
        })),
        new AbortController().signal,
        new Set(),
        { maxExistingRooms: 2, allowDiscovery: false },
      );
      expect(plan).not.toHaveBeenCalled();
      expect(
        f.publish.mock.calls.map(([params]) => [params.projectionRoomId, params.membershipOnly]),
      ).toEqual([
        ["!room0", true],
        ["!room1", true],
      ]);
    });

    it("logs a failed plan and reports no verdict", async () => {
      const logger = { warn: vi.fn() };
      const plan = vi.fn().mockRejectedValueOnce(new Error("Matrix unavailable"));
      expect(await planProjectionRoom({ list: async () => [], plan }, "!room0", logger)).toBe(
        undefined,
      );
      expect(logger.warn).toHaveBeenCalledWith(
        "fi-user: projection refresh plan failed room=!room0 error=Matrix unavailable",
      );
    });
  });
  it("rescans completed skipped roots after opt-out restoration and live parent activity", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.readHistoryPage.mockResolvedValue({ roots: ["1700000000.000001"], nextCursor: undefined });
    f.publish.mockImplementationOnce(async (params) => {
      params.onResult?.("skipped");
      return true;
    });
    const projection = createDetachedProjectionReconciler(f.api, f.publish);
    const run = () =>
      projection.reconcile(
        { baseUrl: "https://fi.example", token: "test" },
        [],
        new AbortController().signal,
        new Set<string>(),
      );
    expect(await run()).toMatchObject({ skipped: 1 });
    await run();
    expect(f.publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await run()).toMatchObject({ created: 1, skipped: 0 });
    expect(f.publish).toHaveBeenCalledTimes(2);
    projection.invalidate(f.sessionKey);
    await run();
    expect(f.publish).toHaveBeenCalledTimes(3);
  });
  it("finishes a many-channel initial scan before starting periodic refresh", async () => {
    vi.useFakeTimers();
    const f = fixture();
    mocks.list.mockReturnValue(
      Array.from({ length: 9 }, (_, index) => ({
        sessionKey: `agent:cellect-fi-admin:slack:channel:c${index}23`,
        entry: { accountId: "fi-admin", nativeChannelId: `C${index}23` },
      })),
    );
    f.readHistoryPage.mockResolvedValue({ roots: ["1700000000.000001"], nextCursor: undefined });
    const { reconcile } = createDetachedProjectionReconciler(f.api, f.publish);
    for (let index = 0; index < 9; index++) {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(
        await reconcile(
          { baseUrl: "https://fi.example", token: "test" },
          [],
          new AbortController().signal,
          new Set(),
        ),
      ).toMatchObject({ pending: 8 - index });
    }
    expect(f.publish).toHaveBeenCalledTimes(9);
  });
  describe("maintenance cadence", () => {
    const connection = { baseUrl: "https://fi.example", token: "test" };
    const known = (roots: string[]) => new Set(roots.map((root) => `T123:C123:${root}`));

    it("reports a periodic rescan of known history as pending but not actionable", async () => {
      vi.useFakeTimers();
      const f = fixture();
      const now = Math.floor(Date.now() / 1000);
      const roots = [1, 2, 3].map((index) => `${now}.00000${index}`);
      f.readHistoryPage.mockResolvedValue({ roots, nextCursor: undefined });
      const { reconcile } = createDetachedProjectionReconciler(f.api, f.publish);
      const run = () =>
        reconcile(connection, [], new AbortController().signal, known(roots), {
          maxExistingRooms: 0,
          allowDiscovery: true,
        });
      // Known roots cost no publish, so one pass reads and settles the page.
      expect(await run()).toMatchObject({ pending: 0, actionable: 0, existing: 3 });
      await vi.advanceTimersByTimeAsync(300_000);
      f.readHistoryPage.mockResolvedValue({ roots, nextCursor: "older" });
      expect(await run()).toMatchObject({ pending: 1, actionable: 0 });
      expect(f.readHistoryPage).toHaveBeenCalledTimes(2);
      expect(f.publish).not.toHaveBeenCalled();
    });

    it("promotes a rescan that finds unprojected history back to the backlog", async () => {
      vi.useFakeTimers();
      const f = fixture();
      f.readHistoryPage.mockResolvedValue({ roots: [], nextCursor: undefined });
      const { reconcile } = createDetachedProjectionReconciler(f.api, f.publish);
      const run = () =>
        reconcile(connection, [], new AbortController().signal, new Set(), {
          maxExistingRooms: 0,
          allowDiscovery: true,
        });
      expect(await run()).toMatchObject({ pending: 0 });
      await vi.advanceTimersByTimeAsync(300_000);
      f.readHistoryPage.mockResolvedValue({
        roots: ["1700000000.000001", "1700000000.000002"],
        nextCursor: undefined,
      });
      expect(await run()).toMatchObject({ pending: 1, actionable: 1, created: 1 });
      expect(await run()).toMatchObject({ pending: 0, actionable: 0, created: 2 });
    });

    it("backs off a failing root exponentially without holding its channel open", async () => {
      vi.useFakeTimers();
      const f = fixture();
      const failing = "1700000000.000009";
      f.readHistoryPage.mockResolvedValue({ roots: [failing], nextCursor: undefined });
      const { reconcile } = createDetachedProjectionReconciler(f.api, f.publish);
      const run = () =>
        reconcile(connection, [], new AbortController().signal, new Set(), {
          maxExistingRooms: 0,
          allowDiscovery: true,
        });
      const attemptsAt: number[] = [];
      const start = Date.now();
      f.publish.mockImplementation(async () => {
        attemptsAt.push(Date.now() - start);
        throw new Error("Fi channel projection failed (503)");
      });
      expect(await run()).toMatchObject({ pending: 0, actionable: 0, error: 1 });
      // Reconcile every ten seconds for four hours; the old loop retried the
      // root on every pass.
      for (let tick = 0; tick < (4 * 3600) / 10; tick++) {
        await vi.advanceTimersByTimeAsync(10_000);
        expect((await run()).actionable).toBe(0);
      }
      const gaps = attemptsAt.slice(1).map((at, index) => at - (attemptsAt[index] ?? 0));
      expect(gaps.map((gap) => gap / 60_000)).toEqual([5, 10, 20, 40, 60, 60]);
    });

    it("rescans only recent history after the first full scan", async () => {
      vi.useFakeTimers();
      const f = fixture();
      const now = Math.floor(Date.now() / 1000);
      const pages = new Map<string | undefined, { roots: string[]; nextCursor?: string }>([
        [undefined, { roots: [`${now}.000001`], nextCursor: "p2" }],
        ["p2", { roots: ["1600000000.000002"], nextCursor: "p3" }],
        ["p3", { roots: ["1500000000.000003"], nextCursor: "p4" }],
        ["p4", { roots: ["1400000000.000004"], nextCursor: undefined }],
      ]);
      f.readHistoryPage.mockImplementation(async (cursor?: string) => pages.get(cursor));
      const roots = [...pages.values()].flatMap((page) => page.roots);
      const { reconcile } = createDetachedProjectionReconciler(f.api, f.publish);
      const run = () =>
        reconcile(connection, [], new AbortController().signal, known(roots), {
          maxExistingRooms: 0,
          allowDiscovery: true,
        });
      for (let pass = 0; pass < 4; pass++) {
        await run();
      }
      expect(f.readHistoryPage.mock.calls).toEqual([[undefined], ["p2"], ["p3"], ["p4"]]);
      f.readHistoryPage.mockClear();
      await vi.advanceTimersByTimeAsync(300_000);
      for (let pass = 0; pass < 4; pass++) {
        await run();
      }
      // The second page reaches roots older than the previous scan: stop there.
      expect(f.readHistoryPage.mock.calls).toEqual([[undefined], ["p2"]]);
      // Even a channel where everything is recent is capped at three pages.
      pages.set("p2", { roots: [`${now}.000002`], nextCursor: "p3" });
      pages.set("p3", { roots: [`${now}.000003`], nextCursor: "p4" });
      f.readHistoryPage.mockClear();
      await vi.advanceTimersByTimeAsync(300_000);
      for (let pass = 0; pass < 5; pass++) {
        await run();
      }
      expect(f.readHistoryPage.mock.calls).toEqual([[undefined], ["p2"], ["p3"]]);
    });

    it("pages deeper after a truncated rescan until it reaches the unread window", async () => {
      vi.useFakeTimers();
      const f = fixture();
      const now = Math.floor(Date.now() / 1000);
      const cursors = ["p2", "p3", "p4", "p5", "p6", undefined];
      const pages = new Map<string | undefined, { roots: string[]; nextCursor?: string }>(
        [undefined, ...cursors.slice(0, -1)].map((cursor, index) => [
          cursor,
          {
            // Five pages of recent history, then one old page.
            roots: [index < 5 ? `${now}.00000${index}` : "1600000000.000001"],
            nextCursor: cursors[index],
          },
        ]),
      );
      f.readHistoryPage.mockImplementation(async (cursor?: string) => pages.get(cursor));
      const roots = [...pages.values()].flatMap((page) => page.roots);
      const { reconcile } = createDetachedProjectionReconciler(f.api, f.publish);
      const run = () =>
        reconcile(connection, [], new AbortController().signal, known(roots), {
          maxExistingRooms: 0,
          allowDiscovery: true,
        });
      const scan = async () => {
        f.readHistoryPage.mockClear();
        for (let pass = 0; pass < 8; pass++) {
          await run();
        }
        return f.readHistoryPage.mock.calls.length;
      };
      expect(await scan()).toBe(6);
      await vi.advanceTimersByTimeAsync(300_000);
      // Capped at three pages, short of the previous scan's window...
      expect(await scan()).toBe(3);
      await vi.advanceTimersByTimeAsync(300_000);
      // ...so the next rescan keeps that window and pages deeper to reach it.
      expect(await scan()).toBe(6);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(await scan()).toBe(3);
    });

    it("rescans full depth once a day to find old threads that became Claw conversations", async () => {
      vi.useFakeTimers();
      const f = fixture();
      const now = Math.floor(Date.now() / 1000);
      const pages = new Map<string | undefined, { roots: string[]; nextCursor?: string }>([
        [undefined, { roots: [`${now}.000001`], nextCursor: "p2" }],
        ["p2", { roots: ["1600000000.000002"], nextCursor: "p3" }],
        ["p3", { roots: ["1500000000.000003"], nextCursor: "p4" }],
        ["p4", { roots: ["1400000000.000004"], nextCursor: undefined }],
      ]);
      f.readHistoryPage.mockImplementation(async (cursor?: string) => pages.get(cursor));
      const roots = [...pages.values()].flatMap((page) => page.roots);
      const { reconcile } = createDetachedProjectionReconciler(f.api, f.publish);
      const fullDepthAt: number[] = [];
      const start = Date.now();
      for (let minute = 0; minute <= 50 * 60; minute += 1) {
        f.readHistoryPage.mockClear();
        await reconcile(connection, [], new AbortController().signal, known(roots), {
          maxExistingRooms: 0,
          allowDiscovery: true,
        });
        if (f.readHistoryPage.mock.calls.some(([cursor]) => cursor === "p4")) {
          fullDepthAt.push(Math.round((Date.now() - start) / 3_600_000));
        }
        await vi.advanceTimersByTimeAsync(60_000);
      }
      // The first scan, then one full-depth rescan a day; the five-minute
      // rescans in between stop at the second page.
      expect(fullDepthAt).toEqual([0, 24, 48]);
    });

    it("keeps rescanning other channels while one channel cannot be read", async () => {
      vi.useFakeTimers();
      const f = fixture();
      mocks.list.mockReturnValue(
        ["c0bad", "c123"].map((channel) => ({
          sessionKey: `agent:cellect-fi-admin:slack:group:${channel}`,
          entry: {},
        })),
      );
      const now = Math.floor(Date.now() / 1000);
      const good = vi.fn(async () => ({ roots: [`${now}.000001`], nextCursor: undefined }));
      const bad = vi.fn(async () => {
        throw new Error("not_in_channel");
      });
      f.readChannel.mockImplementation(async (channelId: string) => ({
        workspaceId: "T123",
        channelId,
        memberSenderIds: ["U111"],
        readHistoryPage: channelId === "C0BAD" ? bad : good,
        readThread: vi.fn(),
      }));
      const { reconcile } = createDetachedProjectionReconciler(f.api, f.publish);
      const run = () =>
        reconcile(connection, [], new AbortController().signal, known([`${now}.000001`]), {
          maxExistingRooms: 0,
          allowDiscovery: true,
        });
      for (let tick = 0; tick < 12 * 20; tick++) {
        await run();
        await vi.advanceTimersByTimeAsync(5_000);
      }
      // Twenty minutes: the good channel is rescanned every five minutes, and
      // the unreadable one backs off (0, 5, 15 min) without holding it back.
      expect(good.mock.calls.length).toBeGreaterThanOrEqual(4);
      expect(bad).toHaveBeenCalledTimes(3);
    });

    it("treats a root deleted at the source as terminal", async () => {
      vi.useFakeTimers();
      const f = fixture();
      f.readHistoryPage.mockResolvedValue({ roots: ["1700000000.000001"], nextCursor: undefined });
      f.publish.mockRejectedValue(new Error("thread_not_found"));
      const { reconcile } = createDetachedProjectionReconciler(
        f.api,
        f.publish,
        (error) => error instanceof Error && error.message === "thread_not_found",
      );
      expect(
        await reconcile(connection, [], new AbortController().signal, new Set(), {
          maxExistingRooms: 0,
          allowDiscovery: true,
        }),
      ).toMatchObject({ pending: 0, error: 0, skipped: 1 });
    });

    it("retries backed-off channels and roots once after a service restart", async () => {
      vi.useFakeTimers();
      const f = fixture();
      f.readHistoryPage.mockRejectedValue(new Error("ratelimited"));
      const projection = createDetachedProjectionReconciler(f.api, f.publish);
      const run = () =>
        projection.reconcile(connection, [], new AbortController().signal, new Set(), {
          maxExistingRooms: 0,
          allowDiscovery: true,
        });
      await run();
      await run();
      expect(f.readHistoryPage).toHaveBeenCalledTimes(1);
      projection.resetBackoff();
      await run();
      expect(f.readHistoryPage).toHaveBeenCalledTimes(2);
    });

    it("backs off a channel whose history cannot be read", async () => {
      vi.useFakeTimers();
      const f = fixture();
      f.readHistoryPage.mockRejectedValue(new Error("not_in_channel"));
      const { reconcile } = createDetachedProjectionReconciler(f.api, f.publish);
      const run = () =>
        reconcile(connection, [], new AbortController().signal, new Set(), {
          maxExistingRooms: 0,
          allowDiscovery: true,
        });
      expect(await run()).toMatchObject({ pending: 1, actionable: 0, error: 1 });
      for (let tick = 0; tick < 29; tick++) {
        await vi.advanceTimersByTimeAsync(10_000);
        await run();
      }
      expect(f.readHistoryPage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      await run();
      expect(f.readHistoryPage).toHaveBeenCalledTimes(2);
    });
  });
});
