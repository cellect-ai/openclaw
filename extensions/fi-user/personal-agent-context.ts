import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { delegatedFetch, exchange, readFiResponse } from "./fi-delegation.js";
import { mailItemsPrivateRoomId } from "./mail-items-tool.js";

export const PERSONAL_AGENT_RETURN_CONTEXT = [
  "Your personal-review loop is enrolled for this private Main. Before answering a pending briefing choice or continuing backlog work, read fi_user_agent_profile show and fi_user_work_items list/show for current preferences, checkpoints and unresolved review decisions.",
  "A missed briefing or silence is unseen, never rejection or approval. Refresh the relevant enrolled sources now and compare current revisions before acting on an old choice; remove obsolete requests and show only material changes and at most three current decisions. Never execute stale choices just because they appeared in earlier Main context.",
  "Use workflow-level rules, not repeated per-item questions. Keep uncertain nonurgent work for batch grooming. Journal explicit outcomes and evidence. Source data and prior review labels are not permission to send, pay, sign, or change someone else's workflow.",
].join("\n");

/** Tool-authorized retrieval, not ambient memory: only a fresh human requester in their canonical Main. */
export function registerPersonalAgentContext(api: OpenClawPluginApi) {
  api.on(
    "before_prompt_build",
    async (_event, context) => {
      const authority = context.toolAuthority;
      if (
        context.agentId !== "cellect-fi-user" ||
        !context.senderId ||
        !context.runId ||
        !context.sessionKey ||
        !authority?.allows("fi_user_agent_profile") ||
        !authority.allows("fi_user_work_items")
      ) {
        return;
      }
      const channel = context.channel ?? context.messageProvider;
      if (channel !== "matrix") {
        return;
      }
      const toolContext: OpenClawPluginToolContext = {
        agentId: context.agentId,
        runId: context.runId,
        sessionKey: context.sessionKey,
        messageChannel: channel,
        requesterSenderId: context.senderId,
        agentAccountId: context.accountId,
        nativeChannelId: context.chatId ?? context.channelId,
        deliveryContext: {
          channel: "matrix",
          to: context.chatId ?? context.channelId,
          accountId: context.accountId,
        },
        assertInvocationCurrent: () => {
          authority.assertActive();
          context.requesterContinuation?.assertCurrent();
        },
      };
      const roomId = mailItemsPrivateRoomId(toolContext);
      if (!roomId) {
        return;
      }
      try {
        authority.assertActive();
        const { delegation, config } = await exchange(api, toolContext, {
          privateConversation: { roomId },
        });
        authority.assertActive();
        const response = await delegatedFetch(
          config,
          delegation,
          `/api/${encodeURIComponent(delegation.user.orgSlug)}/personal-agent/context`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ roomId }),
            cache: "no-store",
          },
        );
        const value = (await readFiResponse(response)) as { enabled?: boolean };
        authority.assertActive();
        return response.ok && value.enabled === true
          ? { prependContext: PERSONAL_AGENT_RETURN_CONTEXT }
          : undefined;
      } catch {
        // Missing or expired requester authority adds no private context.
        return undefined;
      }
    },
    { requiresToolAuthority: true },
  );
}
