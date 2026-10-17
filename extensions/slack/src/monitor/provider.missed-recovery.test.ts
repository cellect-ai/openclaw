import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  disposeSlackTestRuntime,
  getSlackClient,
  getSlackHandlers,
  getSlackTestState,
  resetSlackTestState,
  runSlackHandlerWithDispatch,
  startSlackMonitor,
} from "../monitor.test-helpers.js";
import { getSlackRuntime, setSlackRuntime } from "../runtime.js";
import { SLACK_LIVENESS_HEARTBEAT_MS } from "./missed-mentions.js";

const { monitorSlackProvider } = await import("./provider.js");
const monitors: ReturnType<typeof startSlackMonitor>[] = [];
const now = 1_800_000_000_000;

beforeEach(async () => {
  await resetSlackTestState({
    channels: { slack: { groupPolicy: "open", requireMention: true } },
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.spyOn(Date, "now").mockReturnValue(now);
});

afterEach(async () => {
  for (const monitor of monitors) {
    monitor.controller.abort();
  }
  await Promise.all(monitors.splice(0).map((monitor) => monitor.run));
  // Finish the recovery sweep's bounded API-spacing delay after dispatch.
  await vi.advanceTimersByTimeAsync(1_200);
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(getSlackClient().conversations, "list");
  await resetSlackTestState();
});
afterAll(disposeSlackTestRuntime);

function liveness(previous: number | undefined) {
  const runtime = getSlackRuntime();
  const register = vi.fn(async () => undefined);
  const lookup = vi.fn(async () => previous);
  setSlackRuntime({
    ...runtime,
    state: {
      ...runtime.state,
      openKeyedStore: (options: { namespace: string }) =>
        options.namespace === "socket-liveness"
          ? { register, lookup }
          : runtime.state.openKeyedStore(options as never),
    },
  } as never);
  return { register, lookup };
}

function startConnected() {
  const connected = createDeferred();
  const monitor = startSlackMonitor(monitorSlackProvider, {
    setStatus: (status) => {
      if (status.connected === true) {
        connected.resolve();
      }
    },
  });
  monitors.push(monitor);
  return { monitor, connected: connected.promise };
}

it.each(["top-level", "old-thread"])(
  "recovers a %s mention from a five-second outage through the normal handler without replaying a duplicate live event",
  async (kind) => {
    const store = liveness(now - 5_000);
    const client = getSlackClient();
    const list = vi.fn(async ({ types }: { types: string }) => ({
      channels: types === "im" ? [] : [{ id: "C1", name: "general", is_member: true }],
    }));
    Object.assign(client.conversations, { list });
    client.conversations.info.mockResolvedValue({
      channel: { id: "C1", name: "general", is_channel: true },
    });
    const parentTs = "1799999940.000000";
    const source = {
      ...(kind === "old-thread" ? { thread_ts: parentTs } : {}),
      user: "U_OTHER",
      text: "<@bot-user> recovered request",
      ts: "1799999998.000000",
    };
    client.conversations.history.mockResolvedValue({
      messages:
        kind === "old-thread"
          ? [
              {
                user: "U_OTHER",
                text: "Existing discussion",
                ts: parentTs,
                latest_reply: source.ts,
              },
            ]
          : [source],
    });
    client.conversations.replies.mockResolvedValue({ messages: [source] });
    const state = getSlackTestState();
    state.replyMock.mockResolvedValue({ text: "Recovered reply" });
    const delivered = createDeferred();
    const send = state.sendMock.getMockImplementation()!;
    state.sendMock.mockImplementation(async (...args) => {
      const result = await send(...args);
      delivered.resolve();
      return result;
    });
    const { connected } = startConnected();
    await connected;
    await vi.advanceTimersByTimeAsync(1_200);
    // History must include older parents; reply reads and input admission retain the window.
    expect(client.conversations.history).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C1",
      }),
    );
    expect(client.conversations.history.mock.calls[0]?.[0]).not.toHaveProperty("oldest");
    if (kind === "old-thread") {
      expect(client.conversations.replies).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "C1", ts: parentTs, oldest: "1799999995.000000" }),
      );
    }
    await delivered.promise;
    expect(store.lookup).toHaveBeenCalledWith("T_TEST:default");
    expect(store.lookup.mock.invocationCallOrder[0]).toBeLessThan(
      store.register.mock.invocationCallOrder[0]!,
    );
    expect(state.replyMock).toHaveBeenCalledOnce();
    const handler = getSlackHandlers()?.get("message");
    if (!handler) {
      throw new Error("Slack message handler was not registered");
    }
    await runSlackHandlerWithDispatch(handler, {
      event: {
        ...source,
        type: "message",
        channel: "C1",
        channel_type: "channel",
        event_ts: source.ts,
        team: "T_TEST",
      },
      body: { team_id: "T_TEST", api_app_id: "A_TEST", event_id: "Ev-recovered-live" },
      context: {
        teamId: "T_TEST",
        botUserId: "bot-user",
        botId: "bot-id",
        isEnterpriseInstall: false,
      },
    });
    expect(state.replyMock).toHaveBeenCalledOnce();
    expect(state.sendMock).toHaveBeenCalledOnce();
  },
);

it("marks connected heartbeats but never advances the recovery watermark after socket disconnect", async () => {
  const store = liveness(undefined);
  const intervals = vi.spyOn(globalThis, "setInterval");
  const { connected } = startConnected();
  await connected;
  const heartbeat = intervals.mock.calls.find(
    ([, delay]) => delay === SLACK_LIVENESS_HEARTBEAT_MS,
  )?.[0];
  if (typeof heartbeat !== "function") {
    throw new Error("Slack liveness heartbeat was not registered");
  }
  expect(store.register).toHaveBeenCalledOnce();
  vi.mocked(Date.now).mockReturnValue(now + 60_000);
  heartbeat();
  expect(store.register).toHaveBeenCalledTimes(2);
  const receiver = getSlackTestState().appConstructorArgs?.receiver as {
    client: { emit: (event: string) => void };
  };
  receiver.client.emit("disconnected");
  // A real interval runs after the disconnect promise microtask.
  await Promise.resolve();
  vi.mocked(Date.now).mockReturnValue(now + 120_000);
  heartbeat();
  expect(store.register).toHaveBeenCalledTimes(2);
});
