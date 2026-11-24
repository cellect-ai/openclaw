import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { assertSshSandboxSecretOwnerAvailable } from "./secret-owner.js";
import { resolveSandboxSession } from "./session-selection.js";

export type ResolvedSandboxSession = NonNullable<Awaited<ReturnType<typeof resolveSandboxSession>>>;

export function assertSandboxSessionSecretOwnerAvailable(
  config: OpenClawConfig | undefined,
  resolved: ResolvedSandboxSession,
): void {
  if (resolved.cfg.backend !== "ssh") {
    return;
  }
  // Never let an unresolved inline SSH credential silently fall through to
  // ambient host SSH identities for this agent.
  assertSshSandboxSecretOwnerAvailable({
    config,
    scope: resolved.cfg.scope,
    agentId: resolved.runtime.agentId,
  });
}
