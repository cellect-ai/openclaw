import { type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";

export const retainedOwnerConfig = {
  agents: {
    entries: {
      main: { tools: { exec: { host: "gateway" as const } } },
      policy: { tools: { exec: { host: "node" as const, node: "worker-1" } } },
    },
  },
};

export const policyDeny = ["exec", "process", "write", "edit"];

export function policyCase(
  source: string,
  overrides: Partial<EmbeddedRunAttemptParams>,
  denied = true,
) {
  return { source, ...overrides, denied };
}

export const fullNodeExec = {
  host: "node",
  node: "mac-mini",
  security: "full",
  ask: "off",
} as const;

export const globalNodeConfig = { tools: { exec: { host: "node" as const } } };
