import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-binding-runtime";
import type { CoreConfig } from "../types.js";
import { withResolvedMatrixSendClient } from "./send/client.js";

type LifecycleHandle = ReturnType<
  OpenClawPluginApi["runtime"]["events"]["registerConversationLifecycleTransport"]
>;
let activeLifecycle: LifecycleHandle | undefined;

export function resolveMatrixProjectionRun(runId: string, sessionKey: string) {
  return activeLifecycle?.resolveRun(runId, sessionKey);
}

export function noteMatrixProjectionFinalResult(
  result: Parameters<LifecycleHandle["noteResult"]>[0],
) {
  activeLifecycle?.noteResult(result);
}

export function startMatrixProjectionLifecycle(api: OpenClawPluginApi) {
  const handle = api.runtime.events.registerConversationLifecycleTransport({
    transportId: "matrix-conversation-v2",
    resolveBindings: (owner) =>
      getSessionBindingService()
        .listBySession(owner.sessionKey)
        .flatMap((binding) => {
          const metadata = binding.metadata;
          const roomId = binding.conversation.parentConversationId;
          if (
            binding.conversation.channel !== "matrix" ||
            !roomId ||
            typeof metadata?.environment !== "string" ||
            !metadata.environment ||
            typeof metadata.projectedConversationId !== "string" ||
            !metadata.projectedConversationId ||
            metadata.agentId !== owner.agentId
          )
            return [];
          return [
            {
              environment: metadata.environment,
              conversationId: metadata.projectedConversationId,
              roomId,
              bindingId: binding.bindingId,
              accountId: binding.conversation.accountId,
              threadRootEventId: binding.conversation.conversationId,
              sessionKey: owner.sessionKey,
              agentId: owner.agentId,
            },
          ];
        }),
    publish: async (binding, event, transactionId) => {
      await withResolvedMatrixSendClient(
        {
          cfg: (api.runtime.config.current?.() ?? api.config) as CoreConfig,
          accountId: binding.accountId,
        },
        async (client) => {
          await client.sendEvent(
            binding.roomId,
            "m.cellect.conversation.lifecycle",
            { ...event },
            transactionId,
          );
        },
      );
    },
    onError: () => {
      api.logger.warn("matrix: lifecycle publication remains in durable custody");
    },
  });
  activeLifecycle = handle;
  return {
    stop: () => {
      if (activeLifecycle === handle) activeLifecycle = undefined;
      handle.stop();
    },
  };
}
