import { afterEach, expect, it } from "vitest";
import { createHookRunner } from "./hooks.js";
import {
  dispatchPluginAgentEventSubscriptions,
  clearPluginHostRuntimeState,
} from "./host-hook-runtime.js";
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

function setup() {
  useNoBundledPlugins();
  const plugin = writePlugin({
    id: "scoped-run-context",
    registration: `
      const state = { api, observations: [] };
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
  const registry = loadPluginRegistryHandle({
    config: {
      plugins: {
        allow: [plugin.id],
        load: { paths: [plugin.file] },
        slots: { memory: "none" },
      },
    },
    cache: false,
    runtimeSideEffects: false,
  });
  registries.push(registry);
  expect(registry.plugins.find((record) => record.id === plugin.id)?.status).toBe("loaded");
  const state = Reflect.get(globalThis, fixtureKey) as {
    api: OpenClawPluginApi;
    observations: Observation[];
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
  return { registry, state, invoke };
}

it("allows only run-context state from an admitted non-activating plugin hook", async () => {
  const { state, invoke } = setup();
  const selected = { runId, namespace: "diagnostic-bits" };
  expect(state.api.runContext.setRunContext({ ...selected, value: 1 })).toBe(false);
  await invoke();
  expect(state.observations).toEqual([{ wrote: true, value: 3, cleared: undefined }]);
  // Running one hook does not turn the caller-owned inspection into a process-global writer.
  expect(state.api.runContext.setRunContext({ ...selected, value: 1 })).toBe(false);
  expect(state.api.emitAgentEvent({ runId, stream: "lifecycle", data: {} }).emitted).toBe(false);
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
