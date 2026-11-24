import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { getSlackTestState, resetSlackTestState } from "../monitor.test-helpers.js";

const ingressStartMock = vi.hoisted(() => vi.fn());
const ingressStopMock = vi.hoisted(() => vi.fn());
const contexts = vi.hoisted(() => [] as Array<{ readRuntimeContext: () => Promise<unknown> }>);

vi.mock("./context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./context.js")>();
  return {
    ...actual,
    createSlackMonitorContext: (...args: Parameters<typeof actual.createSlackMonitorContext>) => {
      const ctx = actual.createSlackMonitorContext(...args);
      contexts.push(ctx);
      return ctx;
    },
  };
});

vi.mock("./ingress.js", () => ({
  createSlackDurableIngress: () => ({
    wrapReceiver: (receiver: unknown) => receiver,
    acceptRelayEvent: vi.fn(),
    attachRelayDispatch: vi.fn(),
    start: ingressStartMock,
    stop: ingressStopMock,
    waitForIdle: vi.fn(),
  }),
}));

const { monitorSlackProvider } = await import("./provider.js");

beforeEach(async () => {
  await resetSlackTestState();
  ingressStartMock.mockReset();
  contexts.length = 0;
  ingressStopMock.mockReset().mockResolvedValue(undefined);
});

afterAll(() => {
  vi.doUnmock("./ingress.js");
  vi.doUnmock("./context.js");
  vi.resetModules();
});

it("stops ingress and the Bolt transport when ingress start throws", async () => {
  const startError = new Error("durable ingress unavailable");
  ingressStartMock.mockImplementation(() => {
    throw startError;
  });
  await expect(
    monitorSlackProvider({
      scheduler: createTestPluginServiceScheduler(),
      botToken: "bot-token",
      appToken: "app-token",
      config: getSlackTestState().config,
    }),
  ).rejects.toBe(startError);
  expect(ingressStopMock).toHaveBeenCalledTimes(1);
  expect(getSlackTestState().appStartMock).not.toHaveBeenCalled();
  expect(getSlackTestState().appStopMock).toHaveBeenCalledTimes(1);
  expect(contexts).toHaveLength(1);
  await expect(contexts[0]!.readRuntimeContext()).rejects.toThrow("monitor is no longer current");
});
