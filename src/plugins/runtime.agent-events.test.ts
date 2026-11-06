import { afterEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { markPluginRegistryRetired } from "./registry-lifecycle.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationRegistryScope } from "./runtime/generation-state.js";

function registryWithListener(pluginId: string, id = "cleanup") {
  const registry = createEmptyPluginRegistry();
  const handle = vi.fn();
  registry.agentEventSubscriptions.push({
    pluginId,
    source: "fixture",
    subscription: { id, streams: ["sandbox_process"], handle },
  });
  return { registry, handle };
}

const emit = () =>
  emitAgentEvent({
    runId: "scoped-event-run",
    stream: "sandbox_process",
    data: { phase: "cleanup-complete" },
  });

describe("plugin agent events retain the hook registry owner", () => {
  afterEach(() => resetPluginRuntimeStateForTest());

  it("dispatches unscoped native events to the published registry", () => {
    const root = registryWithListener("delegation");
    setActivePluginRegistry(root.registry);
    emit();
    expect(root.handle).toHaveBeenCalledOnce();
  });

  it("dispatches a prepared generation exclusively, including an empty selection", () => {
    const root = registryWithListener("delegation");
    const prepared = registryWithListener("delegation");
    setActivePluginRegistry(root.registry);
    withPluginRuntimeGenerationRegistryScope(prepared.registry, emit);
    withPluginRuntimeGenerationRegistryScope(createEmptyPluginRegistry(), emit);
    expect(prepared.handle).toHaveBeenCalledOnce();
    expect(root.handle).not.toHaveBeenCalled();
  });

  it("overlays request subscriptions by plugin and id without dropping unrelated owners", () => {
    const root = registryWithListener("delegation");
    const unrelated = vi.fn();
    root.registry.agentEventSubscriptions.push({
      pluginId: "audit",
      source: "fixture",
      subscription: { id: "cleanup", handle: unrelated },
    });
    const request = registryWithListener("delegation");
    setActivePluginRegistry(root.registry);
    withPluginRuntimeRegistryScope(request.registry, emit);
    expect(request.handle).toHaveBeenCalledOnce();
    expect(root.handle).not.toHaveBeenCalled();
    expect(unrelated).toHaveBeenCalledOnce();
  });

  it("does not redirect a retired prepared owner's event to the root", () => {
    const root = registryWithListener("delegation");
    const prepared = registryWithListener("delegation");
    setActivePluginRegistry(root.registry);
    markPluginRegistryRetired(prepared.registry);
    withPluginRuntimeGenerationRegistryScope(prepared.registry, emit);
    expect(prepared.handle).not.toHaveBeenCalled();
    expect(root.handle).not.toHaveBeenCalled();
  });

  it("revokes asynchronous scoped callback context when its registry retires", async () => {
    const root = registryWithListener("delegation");
    const prepared = registryWithListener("delegation");
    const release = createDeferredCore();
    let value: unknown = "not-called";
    prepared.handle.mockImplementation(async (_event, context) => {
      await release.promise;
      context.setRunContext("scope", { retained: true });
      value = context.getRunContext("scope");
    });
    setActivePluginRegistry(root.registry);
    withPluginRuntimeGenerationRegistryScope(prepared.registry, emit);
    markPluginRegistryRetired(prepared.registry);
    release.resolve();
    await prepared.handle.mock.results[0]?.value;
    expect(value).toBeUndefined();
  });
});
