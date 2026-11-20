import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { delegatedFetch, exchange, readFiResponse } from "./fi-delegation.js";
import { mailItemsPrivateRoomId } from "./mail-items-tool.js";

/** Fi owns the wording: its Desk rules, plus the review loop's return context when enrolled. */
export function personalAgentTurnContext(value: unknown): string | undefined {
  const instructions = (value as { instructions?: unknown } | null)?.instructions;
  return typeof instructions === "string" && instructions.trim() && instructions.length <= 16_000
    ? instructions
    : undefined;
}

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
        const value = await readFiResponse(response);
        authority.assertActive();
        const prependContext = response.ok ? personalAgentTurnContext(value) : undefined;
        return prependContext ? { prependContext } : undefined;
      } catch {
        // Missing or expired requester authority adds no private context.
        return undefined;
      }
    },
    { requiresToolAuthority: true },
  );
}
