import { runChannelAnnouncedAgentTurn } from "openclaw/plugin-sdk/channel-join-intro-runtime";
// Slack reaction triggers start a trusted, operator-configured agent turn on a reacted message.
import type { SlackAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { mergeSlackAccountConfig } from "../../accounts.js";
import { readSlackMessages, type SlackMessageSummary } from "../../actions.js";
import { formatSlackTarget } from "../../target-parsing.js";
import { authorizeSlackSystemEventSender } from "../auth.js";
import { resolveSlackChannelConfig, resolveSlackChannelLabel } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackEventScope } from "../event-scope.js";
import { resolveSlackRequestUserAllowed } from "../request-users.js";
import type { SlackReactionEvent } from "../types.js";

type SlackReactionTriggerConfig = NonNullable<SlackAccountConfig["reactionTriggers"]>[string];

const SLACK_REACTION_TRIGGER_TIMEOUT_SECONDS = 600;
// One run per message and emoji: reconnect replays and a second reactor must not refile.
const reactionTriggerRuns = createDedupeCache({ ttlMs: 24 * 60 * 60 * 1_000, maxSize: 2_000 });

/**
 * Canonical emoji name for matching: Slack reports skin-tone variants as
 * "emoji::skin-tone-2", and operators may write keys as ":emoji:".
 */
export function normalizeSlackReactionName(reaction: string | undefined): string | undefined {
  const emoji = reaction
    ?.trim()
    .replace(/^:+|:+$/g, "")
    .split("::")[0]
    ?.trim()
    .toLowerCase();
  return emoji || undefined;
}

export function resolveSlackReactionTrigger(
  ctx: Pick<SlackMonitorContext, "cfg" | "accountId">,
  reaction: string | undefined,
): (SlackReactionTriggerConfig & { emoji: string }) | undefined {
  const emoji = normalizeSlackReactionName(reaction);
  if (!emoji || !ctx.cfg) {
    return undefined;
  }
  const triggers = mergeSlackAccountConfig(ctx.cfg, ctx.accountId).reactionTriggers ?? {};
  const trigger =
    triggers[emoji] ??
    Object.entries(triggers).find(([key]) => normalizeSlackReactionName(key) === emoji)?.[1];
  return trigger ? { ...trigger, emoji } : undefined;
}

export type SlackReactionTriggerSkipReason =
  | "not-a-trigger-emoji"
  | "incomplete-event"
  | "own-reaction"
  | "unauthorized-sender"
  | "not-a-channel"
  | "request-users-mismatch"
  | "dedupe"
  | "error";

/** One INFO line per trigger decision; identifiers only, never message text. */
export function logSlackReactionTriggerDecision(params: {
  ctx: Pick<SlackMonitorContext, "accountId" | "runtime">;
  emoji: string | undefined;
  channelId: string | undefined;
  actorId: string | undefined;
  messageTs: string | undefined;
  decision: "started" | "skipped";
  reason?: SlackReactionTriggerSkipReason;
  detail?: string;
}): void {
  const parts = [
    `slack reaction trigger ${params.decision}`,
    `account=${params.ctx.accountId}`,
    `emoji=${params.emoji ?? "-"}`,
    `channel=${params.channelId ?? "-"}`,
    `actor=${params.actorId ?? "-"}`,
    `ts=${params.messageTs ?? "-"}`,
  ];
  if (params.reason) {
    parts.push(`reason=${params.reason}`);
  }
  if (params.detail) {
    parts.push(`detail=${params.detail}`);
  }
  params.ctx.runtime.log?.(parts.join(" "));
}

async function readReactedSlackMessage(params: {
  ctx: SlackMonitorContext;
  channelId: string;
  ts: string;
  eventScope?: SlackEventScope;
}): Promise<SlackMessageSummary | undefined> {
  const client = params.eventScope?.client ?? params.ctx.app.client;
  const topLevel = await readSlackMessages(params.channelId, { client, messageId: params.ts });
  if (topLevel.messages[0]) {
    return topLevel.messages[0];
  }
  // conversations.history omits thread replies; replies accepts any message ts in the thread.
  const reply = await readSlackMessages(params.channelId, {
    client,
    threadId: params.ts,
    messageId: params.ts,
  });
  return reply.messages[0];
}

async function resolveSlackPermalink(params: {
  ctx: SlackMonitorContext;
  channelId: string;
  ts: string;
  eventScope?: SlackEventScope;
}): Promise<string | undefined> {
  try {
    const client = params.eventScope?.client ?? params.ctx.app.client;
    const result = await client.chat.getPermalink({
      channel: params.channelId,
      message_ts: params.ts,
    });
    return typeof result.permalink === "string" ? result.permalink : undefined;
  } catch {
    return undefined;
  }
}

