import { randomUUID } from "node:crypto";
import type { ExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import { recordRuntimeActionDecision } from "../audit/runtime-action-decision.js";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookRegistration,
} from "./hook-types.js";

/** Keep runtime-decision identity and ordering scoped to one hook runner. */
export function createBeforeToolCallDecisionRecorder() {
  const runtimeDecisionScopeId = randomUUID();
  let runtimeDecisionOrdinal = 0;
  const recordBeforeToolCallDecision = (params: {
    event: PluginHookBeforeToolCallEvent;
    hook: PluginHookRegistration<"before_tool_call">;
    token?: ExecutionIdentityAdmissionToken;
    result?: PluginHookBeforeToolCallResult;
    failOpen?: boolean;
    receiptAuthority?: () => boolean | void;
  }): void => {
    if (!params.receiptAuthority) {
      return;
    }
    try {
      if (params.receiptAuthority() === false) {
        return;
      }
    } catch {
      return;
    }
    const failed = params.failOpen !== undefined;
    const blocked = params.result?.block === true || params.failOpen === false;
    recordRuntimeActionDecision({
      token: params.token,
      family: "plugin",
      operation: "before_tool_call",
      outcome: blocked ? "denied" : params.failOpen ? "unknown" : "allowed",
      coverageState: blocked || !failed ? "enforced" : "unknown",
      reasonCode: failed
        ? params.failOpen
          ? "plugin_hook_failed_open"
          : "plugin_hook_failed_closed"
        : blocked
          ? "plugin_hook_blocked"
          : params.result?.requireApproval
            ? "plugin_hook_approval_required"
            : "plugin_hook_allowed",
      owner: "plugin-hook",
      decisionBoundary: "plugin.before-tool-call",
      policyRefs: ["plugin-hook:before-tool-call"],
      summary: failed
        ? params.failOpen
          ? "A plugin hook failed open, so its policy outcome is unknown."
          : "A plugin hook failed closed before tool execution."
        : blocked
          ? "A registered plugin hook denied tool execution."
          : params.result?.requireApproval
            ? "A registered plugin hook required a separate owner-native approval decision."
            : "A registered plugin hook allowed tool execution to continue.",
      missingEvidence: params.failOpen ? ["plugin.hook_decision"] : [],
      remediation: params.failOpen
        ? [
            {
              code: "repair_plugin_hook",
              text: "Inspect the registered plugin hook failure before relying on this action.",
            },
          ]
        : [],
      discriminator: JSON.stringify([
        params.hook.pluginId,
        params.hook.registrationId ?? null,
        params.event.toolCallId ?? null,
        ++runtimeDecisionOrdinal,
        params.event.toolName,
        runtimeDecisionScopeId,
      ]),
    });
  };

  return recordBeforeToolCallDecision;
}
