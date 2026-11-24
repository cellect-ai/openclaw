import { resolveGroupToolPolicy } from "../../agents/agent-tools.policy.js";
import { resolveScheduledToolCallerContext } from "../../agents/scheduled-tool-policy.js";
import { resolveCronJobToolPolicyContext } from "../execution-context-admission.js";
import { isCommandStyleCronMessage } from "./command-style-prompt.js";
import { finalizeCronPromptForResolvedTools } from "./run-delivery-trace.js";
import type { CronRunExecutionParams } from "./run-execution.types.js";

export function prepareCronPromptPolicy(
  params: Pick<
    CronRunExecutionParams,
    | "agentPayload"
    | "job"
    | "sourceDelivery"
    | "resolvedDelivery"
    | "cfgWithAgentDefaults"
    | "deliveryRequested"
    | "messageToolFormatPrompt"
  >,
) {
  const bootstrapContextMode =
    (params.agentPayload?.lightContext ??
    isCommandStyleCronMessage(params.agentPayload?.message ?? ""))
      ? "lightweight"
      : undefined;
  const scheduledToolPolicy = resolveCronJobToolPolicyContext(
    params.job,
    params.agentPayload?.toolsAllow,
  );
  const { sourceDelivery } = params;
  const messageChannel = sourceDelivery.target.channel ?? params.resolvedDelivery.channel;
  if (scheduledToolPolicy?.mode === "account") {
    const callerContext = resolveScheduledToolCallerContext({ scheduledToolPolicy });
    resolveGroupToolPolicy({
      config: params.cfgWithAgentDefaults,
      sessionKey: scheduledToolPolicy.ownerSessionKey,
      messageProvider: callerContext.local ? messageChannel : (callerContext.channel ?? undefined),
      accountId: scheduledToolPolicy.ownerAccountId,
      requireConfiguredAccount: true,
      senderPolicyMode: "never",
    });
  }
  const finalizePromptForResolvedTools = ({
    prompt,
    messageToolAvailable,
  }: {
    prompt: string;
    messageToolAvailable: boolean;
  }) =>
    finalizeCronPromptForResolvedTools({
      prompt,
      messageToolAvailable,
      deliveryRequested: params.deliveryRequested,
      resolvedDelivery: params.resolvedDelivery,
      sourceDelivery,
      messageToolFormatPrompt: params.messageToolFormatPrompt,
    });
  return {
    bootstrapContextMode,
    scheduledToolPolicy,
    messageChannel,
    finalizePromptForResolvedTools,
  };
}
