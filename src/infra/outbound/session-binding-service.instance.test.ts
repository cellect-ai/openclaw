import { afterEach, describe, expect, it } from "vitest";
import { createPluginRuntimeStore } from "../../plugin-sdk/runtime-store.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import {
  getSessionBindingService,
  registerSessionBindingAdapter,
  testing,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
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
    const adapter: SessionBindingAdapter = {
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
        registerSessionBindingAdapter(adapter);
      });

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
