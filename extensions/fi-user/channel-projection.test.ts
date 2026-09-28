import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSlackChannelProjection } from "./channel-projection-registration.js";
import {
  isMissingSlackThread,
  projectSlackChannelThread,
  registerSlackProjectionReconciler,
} from "./channel-projection.js";

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

describe("Fi Slack channel publisher", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    discovery.list.mockReset().mockReturnValue([]);
    discovery.entry.mockReset();
  });
  it.each(["recover", "persistent", "deleted"])(
    "repairs a woken bound thread with bounded retries (%s), keeping ordinary sweeps membership-only",
    async (failure) => {
      vi.useFakeTimers();
      const sessionKey = "agent:cellect-fi-admin:slack:channel:c123:thread:1700000000.000001";
      discovery.entry.mockReturnValue({ accountId: "fi-admin" });
      const snapshot = {
        workspaceId: "T123",
        channelId: "C123",
        rootMessageId: "1700000000.000001",
        memberSenderIds: ["U111"],
        messages: [
          { messageId: "1700000000.000002", senderId: "U111", content: "latest reply", bot: false },
        ],
      };
      const readThread = vi.fn();
      if (failure === "recover") {
        readThread
          .mockRejectedValueOnce(new Error("Slack snapshot deadline exceeded"))
          .mockResolvedValue(snapshot);
      } else {
        readThread.mockRejectedValue(
          new Error(
            failure === "deleted" ? "thread_not_found" : "Slack snapshot deadline exceeded",
          ),
        );
      }
      const readChannel = vi.fn(async () => ({ ...snapshot, readThread }));
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ status: "existing" }) });
      vi.stubGlobal("fetch", fetchMock);
      let service: { start: () => void; stop: () => void } | undefined;
      const api = {
        config: {
          bindings: [
            { agentId: "cellect-fi-admin", match: { channel: "slack", accountId: "fi-admin" } },
          ],
        },
        logger: { warn: vi.fn(), info: vi.fn() },
        registerGatewayMethod: vi.fn(),
        registerService: (value: typeof service) => {
          service = value;
        },
        runtime: {
          channel: {
            runtimeContexts: {
              get: ({ channelId }: { channelId: string }) =>
                channelId === "matrix"
                  ? { list: async () => [{ sessionKey, roomId: "!room" }] }
                  : { workspaceId: "T123", botUserId: "U222", readChannel, readThread },
            },
          },
        },
      } as unknown as OpenClawPluginApi;
      const repair = registerSlackProjectionReconciler(api, () => ({
        baseUrl: "https://fi.example",
        token: "test-token",
      }));
      if (!service) {
        throw new Error("Missing reconciler");
      }
      service.start();
      await vi.advanceTimersByTimeAsync(5000);
      expect(readThread).not.toHaveBeenCalled();
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty("snapshot");
      fetchMock.mockClear();
      repair.retryChannelProjection(sessionKey);
      await vi.advanceTimersByTimeAsync(1000);
      expect(readThread).toHaveBeenCalledTimes(1);
      // A failed refresh never revokes readers or replaces history with an empty snapshot.
      expect(fetchMock).not.toHaveBeenCalled();
      if (failure !== "recover") {
        for (let event = 0; event < 10; event++) {
          repair.retryChannelProjection(sessionKey);
          await vi.advanceTimersByTimeAsync(500);
        }
        service.stop();
        expect(readThread).toHaveBeenCalledTimes(failure === "deleted" ? 1 : 4);
        expect(fetchMock).not.toHaveBeenCalled();
        return;
      }
      await vi.advanceTimersByTimeAsync(1000);
      service.stop();
      expect(readThread).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
        snapshot: {
          complete: true,
          messages: [{ messageId: "1700000000.000002", role: "user", content: "latest reply" }],
        },
      });
    },
  );
  it("recognizes only Slack's terminal missing-thread error across SDK wrappers", () => {
    expect(isMissingSlackThread(new Error("Slack API failed: thread_not_found"))).toBe(true);
    expect(isMissingSlackThread({ data: { error: "thread_not_found" } })).toBe(true);
    expect(
      isMissingSlackThread({ cause: { response: { data: { error: "THREAD_NOT_FOUND" } } } }),
    ).toBe(true);
    expect(isMissingSlackThread(new Error("Slack API failed: ratelimited"))).toBe(false);
    expect(isMissingSlackThread({ data: { error: "channel_not_found" } })).toBe(false);
  });
  it.each([false, true, "mention" as const])(
    "requires native parent identity and actual bot participation for detached roots (%s)",
    async (participates) => {
      discovery.entry.mockReturnValue({ nativeChannelId: "C123" });
      const source = {
        provider: "slack" as const,
        workspaceId: "T123",
        channelId: "C123",
        rootMessageId: "1700000000.000001",
      };
      const readThread = vi.fn().mockResolvedValue({
        ...source,
        memberSenderIds: ["U111"],
        messages: [
          {
            messageId: source.rootMessageId,
            senderId: participates === true ? "U222" : "U111",
            content: participates === "mention" ? "<@U222> hi" : "hello",
            bot: participates === true,
          },
        ],
      });
      const api = {
        runtime: {
          channel: {
            runtimeContexts: {
              get: ({ channelId }: { channelId: string }) =>
                channelId === "slack"
                  ? { workspaceId: "T123", botUserId: "U222", readThread }
                  : undefined,
            },
          },
        },
      } as unknown as OpenClawPluginApi;
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ status: "created" }) });
      vi.stubGlobal("fetch", fetchMock);
      const onResult = vi.fn();
      const params = {
        api,
        sessionKey: "agent:cellect-fi-admin:slack:group:c123",
        accountId: "fi-admin",
        detachedSource: source,
        baseUrl: "https://fi.example",
        token: "test",
        discover: true,
        onResult,
      };
      await projectSlackChannelThread(params);
      expect(fetchMock).toHaveBeenCalledTimes(participates ? 1 : 0);
      expect(onResult).toHaveBeenCalledWith(participates ? "created" : "skipped");
      discovery.entry.mockReturnValue({ nativeChannelId: "C999" });
      await expect(projectSlackChannelThread(params)).rejects.toThrow("native parent origin");
    },
  );
  it.each(["cellect-fi-admin", "cellect-main"])(
    "projects a %s channel thread with membership evidence and actual source authors",
    async (agentId) => {
      const readThread = vi.fn().mockResolvedValue({
        workspaceId: "T123",
        channelId: "C123",
        rootMessageId: "1700000000.000001",
        memberSenderIds: ["U111"],
        messages: [
          { messageId: "1700000000.000001", senderId: "U111", content: "hi", bot: false },
          { messageId: "1700000000.000002", senderId: "U222", content: "hello", bot: true },
          { messageId: "1700000000.000003", senderId: "U333", content: "another bot", bot: true },
        ],
      });
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);
      const api = {
        runtime: {
          channel: { runtimeContexts: { get: () => ({ readThread, botUserId: "U222" }) } },
        },
      } as unknown as OpenClawPluginApi;
      await projectSlackChannelThread({
        api,
        sessionKey: `agent:${agentId}:slack:channel:c123:thread:1700000000.000001`,
        accountId: "fi-admin",
        requesterSenderId: "U111",
        baseUrl: "https://fi.example",
        token: "test-token",
      });
      expect(readThread).toHaveBeenCalledWith("C123", "1700000000.000001");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const payload = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body))[0];
      expect(payload.source).toMatchObject({ memberSenderIds: ["U111"] });
      expect(payload.snapshot.messages[1]).toMatchObject({
        agentId,
        role: "assistant",
        senderId: "U222",
      });
      expect(payload.snapshot.messages[2]).not.toHaveProperty("agentId");
    },
  );
  it("revokes existing readers on source failure without treating it as message deletion", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const api = {
      runtime: {
        channel: {
          runtimeContexts: {
            get: () => ({
              workspaceId: "T123",
              readThread: async () => {
                throw new Error("not_in_channel");
              },
            }),
          },
        },
      },
    } as unknown as OpenClawPluginApi;
    await expect(
      projectSlackChannelThread({
        api,
        sessionKey: "agent:cellect-fi-admin:slack:channel:c123:thread:1700000000.000001",
        accountId: "fi-admin",
        baseUrl: "https://fi.example",
        token: "test-token",
        reconcile: true,
      }),
    ).rejects.toThrow("not_in_channel");
    const payload = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body))[0];
    expect(payload.source.memberSenderIds).toEqual([]);
    expect(payload.reconcile).toBe(true);
    expect(payload).not.toHaveProperty("snapshot");
  });
  it("keeps both bot authors identical when the same thread is read through different accounts", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const readThread = async () => ({
      workspaceId: "T123",
      channelId: "C123",
      rootMessageId: "1700000000.000001",
      memberSenderIds: ["U111"],
      messages: [
        { messageId: "1700000000.000001", senderId: "U111", content: "hi", bot: false },
        { messageId: "1700000000.000002", senderId: "U222", content: "admin", bot: true },
        { messageId: "1700000000.000003", senderId: "U333", content: "user", bot: true },
      ],
    });
    const api = {
      config: {
        bindings: [
          { agentId: "cellect-fi-admin", match: { channel: "slack", accountId: "fi-admin" } },
          { agentId: "cellect-fi-user", match: { channel: "slack", accountId: "fi-user" } },
        ],
      },
      runtime: {
        channel: {
          runtimeContexts: {
            get: ({ accountId }: { accountId: string }) => ({
              workspaceId: "T123",
              botUserId: accountId === "fi-admin" ? "U222" : "U333",
              readThread,
            }),
          },
        },
      },
    } as unknown as OpenClawPluginApi;
    for (const accountId of ["fi-admin", "fi-user"]) {
      await projectSlackChannelThread({
        api,
        sessionKey: `agent:cellect-${accountId}:slack:channel:c123:thread:1700000000.000001`,
        accountId,
        requesterSenderId: "U111",
        baseUrl: "https://fi.example",
        token: "test-token",
      });
    }
    const snapshots = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).snapshot);
    expect(snapshots[0]).toEqual(snapshots[1]);
    expect(snapshots[0].messages.map((message: { agentId?: string }) => message.agentId)).toEqual([
      undefined,
      "cellect-fi-admin",
      "cellect-fi-user",
    ]);
  });
  it.each([false, true])(
    "rediscovers durable projections after restart, revoking orphaned=%s without an agent turn",
    async (orphaned) => {
      vi.useFakeTimers();
      const sessionKey = "agent:cellect-fi-admin:slack:channel:c123:thread:1700000000.000001";
      discovery.entry.mockReturnValue(orphaned ? undefined : {});
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ status: "existing" }) });
      vi.stubGlobal("fetch", fetchMock);
      let service: { start: () => void; stop: () => void } | undefined;
      const api = {
        config: {
          bindings: [
            { agentId: "cellect-fi-admin", match: { channel: "slack", accountId: "fi-admin" } },
          ],
        },
        logger: { warn: vi.fn(), info: vi.fn() },
        registerGatewayMethod: vi.fn(),
        registerService: (value: typeof service) => {
          service = value;
        },
        runtime: {
          channel: {
            runtimeContexts: {
              get: ({ channelId }: { channelId: string }) =>
                channelId === "matrix"
                  ? { list: async () => [{ sessionKey, roomId: "!room" }] }
                  : {
                      workspaceId: "T123",
                      botUserId: "U222",
                      readChannel: async () => ({
                        workspaceId: "T123",
                        channelId: "C123",
                        memberSenderIds: [],
                        readThread: async () => ({
                          workspaceId: "T123",
                          channelId: "C123",
                          rootMessageId: "1700000000.000001",
                          memberSenderIds: [],
                          messages: [],
                        }),
                      }),
                    },
            },
          },
        },
      } as unknown as OpenClawPluginApi;
      registerSlackProjectionReconciler(api, () => ({
        baseUrl: "https://fi.example",
        token: "test-token",
      }));
      if (!service) {
        throw new Error("Missing registered reconciler");
      }
      service.start();
      await vi.advanceTimersByTimeAsync(5000);
      service.stop();
      service.start();
      await vi.advanceTimersByTimeAsync(5000);
      service.stop();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const payload = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body))[1];
      expect(payload).toMatchObject(
        orphaned
          ? { reconcile: true, unavailable: true, projectionRoomId: "!room" }
          : {
              reconcile: true,
              source: { memberSenderIds: [] },
            },
      );
      expect(payload).not.toHaveProperty("snapshot");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );
  it("discovers unbound historical roots in bounded batches and deduplicates cross-agent roots", async () => {
    vi.useFakeTimers();
    const agents = ["cellect-fi-user", "cellect-fi-admin", "cellect-main"];
    discovery.entry.mockImplementation(({ sessionKey }: { sessionKey: string }) =>
      sessionKey.endsWith(".000011") ? { archivedAt: 1 } : {},
    );
    discovery.list.mockImplementation(({ agentId }: { agentId: string }) =>
      Array.from({ length: 12 }, (_, index) => ({
        sessionKey: `agent:${agentId}:slack:channel:c123:thread:1700000000.${String(index).padStart(6, "0")}`,
        entry: {},
      })),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ status: "skipped" }) });
    vi.stubGlobal("fetch", fetchMock);
    let service: { start: () => void; stop: () => void } | undefined;
    const api = {
      config: {
        bindings: agents.map((agentId, index) => ({
          agentId,
          match: { channel: "slack", accountId: `configured-${index}` },
        })),
      },
      logger: { warn: vi.fn(), info: vi.fn() },
      registerGatewayMethod: vi.fn(),
      registerService: (value: typeof service) => {
        service = value;
      },
      runtime: {
        channel: {
          runtimeContexts: {
            get: ({ channelId }: { channelId: string }) =>
              channelId === "matrix"
                ? { list: async () => [] }
                : {
                    workspaceId: "T123",
                    botUserId: "U222",
                    readChannel: async () => ({
                      workspaceId: "T123",
                      channelId: "C123",
                      memberSenderIds: ["U333"],
                      readThread: async (rootMessageId: string) => ({
                        workspaceId: "T123",
                        channelId: "C123",
                        rootMessageId,
                        memberSenderIds: ["U333"],
                        messages: [
                          {
                            messageId: rootMessageId,
                            senderId: "U111",
                            content: "Historical user left",
                            bot: false,
                          },
                        ],
                      }),
                    }),
                  },
          },
        },
      },
    } as unknown as OpenClawPluginApi;
    registerSlackProjectionReconciler(api, () => ({
      baseUrl: "https://fi.example",
      token: "test-token",
    }));
    if (!service) {
      throw new Error("Missing registered reconciler");
    }
    service.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Recovery remains globally serialized, but an outstanding backlog uses
    // the prompt cadence rather than sleeping a minute per item.
    await vi.advanceTimersByTimeAsync(40_000);
    service.stop();
    const payloads = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(new Set(payloads.map((payload) => payload.source.rootMessageId)).size).toBe(11);
    expect(payloads.some((payload) => payload.source.rootMessageId.endsWith(".000011"))).toBe(
      false,
    );
    expect(payloads.every((payload) => payload.discover === true && !payload.reconcile)).toBe(true);
    expect(payloads.every((payload) => payload.source.memberSenderIds.includes("U333"))).toBe(true);
    expect(discovery.list).toHaveBeenCalledWith({ agentId: "cellect-fi-user" });
    expect(discovery.list).toHaveBeenCalledWith({ agentId: "cellect-main" });
  });
  function driftFixture(
    budget: number | undefined,
    drifted: Set<string>,
    readFails = false,
    status = "existing",
    unread = new Set<string>(),
  ) {
    discovery.entry.mockReturnValue({});
    const detachedSource = {
      provider: "slack" as const,
      workspaceId: "T123",
      channelId: "C123",
      rootMessageId: "1700000000.000009",
    };
    const bindings = [
      ...[0, 1, 2].map((index) => ({
        sessionKey: `agent:cellect-fi-admin:slack:channel:c123:thread:1700000000.00000${index}`,
        roomId: `!room${index}`,
      })),
      {
        sessionKey: "agent:cellect-fi-admin:slack:channel:c123",
        roomId: "!roomD",
        sourceAccountId: "fi-admin",
        externalSource: detachedSource,
      },
    ];
    const plan = vi.fn(async (roomId: string) => ({
      converged: !drifted.has(roomId),
      invariantsOk: !drifted.has(roomId),
      ...(drifted.has(roomId) ? { hasHumanMember: !unread.has(roomId) } : {}),
    }));
    const readThread = vi.fn(async (_channelId: string, rootMessageId: string) => {
      if (readFails) {
        throw new Error("Slack rate limited");
      }
      return {
        workspaceId: "T123",
        channelId: "C123",
        rootMessageId,
        memberSenderIds: ["U111"],
        messages: [{ messageId: rootMessageId, senderId: "U111", content: "Hi", bot: false }],
      };
    });
    const readChannel = vi.fn(async () => ({
      workspaceId: "T123",
      channelId: "C123",
      memberSenderIds: ["U111"],
      readThread: (rootMessageId: string) => readThread("C123", rootMessageId),
      readHistoryPage: async () => ({ roots: [] }),
    }));
    const logger = { warn: vi.fn(), info: vi.fn() };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status }) });
    vi.stubGlobal("fetch", fetchMock);
    let service: { start: () => void; stop: () => void } | undefined;
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
      runtime: {
        channel: {
          runtimeContexts: {
            get: ({ channelId }: { channelId: string }) =>
              channelId === "matrix"
                ? { list: async () => bindings, plan }
                : { workspaceId: "T123", botUserId: "U222", readChannel, readThread },
          },
        },
      },
    } as unknown as OpenClawPluginApi;
    registerSlackProjectionReconciler(api, () => ({
      baseUrl: "https://fi.example",
      token: "test-token",
      fullRefreshesPerTick: budget,
    }));
    if (!service) {
      throw new Error("Missing registered reconciler");
    }
    const payloads = () => fetchMock.mock.calls.map((call) => JSON.parse(call[1].body));
    const refreshLines = () =>
      [...logger.info.mock.calls, ...logger.warn.mock.calls]
        .map(([line]) => String(line))
        .filter((line) => line.startsWith("fi-user: projection refresh"));
    return { service, plan, readThread, payloads, refreshLines, logger };
  }

  it("plans every bound room in one tick and refreshes drifted rooms within the budget", async () => {
    vi.useFakeTimers();
    const f = driftFixture(undefined, new Set(["!room1", "!roomD"]));
    f.service.start();
    await vi.advanceTimersByTimeAsync(5000);
    // Planning reads Matrix only, so all four rooms are planned in the first
    // tick, independent of the one-slot lane rotation.
    expect(f.plan.mock.calls.map(([roomId]) => roomId).toSorted()).toEqual([
      "!room0",
      "!room1",
      "!room2",
      "!roomD",
    ]);
    // One readers-only ACL item plus one full refresh (budget 1).
    expect(
      f.payloads().map((payload) => [payload.source.rootMessageId, Boolean(payload.snapshot)]),
    ).toEqual([
      ["1700000000.000000", false],
      ["1700000000.000001", true],
    ]);
    expect(f.readThread).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(75_000);
    f.service.stop();
    const refreshed = f.payloads().filter((payload) => payload.snapshot);
    expect(refreshed.map((payload) => payload.source.rootMessageId)).toEqual([
      "1700000000.000001",
      "1700000000.000009",
    ]);
    expect(refreshed.every((payload) => payload.reconcile === true && !payload.unavailable)).toBe(
      true,
    );
    expect(refreshed[1]).toMatchObject({ sourceDetached: true });
    expect(f.refreshLines()).toEqual([
      "fi-user: projection refresh lane=channel room=!room1 session=agent:cellect-fi-admin:slack:channel:c123:thread:1700000000.000001 outcome=refreshed",
      "fi-user: projection refresh lane=detached room=!roomD session=agent:cellect-fi-admin:slack:channel:c123 outcome=refreshed",
    ]);
  });

  it("stops refreshing a drifted room that Fi declines (a retired conversation)", async () => {
    vi.useFakeTimers();
    const f = driftFixture(1, new Set(["!room1"]), false, "skipped");
    f.service.start();
    await vi.advanceTimersByTimeAsync(5000 + 6 * 60 * 60_000);
    f.service.stop();
    expect(f.readThread).toHaveBeenCalledTimes(1);
    expect(f.refreshLines()).toEqual([
      "fi-user: projection refresh lane=channel room=!room1 session=agent:cellect-fi-admin:slack:channel:c123:thread:1700000000.000001 outcome=declined",
    ]);
  });

  it("never reads Slack for a drifted room that no human can read", async () => {
    vi.useFakeTimers();
    const f = driftFixture(
      1,
      new Set(["!room1", "!roomD"]),
      false,
      "existing",
      new Set(["!room1", "!roomD"]),
    );
    f.service.start();
    await vi.advanceTimersByTimeAsync(5000 + 60 * 60_000);
    f.service.stop();
    expect(f.plan).toHaveBeenCalled();
    expect(f.readThread).not.toHaveBeenCalled();
    expect(f.refreshLines()).toEqual([]);
  });

  it("neither plans nor refreshes with a zero budget", async () => {
    vi.useFakeTimers();
    const f = driftFixture(0, new Set(["!room1"]));
    f.service.start();
    await vi.advanceTimersByTimeAsync(5000 + 3 * 60_000);
    f.service.stop();
    expect(f.plan).not.toHaveBeenCalled();
    expect(f.readThread).not.toHaveBeenCalled();
    expect(f.payloads().every((payload) => !payload.snapshot)).toBe(true);
  });

  it("does not revoke readers or retry every tick when a refresh cannot read Slack", async () => {
    vi.useFakeTimers();
    const f = driftFixture(1, new Set(["!room1"]), true);
    f.service.start();
    await vi.advanceTimersByTimeAsync(5000 + 30 * 60_000);
    f.service.stop();
    expect(f.readThread).toHaveBeenCalledTimes(1);
    expect(f.payloads().some((payload) => payload.unavailable || payload.snapshot)).toBe(false);
    expect(f.refreshLines()).toEqual([
      "fi-user: projection refresh lane=channel room=!room1 session=agent:cellect-fi-admin:slack:channel:c123:thread:1700000000.000001 outcome=failed error=Slack rate limited",
    ]);
  });

  it.each([false, true])(
    "refreshes every room ACL with bounded history, source outage=%s",
    async (outage) => {
      vi.useFakeTimers();
      discovery.entry.mockReturnValue({});
      const bindings = Array.from({ length: 12 }, (_, index) => ({
        sessionKey: `agent:cellect-fi-admin:slack:channel:c123:thread:1700000000.${String(index).padStart(6, "0")}`,
        roomId: `!room${index}`,
      }));
      const readThread = vi.fn(async (rootMessageId: string) => ({
        workspaceId: "T123",
        channelId: "C123",
        rootMessageId,
        memberSenderIds: ["U111"],
        messages: [],
      }));
      const readChannel = vi.fn(async () => {
        if (outage) {
          throw new Error("source denied");
        }
        return { workspaceId: "T123", channelId: "C123", memberSenderIds: ["U111"], readThread };
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ status: "existing" }) });
      vi.stubGlobal("fetch", fetchMock);
      let service: { start: () => void; stop: () => void } | undefined;
      const api = {
        config: {
          bindings: [
            { agentId: "cellect-fi-admin", match: { channel: "slack", accountId: "fi-admin" } },
          ],
        },
        logger: { warn: vi.fn(), info: vi.fn() },
        registerGatewayMethod: vi.fn(),
        registerService: (value: typeof service) => {
          service = value;
        },
        runtime: {
          channel: {
            runtimeContexts: {
              get: ({ channelId }: { channelId: string }) =>
                channelId === "matrix"
                  ? { list: async () => bindings }
                  : { workspaceId: "T123", botUserId: "U222", readChannel },
            },
          },
        },
      } as unknown as OpenClawPluginApi;
      registerSlackProjectionReconciler(api, () => ({
        baseUrl: "https://fi.example",
        token: "test-token",
      }));
      if (!service) {
        throw new Error("Missing registered reconciler");
      }
      service.start();
      await vi.advanceTimersByTimeAsync(5000);
      expect(readChannel).toHaveBeenCalledTimes(1);
      expect(readThread).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(40_000);
      service.stop();
      const payloads = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body));
      expect(payloads).toHaveLength(12);
      expect(payloads.every((payload) => payload.reconcile === true)).toBe(true);
      if (outage) {
        expect(payloads.every((payload) => payload.unavailable === true && !payload.snapshot)).toBe(
          true,
        );
      } else {
        expect(payloads.every((payload) => !payload.snapshot)).toBe(true);
        expect(payloads.every((payload) => payload.source.memberSenderIds.includes("U111"))).toBe(
          true,
        );
      }
    },
  );

  it("immediately snapshots the active DM on inbound and agent replies, without waiting for the history sweep", async () => {
    vi.useFakeTimers();
    const sessionKeys = [
      "agent:cellect-main:slack:direct:u001",
      "agent:cellect-main:slack:direct:u002",
    ];
    const targetSession = sessionKeys[1];
    if (!targetSession) {
      throw new Error("Expected test session");
    }
    const directBinding = {
      sessionKey: targetSession,
      roomId: "!direct-room",
      sourceAccountId: "cellect-main",
      externalSource: { channelId: "D002", peerSenderId: "U002" },
    };
    discovery.list.mockImplementation(({ agentId }) =>
      agentId === "cellect-main"
        ? sessionKeys.map((sessionKey) => ({ sessionKey, entry: {} }))
        : [],
    );
    discovery.entry.mockImplementation(({ sessionKey }: { sessionKey: string }) => ({
      accountId: "cellect-main",
      nativeChannelId: sessionKey.endsWith("u002") ? "D002" : "D001",
    }));
    const readDirect = vi.fn(async (channelId: string, peerSenderId: string) => ({
      directSource: { workspaceId: "T123", channelId, peerSenderId },
      messages: [
        { messageId: "1710000000.000001", senderId: peerSenderId, content: "hello", bot: false },
        { messageId: "1710000000.000002", senderId: "U222", content: "hi", bot: true },
      ],
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ status: "existing" }) });
    vi.stubGlobal("fetch", fetchMock);
    let service: { start: () => void; stop: () => void } | undefined;
    const hooks = new Map<string, Array<(event: never, context: never) => void>>();
    const api = {
      config: {
        bindings: [
          { agentId: "cellect-main", match: { channel: "slack", accountId: "cellect-main" } },
        ],
      },
      logger: { warn: vi.fn(), info: vi.fn() },
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
                ? { list: async () => [directBinding] }
                : { botUserId: "U222", readDirect },
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
    const inbound = hooks.get("message_received")?.[0];
    const outbound = hooks.get("message_sent")?.[0];
    if (!inbound || !outbound) {
      throw new Error("Missing DM projection hooks");
    }
    service.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).not.toHaveBeenCalled();

    inbound(
      { sessionKey: targetSession } as never,
      { channelId: "slack", accountId: "cellect-main", sessionKey: targetSession } as never,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readDirect).toHaveBeenLastCalledWith("D002", "U002");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      agentId: "cellect-main",
      sessionKey: targetSession,
      directSource: { workspaceId: "T123", channelId: "D002", peerSenderId: "U002" },
      snapshot: {
        complete: true,
        messages: [
          { messageId: "1710000000.000001", role: "user" },
          { messageId: "1710000000.000002", role: "assistant", agentId: "cellect-main" },
        ],
      },
    });

    outbound(
      { success: true, sessionKey: targetSession } as never,
      { channelId: "slack", accountId: "cellect-main", sessionKey: targetSession } as never,
    );
    await vi.advanceTimersByTimeAsync(1000);
    service.stop();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readDirect).toHaveBeenCalledTimes(2);
  });
});
