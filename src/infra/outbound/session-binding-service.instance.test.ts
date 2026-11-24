import { afterEach, describe, expect, it } from "vitest";
import { createPluginRuntimeStore } from "../../plugin-sdk/runtime-store.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import {
  getSessionBindingService,
  registerSessionBindingAdapterV2,
  isSessionBindingAdapterCurrent,
  testing,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapterV2,
} from "./session-binding-service.js";

describe("session binding adapter plugin-instance ownership", () => {
  afterEach(() => testing.resetSessionBindingAdaptersForTests());

  it("restores the registering instance for deferred host unbind", async () => {
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id: "runtime-binding", origin: "bundled" });
    registry.plugins.push(record);
    const instance = new PluginInstance(record.id, { record, registry });
    const runtime = createPluginRuntimeStore<string>({
      pluginId: record.id,
      errorMessage: "binding runtime unavailable",
    });
    const adapter: SessionBindingAdapterV2 = {
      version: 2,
      assertCurrent: () => {
        if (!isSessionBindingAdapterCurrent(adapter)) throw new Error("binding adapter replaced");
      },
      listBySessionAsync: async () => [],
      resolveByConversationAsync: async () => null,
      inspectByConversationAsync: async () => null,
      inspectByConversationsAsync: async (refs) => ({
        bindings: refs.map(() => null),
        assertCurrent: () => adapter.assertCurrent(),
      }),
      touchAsync: async () => {},
      channel: "runtime-binding",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: () => null,
      unbind: async () => {
        expect(runtime.getRuntime()).toBe("owned runtime");
        return [];
      },
    };

    try {
      instance.run(() => {
        runtime.setRuntime("owned runtime");
        registerSessionBindingAdapterV2(adapter);
      });

      expect(isSessionBindingAdapterCurrent(adapter)).toBe(true);
      const replacement = { ...adapter };
      registerSessionBindingAdapterV2(replacement);
      expect(isSessionBindingAdapterCurrent(adapter)).toBe(false);
      expect(() => adapter.assertCurrent()).toThrow("binding adapter replaced");
      unregisterSessionBindingAdapter({ ...adapter, adapter: replacement });
      expect(isSessionBindingAdapterCurrent(adapter)).toBe(true);
      await expect(
        getSessionBindingService().unbind({
          targetSessionKey: "agent:fixture:child",
          reason: "session-delete",
          scope: { channel: adapter.channel, accountId: adapter.accountId },
        }),
      ).resolves.toStrictEqual([]);
    } finally {
      unregisterSessionBindingAdapter({
        channel: adapter.channel,
        accountId: adapter.accountId,
        adapter,
      });
      await instance.dispose();
    }
  });
});
