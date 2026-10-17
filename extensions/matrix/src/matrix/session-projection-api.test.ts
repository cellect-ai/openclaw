import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { expect, it, vi } from "vitest";
import { registerMatrixSessionProjection } from "../../session-projection-api.js";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  receipts: vi.fn(() => vi.fn()),
  start: vi.fn(() => ({ stop: vi.fn() })),
  reply: vi.fn(async () => {}),
}));
vi.mock("./projection-source-result.js", () => ({
  prepareMatrixSourceResult: mocks.prepare,
  startMatrixSourceResultReceipts: mocks.receipts,
}));
vi.mock("./projection-lifecycle.js", () => ({
  startMatrixProjectionLifecycle: mocks.start,
}));
vi.mock("./session-projection.js", () => ({
  handleMatrixSessionProjectionReplyPayloadSending: mocks.reply,
}));

it("installs the synchronous source hold entry point before starting the native lifecycle", async () => {
  const on = vi.fn();
  const registerService = vi.fn();
  registerMatrixSessionProjection(createTestPluginApi({ on, registerService }));
  const service = registerService.mock.calls[0]?.[0];
  const hook = on.mock.calls.find(([name]) => name === "reply_payload_sending")?.[1];
  expect(service).toBeDefined();
  expect(hook).toBeTypeOf("function");
  const event = { kind: "final", payload: { text: "answer" } };
  const context = { channelId: "slack" };
  const pendingPreparation = Promise.withResolvers<void>();
  mocks.prepare.mockReturnValue(pendingPreparation.promise);
  let pendingReply: Promise<void> | undefined;
  mocks.start.mockImplementationOnce(() => {
    pendingReply = hook(event, context);
    // No module-load await may precede the source function's prefix/custody hold.
    expect(mocks.prepare).toHaveBeenCalledWith(event);
    return { stop: vi.fn() };
  });
  try {
    await service.start();
    expect(mocks.receipts).toHaveBeenCalledOnce();
    expect(mocks.reply).not.toHaveBeenCalled();
    pendingPreparation.resolve();
    await pendingReply;
    expect(mocks.reply).toHaveBeenCalledWith(event, context, {});
  } finally {
    pendingPreparation.resolve();
    await pendingReply;
    service.stop();
  }
});
