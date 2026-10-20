import { afterEach, expect, it } from "vitest";
import { createHookRunner } from "./hooks.js";
import {
  dispatchPluginAgentEventSubscriptions,
  clearPluginHostRuntimeState,
} from "./host-hook-runtime.js";
import { activatePluginRegistry } from "./loader-shared.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { loadPluginRegistryHandle } from "./loader.js";
import {
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import type { PluginRegistry } from "./registry-types.js";
import { disposePluginRegistryInstances } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import type { OpenClawPluginApi } from "./types.js";

const fixtureKey = Symbol.for("openclaw.test.scopedRunContext");
const registries: PluginRegistry[] = [];
const runId = "00000000-0000-4000-8000-000000000001";
type Observation = { wrote: boolean; value: unknown; cleared: unknown };

afterEach(async () => {
  for (const registry of registries.splice(0)) {
    await disposePluginRegistryInstances(registry);
  }
  Reflect.deleteProperty(globalThis, fixtureKey);
  clearPluginHostRuntimeState();
  resetPluginLoaderTestStateForTest();
});

function setup(borrowed = false) {
  useNoBundledPlugins();
  const plugin = writePlugin({
    id: "scoped-run-context",
    registration: `
      const state = { api, observations: [] };
      state.registrationWrite = api.runContext.setRunContext({
        runId: "registration-run", namespace: "diagnostic-bits", value: 1,
      });
      globalThis[Symbol.for("openclaw.test.scopedRunContext")] = state;
      api.on("before_agent_reply", (_event, context) => {
        const selected = { runId: context.runId, namespace: "diagnostic-bits" };
        const wrote = api.runContext.setRunContext({ ...selected, value: 3 });
        const value = api.runContext.getRunContext(selected);
        api.runContext.clearRunContext(selected);
        state.observations.push({ wrote, value, cleared: api.runContext.getRunContext(selected) });
      });
    `,
  });
  const options: PluginLoadOptions = {
    config: {
      plugins: {
        allow: [plugin.id],
        load: { paths: [plugin.file] },
        slots: { memory: "none" },
        entries: { [plugin.id]: { enabled: true, hooks: { allowConversationAccess: true } } },
      },
    },
    cache: false,
    runtimeSideEffects: false,
  };
  const lender = loadPluginRegistryHandle({ ...options, runtimeSideEffects: borrowed });
  registries.push(lender);
  if (borrowed) {
    activatePluginRegistry(lender, null, "gateway-bindable");
  }
  const registry = borrowed
    ? loadPluginRegistryHandle({ ...options, borrowRegistry: lender })
    : lender;
  if (borrowed) {
    registries.push(registry);
  }
  expect(registry.plugins.find((record) => record.id === plugin.id)?.status).toBe("loaded");
  expect(registry.typedHooks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ pluginId: plugin.id, hookName: "before_agent_reply" }),
    ]),
  );
  const state = Reflect.get(globalThis, fixtureKey) as {
    api: OpenClawPluginApi;
    observations: Observation[];
    registrationWrite: boolean;
  };
  const runner = createHookRunner(registry);
  const invoke = () =>
    withPluginRuntimeRegistryScope(registry, () =>
      runner.runBeforeAgentReply(
        { cleanedBody: "Synthetic diagnostic probe" },
        {
          runId,
          sessionKey: "agent:fixture:matrix:direct:synthetic",
          agentId: "fixture",
          trigger: "user",
        },
      ),
    );
  return { registry, lender, state, invoke };
}

it("allows only run-context state from an admitted non-activating plugin hook", async () => {
  const { state, invoke } = setup();
  const selected = { runId, namespace: "diagnostic-bits" };
  expect(state.registrationWrite).toBe(false);
  expect(state.api.runContext.setRunContext({ ...selected, value: 1 })).toBe(false);
  await invoke();
  expect(state.observations).toEqual([{ wrote: true, value: 3, cleared: undefined }]);
  // Running one hook does not turn the caller-owned inspection into a process-global writer.
  expect(state.api.runContext.setRunContext({ ...selected, value: 1 })).toBe(false);
  expect(state.api.emitAgentEvent({ runId, stream: "lifecycle", data: {} }).emitted).toBe(false);
});

it("admits borrowed hooks only while their exact lending instance remains live", async () => {
  const { registry, lender, state, invoke } = setup(true);
  expect(registry.plugins[0]).toBe(lender.plugins[0]);
  await invoke();
  expect(state.observations).toEqual([{ wrote: true, value: 3, cleared: undefined }]);
  await disposePluginRegistryInstances(lender);
  await invoke();
  expect(state.observations).toHaveLength(1);
  expect(
    state.api.runContext.setRunContext({ runId, namespace: "diagnostic-bits", value: 1 }),
  ).toBe(false);
});

it("keeps settled runs and retired scoped plugin APIs unable to create run state", async () => {
  const { registry, state, invoke } = setup();
  await invoke();
  dispatchPluginAgentEventSubscriptions({
    registry,
    event: {
      runId,
      seq: 1,
      ts: Date.now(),
      stream: "lifecycle",
      data: { phase: "end", executionSettled: true },
    },
    isLive: () => true,
  });
  await invoke();
  expect(state.observations[1]?.wrote).toBe(false);
  await disposePluginRegistryInstances(registry);
  expect(
    state.api.runContext.setRunContext({
      runId: "other-run",
      namespace: "diagnostic-bits",
      value: 1,
    }),
  ).toBe(false);
});
