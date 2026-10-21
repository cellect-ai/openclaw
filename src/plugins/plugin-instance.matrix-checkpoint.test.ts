import { afterEach, expect, it, vi } from "vitest";
import { createMatrixThreadBindingManager } from "../../extensions/matrix/api.js";
import { setMatrixRuntime } from "../../extensions/matrix/runtime-setter-api.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getSessionBindingService, testing } from "../infra/outbound/session-binding-service.js";
import { createPluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { PluginInstance } from "./plugin-instance.js";
import type { PluginRuntime } from "./runtime/types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  vi.useRealTimers();
  testing.resetSessionBindingAdaptersForTests();
  await closeOpenClawStateDatabaseAsync();
});

it("flushes a pending Matrix binding touch before native instance retirement publishes clean state", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const stateDir = tempDirs.make("matrix-native-retirement-");
  const instance = new PluginInstance("matrix");
  const accountId = "fiuserprod";
  const runtime = {
    state: {
      resolveStateDir: () => stateDir,
      openKeyedStore: (options: Parameters<PluginRuntime["state"]["openKeyedStore"]>[0]) =>
        createPluginStateKeyedStore("matrix", options),
    },
  } as PluginRuntime;
  let stop: Promise<void> | undefined;
  const manager = await instance.run(async () => {
    setMatrixRuntime(runtime);
    const created = await createMatrixThreadBindingManager({
      cfg: {},
      accountId,
      auth: {
        accountId,
        homeserver: "https://matrix.example.org",
        userId: "@fi:example.org",
        accessToken: "synthetic-native-retirement-token",
        deviceId: "TEST-DEVICE",
        encryption: false,
      },
      client: {} as never,
      stateDir,
      idleTimeoutMs: 0,
      maxAgeMs: 0,
      enableSweeper: false,
    });
    const binding = await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:fixture",
      targetKind: "subagent",
      conversation: { channel: "matrix", accountId, conversationId: "$fixture" },
      placement: "current",
      metadata: { introText: false },
    });
    expect(binding).not.toBeNull();
    created.touchBinding(binding!.bindingId, binding!.boundAt + 1000);
    // The shared Matrix lifecycle starts retirement in an abort listener, then
    // joins that same physical cleanup from its registered disposer.
    instance.lifecycle.signal.addEventListener(
      "abort",
      () => {
        stop = created.stop();
        void stop.catch(() => {});
      },
      { once: true },
    );
    instance.lifecycle.onDispose(() => stop ?? created.stop());
    return created;
  });

  const result = await instance.dispose();
  expect(result.errors).toEqual([]);
  await expect(stop).resolves.toBeUndefined();
  expect(manager.listBindings()).toEqual([]);
});
