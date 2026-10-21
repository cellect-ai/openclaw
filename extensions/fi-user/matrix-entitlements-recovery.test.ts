import type {
  OpenClawPluginApi,
  PluginAgentEventSubscriptionRegistration,
  PluginRuntimeLifecycleRegistration,
} from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginHookAgentContext } from "../../src/plugins/hook-agent-context.types.js";
import { registerMatrixEntitlements } from "./matrix-entitlements.js";

function fixture() {
  let admission!: (event: never, context: PluginHookAgentContext) => unknown;
  let subscription!: PluginAgentEventSubscriptionRegistration;
  let lifecycle!: PluginRuntimeLifecycleRegistration;
  const owner = registerMatrixEntitlements(
    createTestPluginApi({
      id: "fi-user",
      config: {
        plugins: {
          entries: {
            "fi-user": {
              config: {
                baseUrl: "https://fi.example/fi",
                brokerTokenEnv: "FIXTURE_AUTH_BROKER",
                tenantOrgId: "tenant-a",
              },
            },
          },
        },
      },
      runtime: {
        channel: { runtimeContexts: { register: vi.fn() } },
      } as unknown as OpenClawPluginApi["runtime"],
      on(name, handler) {
        if (name === "before_agent_reply") admission = handler as typeof admission;
      },
      registerAgentEventSubscription: (entry) => {
        subscription = entry;
      },
      registerRuntimeLifecycle: (entry) => {
        lifecycle = entry;
      },
    }),
  );
  const context: PluginHookAgentContext = {
    runId: "run-a",
    agentId: "cellect-fi-user",
    accountId: "fiprod",
    channel: "matrix",
    trigger: "user",
    senderId: "@requester:matrix.example",
    chatId: "!room:matrix.example:thread:$root",
    sessionKey: "agent:cellect-fi-user:matrix:channel:!room:matrix.example:thread:$root",
    inputProvenance: { kind: "external_user" },
    channelContext: {
      sender: { id: "@requester:matrix.example" },
      chat: { id: "!room:matrix.example", eventId: "$human-event" },
    },
  };
  const tool = (overrides = {}) =>
    owner.beforeToolCall({
      runId: context.runId,
      agentId: context.agentId,
      sessionKey: context.sessionKey,
      toolName: "exec",
      requester: { channel: "matrix", senderId: context.senderId, accountId: context.accountId },
      ...overrides,
    });
  return {
    context,
    admit: (ctx = context) => admission({} as never, ctx),
    tool,
    dispose: () => lifecycle.dispose?.(),
    settle: () =>
      subscription.handle(
        {
          runId: "run-a",
          seq: 1,
          stream: "lifecycle",
          ts: 0,
          data: { phase: "end", executionSettled: true },
        },
        {} as never,
      ),
  };
}

const allow = () =>
  new Response(
    JSON.stringify({
      ok: true,
      agentId: "cellect-fi-user",
      orgId: "tenant-a",
    }),
  );

