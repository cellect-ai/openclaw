import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSlackChannelProjection } from "./channel-projection-registration.js";

const discovery = vi.hoisted(() => ({
  entry: vi.fn(),
  list: vi.fn<
    (params: {
      agentId: string;
      readOnly?: boolean;
    }) => Array<{ sessionKey: string; entry: Record<string, unknown> }>
  >(() => []),
}));
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  getSessionEntry: discovery.entry,
  listSessionKeys: (params: { agentId: string; readOnly?: boolean }) =>
    discovery.list(params).map(({ sessionKey }) => sessionKey),
  sessionDeliveryOrigin: (entry: Record<string, unknown> | undefined) => ({
    accountId: "fi-admin",
    ...entry,
  }),
}));

describe("Slack projection reconciler cadence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    discovery.list.mockReset().mockReturnValue([]);
    discovery.entry.mockReset();
  });
  const parent = "agent:cellect-fi-admin:slack:channel:c123";
  const root = (index: number) => `1700000000.${String(index).padStart(6, "0")}`;
  const detached = (rootMessageId: string) => ({
    sessionKey: parent,
    roomId: `!${rootMessageId}`,
    sourceAccountId: "fi-admin",
    externalSource: {
      provider: "slack" as const,
      workspaceId: "T123",
      channelId: "C123",
      rootMessageId,
    },
  });
  function cadenceFixture(options: {
    history?: string[];
    bound?: string[];
    dms?: string[];
    failing?: string;
  }) {
    const bindings = (options.bound ?? []).map(detached);
    const dms = (options.dms ?? []).map((peer) => `agent:cellect-fi-admin:slack:direct:${peer}`);
    const sessions = [...(options.history ? [parent] : []), ...dms];
    discovery.list.mockImplementation(({ agentId }) =>
      agentId === "cellect-fi-admin"
        ? sessions.map((sessionKey) => ({ sessionKey, entry: {} }))
        : [],
    );
    discovery.entry.mockImplementation(({ sessionKey }: { sessionKey: string }) => ({
      nativeChannelId: sessionKey === parent ? "C123" : `D${sessionKey.slice(-4).toUpperCase()}`,
    }));
    const readHistoryPage = vi.fn(async () => ({ roots: options.history ?? [] }));
    const readChannel = vi.fn(async () => ({
      workspaceId: "T123",
      channelId: "C123",
      memberSenderIds: ["U111"],
      readHistoryPage,
      readThread: async (rootMessageId: string) => ({
        workspaceId: "T123",
        channelId: "C123",
        rootMessageId,
        memberSenderIds: ["U111"],
        messages: [
          { messageId: rootMessageId, senderId: "U111", content: "hi", bot: false },
          { messageId: `${rootMessageId}1`, senderId: "U222", content: "hello", bot: true },
        ],
      }),
    }));
    const slack = { connectedAt: 1, failingDirect: new Set<string>(), inventoryFailures: 0 };
    const readDirect = vi.fn(async (channelId: string, peerSenderId: string) => {
      if (slack.failingDirect.has(channelId)) {
        throw new Error("Fi direct projection failed (503)");
      }
      return { directSource: { workspaceId: "T123", channelId, peerSenderId }, messages: [] };
    });
    const discovered: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      const rootMessageId = body.source?.rootMessageId;
      if (body.sourceDetached && body.discover && rootMessageId) {
        discovered.push(rootMessageId);
        if (rootMessageId === options.failing) {
          return { ok: false, status: 503 };
        }
        bindings.push(detached(rootMessageId));
        return { ok: true, json: async () => ({ status: "created" }) };
      }
      return { ok: true, json: async () => ({ status: "existing" }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    let service: { start: () => void; stop: () => void } | undefined;
    const hooks = new Map<string, Array<(event: never, context: never) => void>>();
    const logger = { warn: vi.fn(), info: vi.fn() };
    const api = {
      config: {
        bindings: [
          { agentId: "cellect-fi-admin", match: { channel: "slack", accountId: "fi-admin" } },
        ],
      },
      logger,
      registerGatewayMethod: vi.fn(),
      registerService: (value: typeof service) => {
        service = value;
      },
      on: (name: string, handler: (event: never, context: never) => void) => {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      runtime: {
        channel: {
          runtimeContexts: {
            get: ({ channelId }: { channelId: string }) =>
              channelId === "matrix"
                ? {
                    list: async () => {
                      if (slack.inventoryFailures > 0) {
                        slack.inventoryFailures--;
                        throw new Error("Matrix projection inventory unavailable");
                      }
                      return bindings;
                    },
                  }
                : {
                    workspaceId: "T123",
                    botUserId: "U222",
                    readChannel,
                    readDirect,
                    socketConnectedAt: () => slack.connectedAt,
                  },
          },
        },
      },
    } as unknown as OpenClawPluginApi;
    registerSlackChannelProjection(api, () => ({
      baseUrl: "https://fi.example",
      token: "test-token",
    }));
    if (!service) {
      throw new Error("Missing registered reconciler");
    }
    const passes = () =>
      logger.info.mock.calls.filter(([line]) =>
        String(line).startsWith("fi-user: Slack discovery "),
      ).length;
    const passesDuring = async (ms: number) => {
      const before = passes();
      await vi.advanceTimersByTimeAsync(ms);
      return passes() - before;
    };
    const wakeDirect = (peer: string) => {
      const sessionKey = `agent:cellect-fi-admin:slack:direct:${peer}`;
      const inbound = hooks.get("message_received")?.[0];
      if (!inbound) {
        throw new Error("Missing DM projection hook");
      }
      inbound(
        { sessionKey } as never,
        { channelId: "slack", accountId: "fi-admin", sessionKey } as never,
      );
    };
    const snapshotted = (from = 0) =>
      f.readDirect.mock.calls.slice(from).map(([channelId]) => channelId);
    const f = { service, hooks, readHistoryPage, readDirect, discovered, passesDuring, slack };
    return { ...f, wakeDirect, snapshotted };
  }

  it("stays on the idle cadence through periodic rescans of known history", async () => {
    vi.useFakeTimers();
    const roots = [root(1), root(2)];
    const f = cadenceFixture({ history: roots, bound: roots });
    f.service.start();
    // The first pass is the channel lane; the detached lane reports its
    // startup backlog (two unchecked rooms, one unread channel) next.
    await vi.advanceTimersByTimeAsync(5_000 + 60_000 + 10_000);
    expect(f.readHistoryPage).toHaveBeenCalledTimes(1);
    const readsBefore = f.readHistoryPage.mock.calls.length;
    // Twenty idle minutes: the five-minute rescan re-arms, but only at the
    // idle cadence. The old scheduler re-entered the one-second backlog loop.
    expect(await f.passesDuring(20 * 60_000)).toBeLessThanOrEqual(21);
    expect(f.readHistoryPage.mock.calls.length).toBeGreaterThan(readsBefore);
    expect(f.discovered).toEqual([]);
    f.service.stop();
  });

  it("drains new history on the backlog cadence and then idles", async () => {
    vi.useFakeTimers();
    const roots = [root(1), root(2), root(3), root(4)];
    const f = cadenceFixture({ history: roots });
    f.service.start();
    await vi.advanceTimersByTimeAsync(5_000 + 60_000);
    expect(f.discovered).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000);
    // One publish per detached-history turn (every sixth pass) at one second.
    expect(f.discovered).toEqual(roots);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await f.passesDuring(10 * 60_000)).toBeLessThanOrEqual(11);
    expect(f.discovered).toEqual(roots);
    f.service.stop();
  });

  it("backs off a failing root instead of pinning the backlog cadence", async () => {
    vi.useFakeTimers();
    const failing = root(9);
    const f = cadenceFixture({ history: [root(1), failing], bound: [root(1)], failing });
    f.service.start();
    await vi.advanceTimersByTimeAsync(5_000 + 60_000 + 10_000);
    expect(f.discovered).toEqual([failing]);
    const passes = await f.passesDuring(60 * 60_000);
    expect(passes).toBeLessThanOrEqual(61);
    // Retried on its own backoff (5, 10, 20 min...), not on every pass.
    const attempts = f.discovered.length;
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(attempts).toBeLessThanOrEqual(5);
    f.service.stop();
  });

  it("snapshots new DMs promptly, rotates them on the idle cadence, and still wakes on a live DM", async () => {
    vi.useFakeTimers();
    const f = cadenceFixture({ dms: ["u001", "u002", "u003"] });
    f.service.start();
    // Channel and detached lanes idle first; the direct lane then finds
    // three never-snapshotted DMs and drains them a second apart.
    await vi.advanceTimersByTimeAsync(5_000 + 120_000);
    expect(f.readDirect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.readDirect.mock.calls.map(([channelId]) => channelId).toSorted()).toEqual([
      "DU001",
      "DU002",
      "DU003",
    ]);
    const snapshots = f.readDirect.mock.calls.length;
    // With three DMs the old pending count never reached zero.
    expect(await f.passesDuring(10 * 60_000)).toBeLessThanOrEqual(11);
    expect(f.readDirect.mock.calls.length - snapshots).toBeLessThanOrEqual(4);
    const target = "agent:cellect-fi-admin:slack:direct:u002";
    const inbound = f.hooks.get("message_received")?.[0];
    if (!inbound) {
      throw new Error("Missing DM projection hook");
    }
    const beforeWake = f.readDirect.mock.calls.length;
    inbound(
      { sessionKey: target } as never,
      { channelId: "slack", accountId: "fi-admin", sessionKey: target } as never,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.readDirect.mock.calls.slice(beforeWake)).toEqual([["DU002", "U002"]]);
    f.service.stop();
  });
  it("heals a DM whose snapshot failed within minutes, not a full rotation", async () => {
    vi.useFakeTimers();
    const peers = ["u001", "u002", "u003", "u004", "u005", "u006"];
    const f = cadenceFixture({ dms: peers });
    f.slack.failingDirect.add("DU003");
    f.service.start();
    await vi.advanceTimersByTimeAsync(5_000 + 120_000 + 30_000);
    expect(new Set(f.snapshotted())).toEqual(
      new Set(peers.map((peer) => `D${peer.toUpperCase()}`)),
    );
    f.slack.failingDirect.clear();
    const healStart = f.readDirect.mock.calls.length;
    // A six-DM rotation at the idle cadence takes 18 minutes. The failed DM
    // (its readers were revoked) comes back on its own 30 s backoff, picked
    // up by the next direct-lane pass.
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(f.snapshotted(healStart)).toContain("DU003");
    f.service.stop();
  });

  it("re-snapshots every DM once after the Slack socket reconnects", async () => {
    vi.useFakeTimers();
    const peers = ["u001", "u002", "u003", "u004", "u005", "u006"];
    const f = cadenceFixture({ dms: peers });
    f.service.start();
    await vi.advanceTimersByTimeAsync(5_000 + 120_000 + 30_000);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const before = f.readDirect.mock.calls.length;
    f.slack.connectedAt = 2;
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(new Set(f.snapshotted(before))).toEqual(
      new Set(peers.map((peer) => `D${peer.toUpperCase()}`)),
    );
    // ...and then goes back to idle rotation.
    expect(await f.passesDuring(10 * 60_000)).toBeLessThanOrEqual(11);
    f.service.stop();
  });

  it("serves a live DM whose first pass failed before reaching it", async () => {
    vi.useFakeTimers();
    const f = cadenceFixture({ dms: ["u001"] });
    f.service.start();
    await vi.advanceTimersByTimeAsync(5_000 + 180_000);
    const before = f.readDirect.mock.calls.length;
    f.slack.inventoryFailures = 1;
    f.wakeDirect("u001");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.readDirect.mock.calls.length).toBe(before);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.snapshotted(before)).toEqual(["DU001"]);
    f.service.stop();
  });

  it("keeps the lane rotation running under frequent live DM wakes", async () => {
    vi.useFakeTimers();
    const roots = [root(1), root(2), root(3)];
    const f = cadenceFixture({ history: roots, dms: ["u001"] });
    f.service.start();
    // A DM message every 20 s for ten minutes: each is served within a
    // second, and the rotation still reaches the detached history lane.
    for (let tick = 0; tick < 30; tick++) {
      await vi.advanceTimersByTimeAsync(20_000);
      const before = f.readDirect.mock.calls.length;
      f.wakeDirect("u001");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.readDirect.mock.calls.length).toBeGreaterThan(before);
    }
    expect(f.discovered).toEqual(roots);
    f.service.stop();
  });
});
