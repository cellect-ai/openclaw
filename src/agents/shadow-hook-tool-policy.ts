// Fi shadow-turn tool cap (Cellect fork).
//
// A `hook:fi-shadow:` run reads untrusted inbound mail with a member's private
// data in reach, so the gateway itself, not a plugin's good manners, bounds its
// tool surface to the Fi read API and the draft-only mailbox tool. Every run
// entry (embedded runner, capability profile) applies the same cap; a narrower
// request is honoured, a wider one (including `*` or a group) is cut down.

import { isShadowHookSessionKey } from "../infra/hook-requester-attestation.js";
import { normalizeToolPolicyName } from "./tool-policy.js";

export const SHADOW_HOOK_TOOL_ALLOWLIST: readonly string[] = ["fi_user_api", "m365_shadow_mail"];

/** True when any of the run's session keys names a Fi shadow hook. */
export function isShadowHookRun(...sessionKeys: Array<string | undefined | null>): boolean {
  return sessionKeys.some((key) => isShadowHookSessionKey(key));
}

/** The allowlist a shadow run may carry: the requested one cut to the shadow tools. */
export function capShadowHookToolsAllow(requested?: readonly string[]): string[] {
  if (requested === undefined) {
    return [...SHADOW_HOOK_TOOL_ALLOWLIST];
  }
  const names = new Set(requested.map(normalizeToolPolicyName));
  return SHADOW_HOOK_TOOL_ALLOWLIST.filter((tool) => names.has("*") || names.has(tool));
}

/** Run-parameter overrides for a shadow run; empty for every other run. */
export function shadowHookRunParams(
  sessionKey: string | undefined | null,
  requested: { toolsAllow?: readonly string[]; toolExecutionAllow?: readonly string[] },
):
  | {
      toolsAllow: string[];
      toolExecutionAllow: string[];
      disableMessageTool: true;
      forceMessageTool: false;
      forceCodeModeTools: false;
      codeModeOverride: false;
    }
  | Record<string, never> {
  if (!isShadowHookRun(sessionKey)) {
    return {};
  }
  const toolsAllow = capShadowHookToolsAllow(requested.toolsAllow);
  return {
    toolsAllow,
    toolExecutionAllow: capShadowHookToolsAllow(requested.toolExecutionAllow).filter((tool) =>
      toolsAllow.includes(tool),
    ),
    disableMessageTool: true,
    forceMessageTool: false,
    forceCodeModeTools: false,
    codeModeOverride: false,
  };
}
