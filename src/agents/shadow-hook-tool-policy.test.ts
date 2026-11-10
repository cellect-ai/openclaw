import { describe, expect, it } from "vitest";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { applyEmbeddedAttemptToolsAllow } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";
import {
  SHADOW_HOOK_TOOL_ALLOWLIST,
  capShadowHookToolsAllow,
  shadowHookRunParams,
} from "./shadow-hook-tool-policy.js";

const SHADOW = "agent:cellect-fi-user:hook:fi-shadow:abc";
const EVERYTHING = [
  "fi_user_api",
  "m365_shadow_mail",
  "exec",
  "bash",
  "process",
  "browser",
  "web_search",
  "web_fetch",
  "write",
  "edit",
  "apply_patch",
  "read",
  "message",
  "sessions_send",
  "sessions_spawn",
  "subagents",
  "cron",
  "memory_store",
  "memory_search",
].map((name) => ({ name }));

describe("Fi shadow hook tool cap", () => {
  it("cuts any request to the two shadow tools", () => {
    expect(capShadowHookToolsAllow(undefined)).toEqual([...SHADOW_HOOK_TOOL_ALLOWLIST]);
    expect(capShadowHookToolsAllow(["*"])).toEqual([...SHADOW_HOOK_TOOL_ALLOWLIST]);
    expect(capShadowHookToolsAllow(["exec", "fi_user_api", "group:fs"])).toEqual(["fi_user_api"]);
    expect(capShadowHookToolsAllow(["exec", "browser"])).toEqual([]);
    expect(capShadowHookToolsAllow([])).toEqual([]);
  });

  it("overrides the run parameters of a shadow session only", () => {
    const params = shadowHookRunParams(SHADOW, {
      toolsAllow: ["*"],
      toolExecutionAllow: ["exec", "fi_user_api"],
    });
    expect(params).toEqual({
      toolsAllow: ["fi_user_api", "m365_shadow_mail"],
      toolExecutionAllow: ["fi_user_api"],
      disableMessageTool: true,
      disableToolSearch: true,
      forceMessageTool: false,
      forceCodeModeTools: false,
      codeModeOverride: false,
    });
    expect(shadowHookRunParams("agent:cellect-fi-user:hook:fi-mail:abc", {})).toEqual({});
    expect(shadowHookRunParams(undefined, { toolsAllow: ["*"] })).toEqual({});
  });

  it.each([undefined, ["*"], ["exec", "fi_user_api", "message"]])(
    "leaves exactly the two tools after the runtime allowlist is applied (%j)",
    (requested) => {
      const { toolsAllow } = shadowHookRunParams(SHADOW, { toolsAllow: requested }) as {
        toolsAllow: string[];
      };
      const names = applyEmbeddedAttemptToolsAllow(EVERYTHING, toolsAllow).map((t) => t.name);
      expect(names.every((name) => SHADOW_HOOK_TOOL_ALLOWLIST.includes(name))).toBe(true);
      expect(names).toContain("fi_user_api");
    },
  );

  it("caps the capability profile of a shadow session, whatever was asked", () => {
    const profile = resolveConversationCapabilityProfile({
      sessionKey: SHADOW,
      agentId: "cellect-fi-user",
      runtimeToolAllowlist: ["*"],
      inheritRuntimeToolAllowlist: true,
    });
    expect(profile.policy.runtimeToolPolicyForInheritance).toEqual({
      allow: ["fi_user_api", "m365_shadow_mail"],
    });
    const none = resolveConversationCapabilityProfile({
      sessionKey: SHADOW,
      agentId: "cellect-fi-user",
      inheritRuntimeToolAllowlist: true,
    });
    expect(none.policy.runtimeToolPolicyForInheritance).toEqual({
      allow: ["fi_user_api", "m365_shadow_mail"],
    });
    const other = resolveConversationCapabilityProfile({
      sessionKey: "agent:cellect-fi-user:main",
      agentId: "cellect-fi-user",
      runtimeToolAllowlist: ["*"],
      inheritRuntimeToolAllowlist: true,
    });
    expect(other.policy.runtimeToolPolicyForInheritance).toEqual({ allow: ["*"] });
  });
});
