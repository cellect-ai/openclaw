import { vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { addTestHook, createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import type { PluginHookRegistration } from "../plugins/types.js";
import { toClientToolDefinitions } from "./agent-tool-definition-adapter.js";
import type { AnyAgentTool } from "./agent-tools.types.js";

export type BeforeToolCallHandlerMock = ReturnType<typeof vi.fn>;

export function asAgentTool(tool: {
  description?: string;
  execute: ReturnType<typeof vi.fn>;
  name: string;
  parameters?: object;
  resultContentSource?: AnyAgentTool["resultContentSource"];
}): AnyAgentTool {
  return tool as unknown as AnyAgentTool;
}

export type BeforeToolCallHookInstall = {
  pluginId: string;
  priority?: number;
  handler: BeforeToolCallHandlerMock;
};

export function collectMatching<T, U>(
  items: readonly T[],
  predicate: (item: T) => boolean,
  map: (item: T) => U,
): U[] {
  const matches: U[] = [];
  for (const item of items) {
    if (predicate(item)) {
      matches.push(map(item));
    }
  }
  return matches;
}

export function installBeforeToolCallHook(params?: {
  enabled?: boolean;
  runBeforeToolCallImpl?: (...args: unknown[]) => unknown;
}): BeforeToolCallHandlerMock {
  resetGlobalHookRunner();
  const handler = params?.runBeforeToolCallImpl
    ? vi.fn(params.runBeforeToolCallImpl)
    : vi.fn(async () => undefined);
  if (params?.enabled === false) {
    return handler;
  }
  initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "before_tool_call", handler }]));
  return handler;
}

export function installBeforeToolCallHooks(hooks: BeforeToolCallHookInstall[]): void {
  resetGlobalHookRunner();
  const registry = createEmptyPluginRegistry();
  for (const hook of hooks) {
    addTestHook({
      registry,
      pluginId: hook.pluginId,
      hookName: "before_tool_call",
      handler: hook.handler as PluginHookRegistration["handler"],
      priority: hook.priority,
    });
  }
  initializeGlobalHookRunner(registry);
}

export function clientToolDefinition(
  name: string,
  description: string,
  properties: Record<string, unknown>,
): Parameters<typeof toClientToolDefinitions>[0][number] {
  return {
    type: "function",
    function: { name, description, parameters: { type: "object", properties } },
  };
}
