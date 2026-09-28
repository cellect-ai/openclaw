import { describe, expect, it, vi } from "vitest";
import { createPluginRuntimeStore } from "../plugin-sdk/runtime-store.js";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createToolHookRegistrars } from "./registry-registrars-tools-hooks.js";
import type { PluginRegistryState } from "./registry-state.js";
import { createPluginRecord } from "./status.test-helpers.js";

describe("typed hook plugin-instance ownership", () => {
  it("restores the registering instance for a deferred lifecycle hook", async () => {
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id: "runtime-hook", origin: "bundled" });
    registry.plugins.push(record);
    const instance = new PluginInstance(record.id, { record, registry });
    const runtime = createPluginRuntimeStore<string>({
      pluginId: record.id,
      errorMessage: "runtime hook store unavailable",
    });
    const observed = vi.fn();
    const registrars = createToolHookRegistrars({
      registry,
      createRegistration: (_record: typeof record, contribution: object) => contribution,
      registryParams: {} as PluginRegistryState["registryParams"],
      pluginsWithChannelRegistrationConflict: new Set<string>(),
      reportRegistrationError: vi.fn(),
      reportRegistrationWarning: vi.fn(),
    } as PluginRegistryState);

    try {
      instance.run(() => {
        runtime.setRuntime("owned runtime");
        registrars.registerTypedHook(record, "subagent_ended", async () => {
          observed(runtime.getRuntime());
        });
      });

      const hook = registry.typedHooks[0];
      expect(hook).toBeDefined();
      await hook!.handler(
        { targetSessionKey: "agent:fixture:child", targetKind: "subagent" },
        { childSessionKey: "agent:fixture:child" },
      );
      expect(observed).toHaveBeenCalledExactlyOnceWith("owned runtime");
    } finally {
      await instance.dispose();
    }
  });
});
