// Runtime channel tests cover channel plugin runtime send, reply, and capability behavior.
import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createPluginRuntimeStore } from "../../plugin-sdk/runtime-store.js";
import { PluginInstance } from "../plugin-instance.js";
import { createRuntimeChannel } from "./runtime-channel.js";

const dispatchRoutedChannelTurn = vi.hoisted(() => vi.fn(async () => ({ status: "handled" })));

vi.mock("../../channels/turn/lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/turn/lifecycle.js")>()),
  dispatchRoutedChannelTurn,
}));

function requireWatcherEvent(mock: ReturnType<typeof vi.fn>, index: number) {
  const event = mock.mock.calls[index]?.[0] as { type?: string } | undefined;
  if (!event) {
    throw new Error(`Expected watcher event ${index}`);
  }
  return event;
}

describe("inbound dispatch", () => {
  it("keeps the complete deprecated turn object identical to inbound", () => {
    const channel = createRuntimeChannel();
    expect(channel.turn).toBe(channel.inbound);
    expect(channel.turn.dispatch).toBe(channel.inbound.dispatch);
  });
  it.each([
    { surface: "inbound", bound: true },
    { surface: "turn", bound: true },
    { surface: "inbound", bound: false },
    { surface: "turn", bound: false },
  ] as const)(
    "$surface preserves dispatch precedence (bound=$bound)",
    async ({ surface, bound }) => {
      const boundReplyDispatch = bound ? vi.fn() : undefined;
      const callerDispatch = vi.fn();
      const channel = createRuntimeChannel({ dispatchReplyFromConfig: boundReplyDispatch });
      const turn = {
        cfg: {},
        channel: "qa-channel",
        route: { agentId: "main", sessionKey: "agent:main:qa-channel:direct:test" },
        ctxPayload: { Body: "test", CommandAuthorized: false },
        delivery: { deliver: async () => undefined },
        dispatchReplyFromConfig: callerDispatch,
      } satisfies Parameters<typeof channel.inbound.dispatch>[0];

      await channel[surface].dispatch(turn);

      expect(dispatchRoutedChannelTurn).toHaveBeenCalledWith({
        ...turn,
        dispatchReplyFromConfig: boundReplyDispatch ?? callerDispatch,
      });
    },
  );
});