describe("Matrix authorization recovery at registered admission", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("FIXTURE_AUTH_BROKER", "synthetic-broker");
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ fiprod: "prod" }));
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(["503", "transport"])(
    "rechecks the identical genuine event once after %s",
    async (kind) => {
      const f = fixture();
      if (kind === "503") fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
      else
        fetchMock.mockRejectedValueOnce(
          new TypeError("fetch failed", {
            cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
          }),
        );
      fetchMock.mockResolvedValueOnce(allow());
      const pending = f.admit();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await pending).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1]).toEqual(fetchMock.mock.calls[0]);
      expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
        roomId: "!room:matrix.example",
        agentId: "cellect-fi-user",
        eventId: "$human-event",
      });
    },
  );

  it.each([401, 403, 429])("never retries HTTP %s into admission", async (status) => {
    const f = fixture();
    fetchMock.mockResolvedValueOnce(new Response(null, { status })).mockResolvedValueOnce(allow());
    expect(await f.admit()).toMatchObject({
      handled: true,
      reply: {
        text:
          status === 403
            ? expect.stringContaining("don’t currently have access")
            : expect.stringContaining("verification is temporarily unavailable"),
      },
    });
    expect(f.tool()).toMatchObject({ block: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("bounds persistent unavailability and reports verification, not denied access", async () => {
    const f = fixture();
    fetchMock.mockImplementation(async () => new Response(null, { status: 503 }));
    const pending = f.admit();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({
      handled: true,
      reply: {
        text: expect.stringContaining("verification is temporarily unavailable"),
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(f.tool()).toMatchObject({ block: true });
  });

  it("keeps one original 12-second signal across both attempts", async () => {
    const f = fixture();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const pending = f.admit();
    await vi.advanceTimersByTimeAsync(3_000);
    const signal = fetchMock.mock.calls[1]?.[1]?.signal;
    expect(signal).toBe(fetchMock.mock.calls[0]?.[1]?.signal);
    await vi.advanceTimersByTimeAsync(8_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(await pending).toMatchObject({ handled: true });
    expect(f.tool()).toMatchObject({ block: true });
  });

  it.each(["settle", "dispose"] as const)(
    "cancels a queued retry when %s retires its turn",
    async (retire) => {
      const f = fixture();
      fetchMock
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockResolvedValueOnce(allow());
      const pending = f.admit();
      await vi.advanceTimersByTimeAsync(0);
      await f[retire]();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await pending).toMatchObject({ handled: true });
      expect(f.tool()).toMatchObject({ block: true });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("honors tool cancellation during backoff without admitting another requester", async () => {
    const f = fixture();
    fetchMock.mockResolvedValueOnce(allow());
    expect(await f.admit()).toBeUndefined();
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(allow());
    const controller = new AbortController();
    const pending = f.tool({ abortSignal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toMatchObject({ block: true });
    expect(
      f.tool({
        requester: {
          channel: "matrix",
          senderId: "@other:matrix.example",
          accountId: "fiprod",
        },
      }),
    ).toMatchObject({ block: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not transfer a pending authorization to a replacement user's event", async () => {
    const f = fixture();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const pending = f.admit();
    await vi.advanceTimersByTimeAsync(0);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect(
      await f.admit({
        ...f.context,
        senderId: "@other:matrix.example",
        channelContext: {
          sender: { id: "@other:matrix.example" },
          chat: { id: "!room:matrix.example", eventId: "$other-event" },
        },
      }),
    ).toMatchObject({
      handled: true,
      reply: { text: expect.stringContaining("don’t currently have access") },
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toMatchObject({ handled: true });
    expect(f.tool()).toMatchObject({ block: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).eventId).toBe("$other-event");
  });

  it("silently consumes the heartbeat producer's orphan exec wake, never granting tools", async () => {
    const f = fixture();
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    // heartbeat-runner-run creates internal_system/exec with only routing and
    // thread metadata: no Matrix ChannelContext, SenderId, or message event ID.
    const producerWake = {
      ...f.context,
      runId: "completion-wake",
      trigger: "heartbeat",
      inputProvenance: { kind: "internal_system" as const, sourceTool: "exec" },
      senderId: undefined,
      channelContext: undefined,
    };
    try {
      fetchMock.mockResolvedValueOnce(allow());
      expect(await f.admit()).toBeUndefined();
      await f.settle();
      fetchMock.mockClear();
      expect(await f.admit(producerWake)).toEqual({ handled: true });
      expect(f.tool({ runId: "completion-wake" })).toMatchObject({ block: true });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('"reason":"orphan_exec_completion"'),
      );
      // Even copied historical human fields are not retained host authority.
      expect(
        await f.admit({
          ...f.context,
          runId: "another-completion-wake",
          inputProvenance: producerWake.inputProvenance,
        }),
      ).toEqual({ handled: true });
      expect(fetchMock).not.toHaveBeenCalled();
      // No blanket exemption for other internal runs, nor carry from room history.
      expect(
        await f.admit({
          ...producerWake,
          inputProvenance: {
            kind: "internal_system",
            sourceTool: "cron",
          },
        }),
      ).toMatchObject({
        handled: true,
        reply: { text: expect.stringContaining("verification is temporarily unavailable") },
      });
    } finally {
      log.mockRestore();
    }
  });
});
