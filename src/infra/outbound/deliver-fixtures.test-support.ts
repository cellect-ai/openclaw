import { expect, vi } from "vitest";
import type { ChannelOutboundAdapter, ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

/** The carried ack pins its completion receipt and the captured publication message id. */
export function expectAckReceipt(
  ackDelivery: (...args: never[]) => unknown,
  stateDir: string,
  platformMessageId: string,
  queueId = "mock-queue-id",
): void {
  expect(ackDelivery).toHaveBeenCalledWith(
    queueId,
    stateDir,
    expect.objectContaining({
      completionReceipt: { platformMessageId },
      publicationEvidence: expect.objectContaining({ platformMessageId }),
    }),
  );
}

export function requireMockCallArg<TArgs extends unknown[]>(
  mockFn: { mock: { calls: TArgs[] } },
  label: string,
  index = 0,
): TArgs[0] {
  const call = mockFn.mock.calls[index];
  if (!call || call.length === 0) {
    throw new Error(`expected ${label} call #${index + 1}`);
  }
  return call[0];
}

export function requireMockCall<T extends unknown[] = unknown[]>(
  mockFn: { mock: { calls: T[] } },
  label: string,
  index = 0,
): T {
  const call = mockFn.mock.calls[index];
  if (!call) {
    throw new Error(`expected ${label} call #${index + 1}`);
  }
  return call;
}

export function requireMatrixSendCall(sendMatrix: ReturnType<typeof vi.fn>, index = 0): unknown[] {
  return requireMockCall(sendMatrix as { mock: { calls: unknown[][] } }, "matrix send", index);
}

export function createNetworkError(message: string, code: string, syscall?: string) {
  return Object.assign(new Error(message), { code, ...(syscall ? { syscall } : {}) });
}

export function setTestPlugin(
  plugin: Pick<ChannelPlugin, "id"> & Partial<ChannelPlugin>,
  pluginId = plugin.id,
) {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId,
        source: "test",
        plugin: { ...createChannelTestPluginBase({ id: plugin.id }), ...plugin },
      },
    ]),
  );
}

export function createTestOutbound(
  overrides: Partial<ChannelOutboundAdapter> = {},
  id: Parameters<typeof createOutboundTestPlugin>[0]["id"] = "matrix",
): ChannelOutboundAdapter {
  return {
    deliveryMode: "direct",
    sendText: async () => ({ channel: id, messageId: "unused" }),
    ...overrides,
  };
}

export function setTestOutbound(
  overrides: Partial<ChannelOutboundAdapter>,
  id: Parameters<typeof createOutboundTestPlugin>[0]["id"] = "matrix",
) {
  setTestPlugin(createOutboundTestPlugin({ id, outbound: createTestOutbound(overrides, id) }));
}
