import { getRuntimeConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { getPreparedMessageToolCatalog } from "../../plugins/prepared-message-tool-catalog.js";
import { isCronSessionKey } from "../../routing/session-key.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveTrustedDecisionChannel } from "./message-tool-decision.js";
import {
  type MessageToolDiscoveryParams,
  resolveAgentAccountId,
  resolveEffectiveCurrentChannelContext,
  resolveMessageToolDefinitionContext,
  resolveMessageToolScheduledAccountScope,
  supportsMessageToolPromptReactions,
} from "./message-tool-discovery.js";
import type { MessageToolOptions } from "./message-tool-execution.types.js";
import { createMessageToolExplicitTargetGuard } from "./message-tool-explicit-target.js";
import { resolveSourceReplySinkDeliveryMode } from "./message-tool-source-policy.js";
import { createMessageToolTurnAuthority } from "./message-tool-turn-authority.js";

export function prepareMessageToolExecution(
  options?: MessageToolOptions,
  sessionEntry?: SessionEntry,
) {
  const rawPollEchoSessionKey = options?.agentSessionKey?.trim() || undefined;
  const inferredCurrentChannel = resolveEffectiveCurrentChannelContext(options);
  const definitionContext = resolveMessageToolDefinitionContext(options, sessionEntry);
  const supportsPromptReactions = supportsMessageToolPromptReactions(options);
  const preparedMessageToolCatalog =
    options?.preparedMessageToolCatalog ?? getPreparedMessageToolCatalog();
  const currentThreadTs =
    options?.currentThreadTs ??
    (options?.agentThreadId != null
      ? stringifyRouteThreadId(options.agentThreadId)
      : inferredCurrentChannel.currentThreadTs);
  const replyToMode = options?.replyToMode ?? (currentThreadTs ? "all" : undefined);
  const agentAccountId =
    resolveAgentAccountId(options?.agentAccountId) ?? inferredCurrentChannel.accountId;
  const sourceReplySinkDeliveryMode = resolveSourceReplySinkDeliveryMode(
    inferredCurrentChannel.currentChannelProvider,
    options?.sourceReplyDeliveryMode,
  );
  const resolvedAgentId =
    options?.agentId ??
    (options?.agentSessionKey
      ? resolveSessionAgentId({ sessionKey: options.agentSessionKey, config: options.config })
      : undefined);
  const pollEchoSessionKey =
    rawPollEchoSessionKey && resolvedAgentId && sourceReplySinkDeliveryMode === "message_tool_only"
      ? `${resolvedAgentId}\0${rawPollEchoSessionKey}`
      : undefined;
  const turnAuthority = createMessageToolTurnAuthority({
    token: options?.messageActionTurnCapability,
    agentId: resolvedAgentId,
    runId: options?.runId,
    sessionKey: options?.agentSessionKey,
    sessionId: options?.sessionId,
    getConfig: () => options?.config ?? getRuntimeConfig(),
    admitScheduledInvocation: options?.admitScheduledInvocation,
  });
  const messageToolDiscoveryParams: MessageToolDiscoveryParams | undefined = options?.config
    ? {
        cfg: options.config,
        currentChatType: definitionContext.currentChatType,
        currentChannelProvider: definitionContext.currentChannelProvider,
        currentChannelId: definitionContext.currentChannelId,
        currentThreadTs: definitionContext.currentThreadTs,
        supportsPromptReactions,
        currentAccountId:
          definitionContext.accountId ??
          (options.agentSessionKey ? undefined : options.agentAccountId),
        isScheduledRun: isCronSessionKey(options.agentSessionKey),
        scheduledAccountScope: resolveMessageToolScheduledAccountScope(
          options.scheduledToolPolicy,
          sessionEntry,
        ),
        sessionKey: options.agentSessionKey,
        sessionId: options.sessionId,
        agentId: resolvedAgentId,
        preparedMessageToolCatalog,
      }
    : undefined;
  // Model-supplied channel text is untrusted until routing resolves it. Early
  // denials retain only the host-prepared source provider.
  const decisionChannel = resolveTrustedDecisionChannel(
    inferredCurrentChannel.currentChannelProvider,
    preparedMessageToolCatalog,
  );
  const explicitTargetGuard = options?.requireExplicitTarget
    ? createMessageToolExplicitTargetGuard({
        currentChannelProvider: inferredCurrentChannel.currentChannelProvider,
        preparedMessageToolCatalog,
        decisionChannel,
      })
    : undefined;
  return {
    supportsPromptReactions,
    preparedMessageToolCatalog,
    currentThreadTs,
    replyToMode,
    agentAccountId,
    sourceReplySinkDeliveryMode,
    resolvedAgentId,
    pollEchoSessionKey,
    turnAuthority,
    messageToolDiscoveryParams,
    decisionChannel,
    explicitTargetGuard,
  };
}
