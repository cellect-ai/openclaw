import { expect, vi } from "vitest";
import { loggingState } from "../logging/state.js";
import { appendRuntimePluginToolGrant } from "./tool-grant-allowlist.js";
import { createOptionalToolContext as createContext } from "./tools.optional.test-helpers.js";

export function createResolveToolsParams(params?: {
  context?: ReturnType<typeof createContext> & Record<string, unknown>;
  clientCaps?: string[];
  toolAllowlist?: readonly string[];
  toolDenylist?: readonly string[];
  existingToolNames?: Set<string>;
  env?: NodeJS.ProcessEnv;
  suppressNameConflicts?: boolean;
  allowGatewaySubagentBinding?: boolean;
  runtimePluginToolGrant?: { pluginId: string; toolNames: readonly string[] };
}) {
  const toolAllowlist = appendRuntimePluginToolGrant(
    [...(params?.toolAllowlist ?? [])],
    params?.runtimePluginToolGrant,
  );
  return {
    context: (params?.context ?? createContext()) as never,
    ...(params?.clientCaps ? { clientCaps: params.clientCaps } : {}),
    ...(toolAllowlist.length > 0 ? { toolAllowlist } : {}),
    ...(params?.toolDenylist ? { toolDenylist: [...params.toolDenylist] } : {}),
    ...(params?.existingToolNames ? { existingToolNames: params.existingToolNames } : {}),
    ...(params?.env ? { env: params.env } : {}),
    ...(params?.suppressNameConflicts ? { suppressNameConflicts: true } : {}),
    ...(params?.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
  };
}

export function createMalformedTool(name: string) {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "bad" }] };
    },
  };
}

export function installConsoleMethodSpy(method: "log" | "warn") {
  const spy = vi.fn();
  loggingState.rawConsole = {
    log: method === "log" ? spy : vi.fn(),
    info: vi.fn(),
    warn: method === "warn" ? spy : vi.fn(),
    error: vi.fn(),
  };
  return spy;
}

export function requireConsoleMessage(spy: { mock: { calls: unknown[][] } }, index = 0): string {
  const call = spy.mock.calls[index];
  if (!call) {
    throw new Error(`expected console call ${index}`);
  }
  expect(typeof call[0]).toBe("string");
  if (typeof call[0] !== "string") {
    throw new Error(`expected console call ${index} to contain a string message`);
  }
  return call[0];
}
