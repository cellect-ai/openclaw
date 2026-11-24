import { vi } from "vitest";
import { AgentHarnessPreflightError, recordAgentHarnessPreflightOwner } from "./harness/errors.js";
import { registerAgentHarness } from "./harness/registry.js";
import type { AgentHarness } from "./harness/types.js";

export function registerFallbackHarness(id: string): void {
  registerAgentHarness(
    {
      id,
      label: id,
      supports: () => ({ supported: true }),
      runAttempt: vi.fn<AgentHarness["runAttempt"]>(async () => {
        throw new Error("fallback test should not invoke the registered harness directly");
      }),
    },
    { ownerPluginId: `${id}-test` },
  );
}

export function createHarnessScopedPreflightError(harnessId: string): AgentHarnessPreflightError {
  const error = new AgentHarnessPreflightError("Codex approvals denied execution", {
    scope: "harness",
  });
  recordAgentHarnessPreflightOwner(error, harnessId);
  return error;
}
