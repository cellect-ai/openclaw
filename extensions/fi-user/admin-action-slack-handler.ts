import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { slackCardView } from "./admin-action-card.js";
import { isSlackOrigin } from "./admin-action-origin.js";
import { applyAdminDecision } from "./admin-action-rpc.js";
import {
  authorizeSlackReviewer,
  parseSlackActionPayload,
  SLACK_ADMIN_ACTION_NAMESPACE,
  slackReviewerMessage,
} from "./admin-action-slack.js";
import { loadAdminAction } from "./admin-action.js";
import { configFromRuntime } from "./fi-delegation.js";

/** The slice of the Slack plugin's interactive context this handler relies on. */
type SlackClick = {
  authority: { assertCurrent: () => void };
  accountId?: string;
  teamId?: string;
  senderId?: string;
  conversationId?: string;
  interaction?: { kind?: string; payload?: string; messageTs?: string };
  respond: {
    reply: (params: { text: string; responseType?: "ephemeral" | "in_channel" }) => Promise<void>;
    editMessage: (params: { text?: string; blocks?: unknown[] }) => Promise<void>;
  };
};

/**
 * A button click on an administrator's private card. Slack names the clicker;
 * Fi, not this handler, decides whether that person may decide. The same
 * `applyAdminDecision` the Matrix RPC uses then applies the transition.
 */
export async function handleSlackAdminActionClick(
  api: OpenClawPluginApi,
  ctx: SlackClick,
): Promise<{ handled: true }> {
  const signal = api.lifecycle.signal;
  const assertCurrent = () => {
    if (!signal) {
      throw new Error("Approval invocation authority is unavailable.");
    }
    signal.throwIfAborted();
    ctx.authority.assertCurrent();
  };
  const say = async (text: string) => {
    try {
      assertCurrent();
      await ctx.respond.reply({ text, responseType: "ephemeral" });
    } catch {
      api.logger.warn("fi-user: Slack approval reply could not be delivered");
    }
  };
  const action =
    ctx.interaction?.kind === "button"
      ? parseSlackActionPayload(ctx.interaction.payload)
      : undefined;
  const sender = ctx.senderId?.trim().toUpperCase() ?? "";
  if (!action || !sender) {
    await say("This approval action is invalid or expired.");
    return { handled: true };
  }
  let ownCard = false;
  /** Keep the clicker's own copy truthful, even when a message edit by token is unavailable. */
  const refresh = async () => {
    try {
      assertCurrent();
      const latest = await loadAdminAction(api, action.requestId);
      assertCurrent();
      if (ownCard && latest && isSlackOrigin(latest.origin)) {
        await ctx.respond.editMessage(
          slackReviewerMessage(slackCardView(latest), latest.origin.requesterSlackUserId),
        );
      }
    } catch {
      api.logger.warn("fi-user: Slack approval card could not be refreshed");
    }
  };
  try {
    assertCurrent();
    const record = await loadAdminAction(api, action.requestId);
    const origin = record?.origin;
    // Only a card this request sent to this person, in their own DM, can decide it.
    const published = record?.slackPublications?.some(
      (entry) =>
        entry.slackUserId === sender &&
        entry.channelId === ctx.conversationId &&
        entry.ts === ctx.interaction?.messageTs,
    );
    if (
      !record ||
      !isSlackOrigin(origin) ||
      !published ||
      (origin.teamId && origin.teamId !== ctx.teamId) ||
      (record.slackReviewAccountId ?? origin.accountId) !== ctx.accountId
    ) {
      await say("This approval request is unavailable here. Nothing was executed.");
      return { handled: true };
    }
    ownCard = true;
    const config = configFromRuntime(api);
    if (!config.tenantOrgId || config.tenantOrgConflict || config.tenantOrgId !== origin.orgId) {
      throw new Error("Approval environment or tenant mismatch.");
    }
    const authorization = {
      requestId: action.requestId,
      revision: action.revision,
      reviewerSlackUserId: sender,
      requesterSlackUserId: origin.requesterSlackUserId,
    };
    const { email } = await authorizeSlackReviewer(config, authorization, signal);
    assertCurrent();
    const outcome = await applyAdminDecision(api, {
      record,
      revision: action.revision,
      decision: action.decision,
      decidedBy: `slack:${sender}`,
      email,
      config,
      requester: { requesterSenderId: sender },
      reauthorize: async () => {
        assertCurrent();
        return await authorizeSlackReviewer(config, authorization, signal);
      },
      assertCurrent,
      signal,
      refreshHint: "Check the updated card",
    });
    if (!outcome.applied) {
      await say("This request was already decided or is no longer open. Nothing was changed.");
    }
    await refresh();
  } catch (error) {
    await say(
      error instanceof Error ? error.message : "Approval unavailable; nothing was executed.",
    );
    await refresh();
  }
  return { handled: true };
}

export function registerAdminActionSlackHandler(api: OpenClawPluginApi) {
  api.registerInteractiveHandler({
    channel: "slack",
    namespace: SLACK_ADMIN_ACTION_NAMESPACE,
    handler: async (ctx) => await handleSlackAdminActionClick(api, ctx as SlackClick),
  });
}