describe("runtimeContexts", () => {
  it("retains owner scopes for context methods and watcher callbacks across plugins", async () => {
    const channel = createRuntimeChannel();
    const owner = new PluginInstance("runtime-context-owner-test");
    const watcher = new PluginInstance("runtime-context-watcher-test");
    const ownerRuntime = createPluginRuntimeStore<{ name: string }>({
      pluginId: "runtime-context-owner-test",
      errorMessage: "owner runtime not initialized",
    });
    const watcherRuntime = createPluginRuntimeStore<{ name: string }>({
      pluginId: "runtime-context-watcher-test",
      errorMessage: "watcher runtime not initialized",
    });
    const observed: string[] = [];
    const key = {
      channelId: "matrix",
      capability: "session-read-projections",
    };

    try {
      owner.wrap(() => ownerRuntime.setRuntime({ name: "matrix" }))();
      watcher.wrap(() => watcherRuntime.setRuntime({ name: "fi-user" }))();
      watcher.wrap(() =>
        channel.runtimeContexts.watch({
          ...key,
          onEvent: () => observed.push(watcherRuntime.getRuntime().name),
        }),
      )();

      owner.wrap(() =>
        channel.runtimeContexts.register({
          ...key,
          context: {
            ownerName: () => ownerRuntime.getRuntime().name,
          },
        }),
      )();

      const context = channel.runtimeContexts.get<{ ownerName: () => string }>(key);
      expect(watcher.wrap(() => context?.ownerName())()).toBe("matrix");
      expect(observed).toEqual(["fi-user"]);
    } finally {
      await Promise.all([owner.dispose(), watcher.dispose()]);
    }
  });

  it("registers, resolves, watches, and unregisters contexts", () => {
    const channel = createRuntimeChannel();
    const onEvent = vi.fn();
    const unsubscribe = channel.runtimeContexts.watch({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      onEvent,
    });

    const lease = channel.runtimeContexts.register({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      context: { client: "ok" },
    });

    expect(
      channel.runtimeContexts.get<{ client: string }>({
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toEqual({ client: "ok" });
    expect(onEvent).toHaveBeenCalledWith({
      type: "registered",
      key: {
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      },
      context: { client: "ok" },
    });

    lease.dispose();

    expect(
      channel.runtimeContexts.get({
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toBeUndefined();
    expect(onEvent).toHaveBeenLastCalledWith({
      type: "unregistered",
      key: {
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      },
    });

    unsubscribe();
  });

  it("auto-disposes registrations when the abort signal fires", () => {
    const channel = createRuntimeChannel();
    const controller = new AbortController();
    const lease = channel.runtimeContexts.register({
      channelId: "telegram",
      accountId: "default",
      capability: "approval.native",
      context: { token: "abc" },
      abortSignal: controller.signal,
    });

    controller.abort();

    expect(
      channel.runtimeContexts.get({
        channelId: "telegram",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toBeUndefined();
    lease.dispose();
  });

  it("removes its abort listener when the lease is disposed", () => {
    const channel = createRuntimeChannel();
    const controller = new AbortController();
    const initialListenerCount = getEventListeners(controller.signal, "abort").length;
    const lease = channel.runtimeContexts.register({
      channelId: "telegram",
      accountId: "default",
      capability: "approval.native",
      context: { token: "abc" },
      abortSignal: controller.signal,
    });

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(initialListenerCount + 1);

    lease.dispose();

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(initialListenerCount);
  });

  it("removes the stale lease abort listener after a replacement registration", () => {
    const channel = createRuntimeChannel();
    const controller = new AbortController();
    const initialListenerCount = getEventListeners(controller.signal, "abort").length;
    const staleLease = channel.runtimeContexts.register({
      channelId: "whatsapp",
      accountId: "default",
      capability: "connection.controller",
      context: { token: "stale" },
      abortSignal: controller.signal,
    });
    channel.runtimeContexts.register({
      channelId: "whatsapp",
      accountId: "default",
      capability: "connection.controller",
      context: { token: "replacement" },
      abortSignal: controller.signal,
    });

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(initialListenerCount + 2);

    // Channel plugins dispose the previous lease after registering its replacement,
    // so the stale token check must not skip listener cleanup.
    staleLease.dispose();

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(initialListenerCount + 1);
    expect(
      channel.runtimeContexts.get({
        channelId: "whatsapp",
        accountId: "default",
        capability: "connection.controller",
      }),
    ).toEqual({ token: "replacement" });
  });

  it("does not register contexts when the abort signal is already aborted", () => {
    const channel = createRuntimeChannel();
    const onEvent = vi.fn();
    const controller = new AbortController();
    controller.abort();
    channel.runtimeContexts.watch({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      onEvent,
    });

    const lease = channel.runtimeContexts.register({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      context: { client: "stale" },
      abortSignal: controller.signal,
    });

    expect(
      channel.runtimeContexts.get({
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toBeUndefined();
    expect(onEvent).not.toHaveBeenCalled();
    lease.dispose();
  });

  it("isolates watcher exceptions so registration and disposal still complete", () => {
    const channel = createRuntimeChannel();
    const badWatcher = vi.fn((event) => {
      throw new Error(`boom:${event.type}`);
    });
    const goodWatcher = vi.fn();

    channel.runtimeContexts.watch({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      onEvent: badWatcher,
    });
    channel.runtimeContexts.watch({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      onEvent: goodWatcher,
    });

    const lease = channel.runtimeContexts.register({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      context: { client: "ok" },
    });

    expect(
      channel.runtimeContexts.get({
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toEqual({ client: "ok" });
    expect(requireWatcherEvent(badWatcher, 0).type).toBe("registered");
    expect(requireWatcherEvent(goodWatcher, 0).type).toBe("registered");

    lease.dispose();

    expect(
      channel.runtimeContexts.get({
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toBeUndefined();
    expect(requireWatcherEvent(badWatcher, 1).type).toBe("unregistered");
    expect(requireWatcherEvent(goodWatcher, 1).type).toBe("unregistered");
  });

  it("auto-disposes when a watcher aborts during the registered event", () => {
    const channel = createRuntimeChannel();
    const controller = new AbortController();
    const onEvent = vi.fn((event) => {
      if (event.type === "registered") {
        controller.abort();
      }
    });

    channel.runtimeContexts.watch({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      onEvent,
    });

    const lease = channel.runtimeContexts.register({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      context: { client: "ok" },
      abortSignal: controller.signal,
    });

    expect(
      channel.runtimeContexts.get({
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toBeUndefined();
    expect(requireWatcherEvent(onEvent, 0).type).toBe("registered");
    expect(requireWatcherEvent(onEvent, 1).type).toBe("unregistered");

    lease.dispose();
  });
});
