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

it("flushes a pending Matrix binding touch during native retirement without altering another account", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const stateDir = tempDirs.make("matrix-native-retirement-");
  const instance = new PluginInstance("matrix");
  const accountId = "fiuserprod";
  let bindingEnv: NodeJS.ProcessEnv | undefined;
  const runtime = {
    state: {
      resolveStateDir: () => stateDir,
      openKeyedStore: (options: Parameters<PluginRuntime["state"]["openKeyedStore"]>[0]) => {
        if (options.namespace === "thread-bindings") {
          bindingEnv = options.env;
        }
        return createPluginStateKeyedStore("matrix", options);
      },
    },
  } as PluginRuntime;
  const otherAccount = {
    accountId: "fiadminprod",
    conversationId: "$other-account",
    targetSessionKey: "agent:other:subagent:fixture",
    boundAt: 100,
    lastActivityAt: 200,
  };
  const bindingStore = () =>
    createPluginStateKeyedStore<typeof otherAccount>("matrix", {
      namespace: "thread-bindings",
      maxEntries: 10_000,
      env: bindingEnv,
    });
  let stop: Promise<void> | undefined;
  let touchedAt: number | undefined;
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
    expect(bindingEnv).toBeDefined();
    await bindingStore().register("other-account-fixture", otherAccount);
    const binding = await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:fixture",
      targetKind: "subagent",
      conversation: { channel: "matrix", accountId, conversationId: "$fixture" },
      placement: "current",
      metadata: { introText: false },
    });
    expect(binding).not.toBeNull();
    touchedAt = binding!.boundAt + 1000;
    created.touchBinding(binding!.bindingId, touchedAt);
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
  const persisted = await bindingStore().entries();
  expect(
    persisted.map(({ value }) => value).filter((entry) => entry.accountId === accountId),
  ).toEqual([expect.objectContaining({ lastActivityAt: touchedAt })]);
  expect(await bindingStore().lookup("other-account-fixture")).toEqual(otherAccount);
});
