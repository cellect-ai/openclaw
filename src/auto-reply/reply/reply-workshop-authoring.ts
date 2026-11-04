import {
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
} from "../../agents/admitted-run-context.js";
import { resolveConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import { isConversationToolAllowed } from "../../agents/conversation-tool-policy-pipeline.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { readChannelContextGatewayContextResolver } from "../../channels/message-access/admission-evidence.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { resolveWorkshopSkillsDir } from "../../skills/workshop/skills-root.js";
import type { SkillWorkshopWorkspaceAuthoring } from "../../skills/workshop/types.js";
import type { MsgContext } from "../templating.js";

/** The explicit native tool policy grants only this agent's Workshop, never role or profile skills. */
export function prepareReplyWorkshopAuthoring(
  context: MsgContext,
  params: {
    agentId: string;
    sessionKey: string | undefined;
    provider: string;
    model: string;
    freshHuman: boolean;
  },
): SkillWorkshopWorkspaceAuthoring | undefined {
  const resolver = readChannelContextGatewayContextResolver(context);
  const gateway = resolver?.();
  if (!params.freshHuman || !params.sessionKey || !resolver || !gateway) {
    return undefined;
  }
  const { agentId, sessionKey } = params;
  const ingressPolicy = structuredClone(context.ConversationToolPolicy);
  const skillsRoot = resolveWorkshopSkillsDir(gateway.getRuntimeConfig(), agentId);
  let bound: AdmittedRunContext | undefined;
  let owner: ReturnType<typeof getAdmittedRunDelegatedAuthority>;
  const permitted = () => {
    if (readChannelContextGatewayContextResolver(context) !== resolver || resolver() !== gateway) {
      return false;
    }
    const config = gateway.getRuntimeConfig();
    const model = bound && getAgentRunContext(bound.operationalRunInstance.runId)?.activeModel;
    const policyInput = {
      config,
      agentId,
      sessionKey,
      modelProvider: model?.provider ?? params.provider,
      modelId: model?.model ?? params.model,
      agentAccountId: context.AccountId,
      messageProvider: context.Provider ?? context.OriginatingChannel,
      senderId: context.SenderId,
      groupId: resolveGroupSessionKey(context)?.id,
      groupChannel: context.GroupChannel,
      groupSpace: context.GroupSpace,
      sandboxToolPolicy: resolveSandboxConfigForAgent(config, agentId).tools,
    };
    const policy = resolveConversationCapabilityProfile(policyInput);
    // Ingress policy is a ceiling; it must never replace the current group restriction.
    const ingressCeiling = resolveConversationCapabilityProfile({
      ...policyInput,
      conversationToolPolicy: ingressPolicy,
    });
    return (
      policy.policy.explicitToolAllowlist.includes("skill_workshop") &&
      isConversationToolAllowed(policy, "skill_workshop") &&
      isConversationToolAllowed(ingressCeiling, "skill_workshop") &&
      resolveWorkshopSkillsDir(config, agentId) === skillsRoot
    );
  };
  if (!permitted()) {
    return undefined;
  }
  const refuse = (): never => {
    throw new Error(
      "This agent's Workshop authoring authority is no longer current. Request the edit in a fresh native conversation.",
    );
  };
  return Object.freeze({
    agentId,
    bind(admitted: AdmittedRunContext) {
      const run = getAgentRunContext(admitted.operationalRunInstance.runId);
      if (
        (bound && bound !== admitted) ||
        run?.agentId !== agentId ||
        run.sessionKey !== sessionKey ||
        !permitted()
      ) {
        refuse();
      }
      bound = admitted;
      owner = getAdmittedRunDelegatedAuthority(admitted);
      if (!owner) {
        refuse();
      }
    },
    assertCurrent() {
      const caller = getGatewayToolCallerIdentity();
      if (
        !bound ||
        !owner ||
        getAdmittedRunDelegatedAuthority(bound) !== owner ||
        caller?.operationalRunInstance !== bound.operationalRunInstance ||
        caller.agentId !== agentId ||
        caller.sessionKey !== sessionKey ||
        !caller.receiptAuthority ||
        caller.receiptAuthority() === false ||
        !permitted()
      ) {
        refuse();
      }
    },
  });
}