export function buildSlackReactionTriggerMessage(params: {
  prompt: string;
  emoji: string;
  actorId: string;
  channelId: string;
  channelLabel: string;
  messageTs: string;
  threadTs: string;
  fileIds: readonly string[];
  permalink?: string;
}): string {
  // Only Slack identifiers are appended; the reacted message's text stays out of the prompt.
  return [
    params.prompt.trim(),
    "",
    "Slack message this reaction refers to:",
    `- reaction: :${params.emoji}: added by <@${params.actorId}>`,
    `- channel: ${params.channelId} (${params.channelLabel})`,
    `- message ts: ${params.messageTs}`,
    `- thread ts: ${params.threadTs}`,
    `- file ids: ${params.fileIds.length > 0 ? params.fileIds.join(", ") : "none"}`,
    `- permalink: ${params.permalink ?? "unavailable"}`,
  ].join("\n");
}

/**
 * Starts the configured turn when an allowed request user adds a trigger emoji
 * to any message (not only the bot's own) in a channel this account is in.
 */
export async function runSlackReactionTrigger(params: {
  ctx: SlackMonitorContext;
  event: SlackReactionEvent;
  trigger: SlackReactionTriggerConfig & { emoji: string };
  eventScope?: SlackEventScope;
}): Promise<"started" | "skipped"> {
  const { ctx, event, trigger, eventScope } = params;
  const channelId = event.item?.channel;
  const messageTs = event.item?.ts;
  const actorId = event.user;
  const skip = (reason: SlackReactionTriggerSkipReason, detail?: string): "skipped" => {
    logSlackReactionTriggerDecision({
      ctx,
      emoji: trigger.emoji,
      channelId,
      actorId,
      messageTs,
      decision: "skipped",
      reason,
      detail,
    });
    return "skipped";
  };
  if (event.item?.type !== "message" || !channelId || !messageTs || !actorId) {
    return skip("incomplete-event");
  }
  if (actorId === ctx.botUserId) {
    return skip("own-reaction");
  }
  const auth = await authorizeSlackSystemEventSender({
    ctx,
    senderId: actorId,
    channelId,
    eventScope,
  });
  if (!auth.allowed) {
    return skip("unauthorized-sender", auth.reason);
  }
  if (auth.channelType !== "channel" && auth.channelType !== "group") {
    return skip("not-a-channel", auth.channelType);
  }
  const teamId = eventScope?.teamId ?? ctx.teamId;
  const channelConfig = resolveSlackChannelConfig({
    teamId,
    allowUnscoped: ctx.installationIdentity?.kind !== "enterprise",
    channelId,
    channelName: auth.channelName,
    channels: ctx.channelsConfig,
    channelKeys: ctx.channelsConfigKeys,
    defaultRequireMention: ctx.defaultRequireMention,
    allowNameMatching: ctx.allowNameMatching,
  });
  // Triggers act on the actor's behalf, so they need an explicit requester list.
  const requestUsers = trigger.requestUsers ?? channelConfig?.requestUsers;
  if (!requestUsers || !resolveSlackRequestUserAllowed({ requestUsers, teamId, userId: actorId })) {
    return skip("request-users-mismatch", requestUsers ? undefined : "no-request-users");
  }
  const runKey = `${ctx.accountId}:${teamId}:${channelId}:${messageTs}:${trigger.emoji}`;
  if (reactionTriggerRuns.check(runKey)) {
    return skip("dedupe");
  }
  try {
    const [message, permalink] = await Promise.all([
      readReactedSlackMessage({ ctx, channelId, ts: messageTs, eventScope }),
      resolveSlackPermalink({ ctx, channelId, ts: messageTs, eventScope }),
    ]);
    const threadTs = message?.thread_ts ?? messageTs;
    logSlackReactionTriggerDecision({
      ctx,
      emoji: trigger.emoji,
      channelId,
      actorId,
      messageTs,
      decision: "started",
    });
    const channelLabel = resolveSlackChannelLabel({ channelId, channelName: auth.channelName });
    const result = await runChannelAnnouncedAgentTurn({
      cfg: ctx.cfg,
      channel: "slack",
      accountId: ctx.accountId,
      deliverTo: formatSlackTarget({
        teamId: eventScope?.teamId,
        kind: "channel",
        id: channelId,
        explicitKind: true,
      }),
      threadId: threadTs,
      route: ctx.resolveSlackSystemEventRoute({
        channelId,
        channelType: auth.channelType,
        senderId: actorId,
        threadTs,
        eventScope,
      }),
      name: `Slack reaction trigger :${trigger.emoji}:`,
      message: buildSlackReactionTriggerMessage({
        prompt: trigger.prompt,
        emoji: trigger.emoji,
        actorId,
        channelId,
        channelLabel,
        messageTs,
        threadTs,
        fileIds: (message?.files ?? []).flatMap((file) => (file.id ? [file.id] : [])),
        permalink,
      }),
      timeoutSeconds: SLACK_REACTION_TRIGGER_TIMEOUT_SECONDS,
    });
    if (!result.delivered) {
      ctx.runtime.error?.(
        `slack reaction trigger :${trigger.emoji}: in ${channelId} was not delivered: ${result.reason ?? "no reply"}`,
      );
    }
    return "started";
  } catch (err) {
    reactionTriggerRuns.delete(runKey);
    ctx.runtime.error?.(`slack reaction trigger failed: ${formatErrorMessage(err)}`);
    return skip("error");
  }
}

export function clearSlackReactionTriggerRunsForTest(): void {
  reactionTriggerRuns.clear();
}
