import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  reconcileSlackDirectProjections,
  recoverSlackDirectProjection,
} from "./direct-projection.js";
const mocks = vi.hoisted(() => ({ entry: vi.fn(), list: vi.fn() }));
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  getSessionEntry: mocks.entry,
  listSessionKeys: (...args: unknown[]) =>
    mocks.list(...args).map(({ sessionKey }: { sessionKey: string }) => sessionKey),
  sessionDeliveryOrigin: (entry: { origin?: unknown } | undefined) => entry?.origin,
}));
const sessionKey = "agent:cellect-fi-admin:slack:direct:u111";
describe("Fi direct projection discovery", () => {
  it("recovers only a complete native snapshot and never seeds empty history on read failure", async () => {
    const directSource = { workspaceId: "T123", channelId: "D123", peerSenderId: "U111" };
    const readDirect = vi.fn().mockResolvedValue({
      directSource,
      messages: [
        {
          messageId: "1700000000.000001",
          senderId: "U111",
          content: "Existing history",
          bot: false,
        },
      ],
    });
    const resolveSource = vi.fn().mockResolvedValue({ sourceAccountId: "configured-admin" });
    const api = {
      runtime: {
        channel: {
          runtimeContexts: {
            get: ({ channelId }: { channelId: string }) =>
              channelId === "matrix" ? { resolveSource } : { readDirect, botUserId: "U222" },
          },
        },
      },
    } as unknown as OpenClawPluginApi;
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, json: async () => ({ status: "existing" }) } as Response);
    const connection = { baseUrl: "https://fi.example", token: "test" };
    await expect(
      recoverSlackDirectProjection(api, connection, sessionKey, directSource),
    ).resolves.toEqual({ status: "existing" });
    const body = request.mock.calls[0]?.[1]?.body;
    if (typeof body !== "string") {
      throw new Error("Expected body");
    }
    expect(JSON.parse(body)).toMatchObject({
      directSource,
      sessionKey,
      snapshot: { complete: true, messages: [{ content: "Existing history" }] },
    });
    readDirect.mockRejectedValueOnce(new Error("partial source"));
    await expect(
      recoverSlackDirectProjection(api, connection, sessionKey, directSource),
    ).rejects.toThrow("partial source");
    expect(request).toHaveBeenCalledTimes(1);
    request.mockRestore();
  });
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.list.mockReturnValue([{ sessionKey, entry: {} }]);
    mocks.entry.mockReturnValue({
      origin: { accountId: "configured-admin", nativeChannelId: "D123" },
    });
  });
  it.each([false, true])(
    "preserves exact peer/account and revokes existing access on reader outage=%s",
    async (outage) => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue({ ok: true, json: async () => ({ status: "existing" }) } as Response);
      const readDirect = vi.fn(async () => {
        if (outage) {
          throw new Error("access denied");
        }
        return {
          directSource: { workspaceId: "T123", channelId: "D123", peerSenderId: "U111" },
          messages: [
            { messageId: "1700000000.000001", senderId: "U222", content: "Reply", bot: true },
          ],
        };
      });
      const api = {
        config: {
          bindings: [
            {
              agentId: "cellect-fi-admin",
              match: { channel: "slack", accountId: "configured-admin" },
            },
          ],
        },
        logger: { warn: vi.fn() },
        runtime: {
          channel: { runtimeContexts: { get: () => ({ botUserId: "U222", readDirect }) } },
        },
      } as unknown as OpenClawPluginApi;
      const report = await reconcileSlackDirectProjections(
        api,
        { baseUrl: "https://fi.example", token: "test" },
        [{ sessionKey, roomId: "!room" }],
        new AbortController().signal,
      );
      expect(readDirect).toHaveBeenCalledWith("D123", "U111");
      const request = fetchMock.mock.calls[0]?.[1];
      if (typeof request?.body !== "string") {
        throw new Error("Expected JSON request body");
      }
      const payload = JSON.parse(request.body);
      expect(payload.sessionKey).toBe(sessionKey);
      if (outage) {
        expect(payload).toMatchObject({
          reconcile: true,
          unavailable: true,
          projectionRoomId: "!room",
        });
        expect(payload).not.toHaveProperty("snapshot");
        expect(report.error).toBe(1);
      } else {
        expect(payload.directSource).toEqual({
          workspaceId: "T123",
          channelId: "D123",
          peerSenderId: "U111",
        });
        expect(payload.snapshot.messages[0].agentId).toBe("cellect-fi-admin");
        expect(payload).not.toHaveProperty("source");
        expect(report.existing).toBe(1);
      }
      fetchMock.mockRestore();
    },
  );

  it("rotates historical direct snapshots instead of replaying every direct session", async () => {
    const sessions = Array.from(
      { length: 3 },
      (_, index) => `agent:cellect-fi-admin:slack:direct:u${String(index + 1).padStart(3, "0")}`,
    );
    mocks.list.mockReturnValue(sessions.map((key) => ({ sessionKey: key, entry: {} })));
    mocks.entry.mockImplementation(({ sessionKey: key }: { sessionKey: string }) => ({
      origin: { accountId: "configured-admin", nativeChannelId: `D${key.slice(-3)}` },
    }));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, json: async () => ({ status: "existing" }) } as Response);
    const api = {
      config: {
        bindings: [
          {
            agentId: "cellect-fi-admin",
            match: { channel: "slack", accountId: "configured-admin" },
          },
        ],
      },
      logger: { warn: vi.fn() },
      runtime: {
        channel: {
          runtimeContexts: {
            get: () => ({
              botUserId: "U222",
              readDirect: async (channelId: string, peerSenderId: string) => ({
                directSource: { workspaceId: "T123", channelId, peerSenderId },
                messages: [],
              }),
            }),
          },
        },
      },
    } as unknown as OpenClawPluginApi;
    const seen = new Set<string>();
    const args = [
      api,
      { baseUrl: "https://fi.example", token: "test" },
      sessions.map((key, index) => ({ sessionKey: key, roomId: `!room${index}` })),
      new AbortController().signal,
      seen,
    ] as const;
    await reconcileSlackDirectProjections(...args);
    await reconcileSlackDirectProjections(...args);
    await reconcileSlackDirectProjections(...args);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.map((call) => {
        const body = call[1]?.body;
        if (typeof body !== "string") {
          throw new Error("Expected JSON request body");
        }
        return JSON.parse(body).sessionKey;
      }),
    ).toEqual(sessions);
    fetchMock.mockRestore();
  });
  it("reports only never-reconciled DMs as backlog and drains a new DM before rotating", async () => {
    const sessions = ["u001", "u002", "u003"].map(
      (peer) => `agent:cellect-fi-admin:slack:direct:${peer}`,
    );
    mocks.list.mockReturnValue(sessions.map((key) => ({ sessionKey: key, entry: {} })));
    mocks.entry.mockImplementation(({ sessionKey: key }: { sessionKey: string }) => ({
      origin: { accountId: "configured-admin", nativeChannelId: `D${key.slice(-3)}` },
    }));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, json: async () => ({ status: "existing" }) } as Response);
    const api = {
      config: {
        bindings: [
          {
            agentId: "cellect-fi-admin",
            match: { channel: "slack", accountId: "configured-admin" },
          },
        ],
      },
      logger: { warn: vi.fn() },
      runtime: {
        channel: {
          runtimeContexts: {
            get: () => ({
              botUserId: "U222",
              readDirect: async (channelId: string, peerSenderId: string) => ({
                directSource: { workspaceId: "T123", channelId, peerSenderId },
                messages: [],
              }),
            }),
          },
        },
      },
    } as unknown as OpenClawPluginApi;
    const seen = new Set<string>();
    const backlog = { reconciled: new Set<string>(), failed: new Map(), connectedAt: new Map() };
    const run = () =>
      reconcileSlackDirectProjections(
        api,
        { baseUrl: "https://fi.example", token: "test" },
        [],
        new AbortController().signal,
        seen,
        1,
        undefined,
        backlog,
      );
    expect((await run()).pending).toBe(2);
    expect((await run()).pending).toBe(1);
    expect((await run()).pending).toBe(0);
    // Rotation re-snapshots an already reconciled DM, which is not backlog.
    expect((await run()).pending).toBe(0);
    const added = "agent:cellect-fi-admin:slack:direct:u000";
    mocks.list.mockReturnValue([added, ...sessions].map((key) => ({ sessionKey: key, entry: {} })));
    expect((await run()).pending).toBe(0);
    const order = fetchMock.mock.calls.map((call) => {
      const body = call[1]?.body;
      if (typeof body !== "string") {
        throw new Error("Expected JSON request body");
      }
      return JSON.parse(body).sessionKey;
    });
    expect(order).toEqual([...sessions, sessions[0], added]);
    fetchMock.mockRestore();
  });
  it("retries a failed DM on its own short backoff instead of marking it done", async () => {
    vi.useFakeTimers();
    const failing = "agent:cellect-fi-admin:slack:direct:u001";
    const sessions = [failing, "agent:cellect-fi-admin:slack:direct:u002"];
    mocks.list.mockReturnValue(sessions.map((key) => ({ sessionKey: key, entry: {} })));
    mocks.entry.mockImplementation(({ sessionKey: key }: { sessionKey: string }) => ({
      origin: { accountId: "configured-admin", nativeChannelId: `D${key.slice(-3)}` },
    }));
    let outage = true;
    const readDirect = vi.fn(async (channelId: string, peerSenderId: string) => {
      if (outage && channelId === "D001") {
        throw new Error("Matrix unavailable");
      }
      return { directSource: { workspaceId: "T123", channelId, peerSenderId }, messages: [] };
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, json: async () => ({ status: "existing" }) } as Response);
    const api = {
      config: {
        bindings: [
          {
            agentId: "cellect-fi-admin",
            match: { channel: "slack", accountId: "configured-admin" },
          },
        ],
      },
      logger: { warn: vi.fn() },
      runtime: {
        channel: { runtimeContexts: { get: () => ({ botUserId: "U222", readDirect }) } },
      },
    } as unknown as OpenClawPluginApi;
    const backlog = { reconciled: new Set<string>(), failed: new Map(), connectedAt: new Map() };
    const run = () =>
      reconcileSlackDirectProjections(
        api,
        { baseUrl: "https://fi.example", token: "test" },
        sessions.map((key, index) => ({ sessionKey: key, roomId: `!room${index}` })),
        new AbortController().signal,
        new Set(),
        1,
        undefined,
        backlog,
      );
    expect(await run()).toMatchObject({ error: 1, pending: 1 });
    expect(backlog.reconciled.has(failing)).toBe(false);
    expect(await run()).toMatchObject({ existing: 1, pending: 0 });
    // Waiting out its backoff is not pending, and rotation leaves it alone.
    expect(await run()).toMatchObject({ pending: 0 });
    expect(readDirect.mock.calls.map(([channelId]) => channelId)).toEqual(["D001", "D002", "D002"]);
    outage = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await run()).toMatchObject({ existing: 1, pending: 0 });
    expect(readDirect).toHaveBeenLastCalledWith("D001", "U001");
    expect(backlog.reconciled.has(failing)).toBe(true);
    fetchMock.mockRestore();
    vi.useRealTimers();
  });
  it("does not retry a DM whose identity cannot resolve until that identity changes", async () => {
    vi.useFakeTimers();
    const session = "agent:cellect-fi-admin:slack:direct:u001";
    mocks.list.mockReturnValue([{ sessionKey: session, entry: {} }]);
    let origin: Record<string, string> = { accountId: "configured-admin" };
    mocks.entry.mockImplementation(() => ({ origin }));
    const readDirect = vi.fn(async (channelId: string, peerSenderId: string) => ({
      directSource: { workspaceId: "T123", channelId, peerSenderId },
      messages: [],
    }));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, json: async () => ({ status: "existing" }) } as Response);
    const api = {
      config: {
        bindings: [
          {
            agentId: "cellect-fi-admin",
            match: { channel: "slack", accountId: "configured-admin" },
          },
        ],
      },
      logger: { warn: vi.fn() },
      runtime: {
        channel: { runtimeContexts: { get: () => ({ botUserId: "U222", readDirect }) } },
      },
    } as unknown as OpenClawPluginApi;
    const backlog = { reconciled: new Set<string>(), failed: new Map(), connectedAt: new Map() };
    const run = () =>
      reconcileSlackDirectProjections(
        api,
        { baseUrl: "https://fi.example", token: "test" },
        [{ sessionKey: session, roomId: "!room" }],
        new AbortController().signal,
        new Set(),
        1,
        undefined,
        backlog,
      );
    // No native DM channel on the session: deterministic, so no backoff loop.
    expect(await run()).toMatchObject({ error: 1, pending: 0 });
    const revokes = fetchMock.mock.calls.length;
    for (let hour = 0; hour < 6; hour++) {
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(await run()).toMatchObject({ error: 0, pending: 0 });
    }
    expect(fetchMock.mock.calls.length).toBe(revokes);
    origin = { accountId: "configured-admin", nativeChannelId: "D001" };
    expect(await run()).toMatchObject({ existing: 1, pending: 0 });
    expect(readDirect).toHaveBeenCalledWith("D001", "U001");
    fetchMock.mockRestore();
    vi.useRealTimers();
  });
  it("discovers an eligible superadmin DM from its existing OpenClaw session", async () => {
    const mainSession = "agent:cellect-main:slack:direct:u111";
    mocks.list.mockImplementation(({ agentId }: { agentId: string }) =>
      agentId === "cellect-main" ? [{ sessionKey: mainSession }] : [],
    );
    mocks.entry.mockReturnValue({ origin: { accountId: "cellect-main", nativeChannelId: "D123" } });
    const readDirect = vi.fn().mockResolvedValue({
      directSource: { workspaceId: "T123", channelId: "D123", peerSenderId: "U111" },
      messages: [
        { messageId: "1700000000.000001", senderId: "U111", content: "Hello", bot: false },
      ],
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ status: "created" }),
    } as Response);
    const api = {
      config: {
        bindings: [
          { agentId: "cellect-main", match: { channel: "slack", accountId: "cellect-main" } },
        ],
      },
      logger: { warn: vi.fn() },
      runtime: { channel: { runtimeContexts: { get: () => ({ botUserId: "U222", readDirect }) } } },
    } as unknown as OpenClawPluginApi;
    const report = await reconcileSlackDirectProjections(
      api,
      { baseUrl: "https://fi.example", token: "test" },
      [],
      new AbortController().signal,
    );
    expect(report).toMatchObject({ scanned: 1, created: 1, error: 0 });
    expect(readDirect).toHaveBeenCalledWith("D123", "U111");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      agentId: "cellect-main",
      sessionKey: mainSession,
      directSource: { workspaceId: "T123", channelId: "D123", peerSenderId: "U111" },
    });
    fetchMock.mockRestore();
  });
});
