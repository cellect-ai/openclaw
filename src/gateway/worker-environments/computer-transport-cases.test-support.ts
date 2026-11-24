import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import type { ComputerToolTransport } from "../../agents/tools/computer-tool.js";
import {
  claimAgentRunDelegatedAuthority,
  rotateAgentRunRegistryLifecycleGeneration,
} from "../../infra/agent-run-registry.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { EXECUTION_ID, type Harness } from "./computer-transport.test-support.js";

export function request(
  action: "snapshot" | "type" | "close",
  executionId = EXECUTION_ID,
): Parameters<ComputerToolTransport["invoke"]>[0] {
  return {
    nodeId: "desktop-node",
    command: action === "snapshot" ? "screen.snapshot" : "computer.act",
    commandParams:
      action === "snapshot"
        ? { executionId, format: "png" }
        : action === "close"
          ? { executionId, action: "__close_execution", reason: "completion" }
          : { executionId, action: "type", text: "session desktop only" },
  };
}

export const revocations: Array<{ name: string; revoke(harness: Harness): void }> = [
  { name: "turn claim", revoke: (h) => h.releaseClaim() },
  {
    name: "lease",
    revoke: (h) => {
      h.state.environment = { ...h.state.environment, leaseId: "replacement" };
    },
  },
  {
    name: "owner epoch",
    revoke: (h) => {
      h.state.environment = { ...h.state.environment, ownerEpoch: 8 };
    },
  },
  {
    name: "node connection",
    revoke: (h) => {
      h.state.node = { ...h.state.node, connId: "replacement" };
    },
  },
  {
    name: "node pairing",
    revoke: (h) => {
      h.state.node = { ...h.state.node, pairingGeneration: "replacement" };
    },
  },
  {
    name: "private runner proof",
    revoke: (h) => {
      h.state.privateCurrent = false;
    },
  },
  {
    name: "operational run",
    revoke: (h) => {
      claimAgentRunDelegatedAuthority(createOperationalRunInstanceRef(h.claim.runId));
    },
  },
  {
    name: "Gateway lifecycle",
    revoke: () => {
      rotateAgentRunRegistryLifecycleGeneration();
    },
  },
  {
    name: "Gateway context",
    revoke: (h) => {
      h.state.context = undefined;
    },
  },
  {
    name: "plugin registry",
    revoke: () => setActivePluginRegistry(createEmptyPluginRegistry()),
  },
  {
    name: "plugin policy",
    revoke: (h) => {
      h.registry.nodeInvokePolicies.splice(0);
    },
  },
  {
    name: "plugin lifecycle",
    revoke: (h) => {
      h.registry.plugins[0]!.enabled = false;
    },
  },
];
