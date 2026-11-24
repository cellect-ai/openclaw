import { buildMentionRegexes } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  asOptionalRecord as asRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { getSlackThreadOwnerPeer } from "../../sent-thread-cache.js";
import type { SlackMessageEvent } from "../../types.js";
import { readSlackAssistantThreadContext } from "../assistant-thread-context.js";
import type { SlackAssistantThreadContext } from "../context.js";
import type { SlackMonitorContext } from "../context.js";
import { normalizeSlackChannelType } from "../context.js";
import type { SlackEventScope } from "../event-scope.js";
import { getOrCreateWeakOwnerMap } from "../lru-map-cache.js";
import { logSlackDroppedDirectMessage } from "../unanswered-mentions.js";
import type { prepareSlackMessage } from "./prepare.js";
import { collectSlackMentionIds, normalizeSlackId } from "./subteam-mentions.js";

export const mentionRegexCache = new WeakMap<SlackMonitorContext, Map<string, RegExp[]>>();

export function resolveSlackThreadOwnershipPreference(
  cfg: OpenClawConfig,
  currentAccountId: string,
): readonly string[] | undefined {
  const preferredAccounts = cfg.channels?.slack?.threadOwnership?.preferredAccounts;
  if (!preferredAccounts) {
    return undefined;
  }
  return [...new Set([...preferredAccounts, currentAccountId].map((value) => value.trim()))].filter(
    Boolean,
  );
}

export type SlackThreadOwnerCandidates =
  | { kind: "mentioned"; accountIds: string[] }
  | { kind: "participants"; accountIds: readonly string[] }
  | { kind: "current" | "responders"; accountIds: string[] };

export function resolveSlackThreadOwnerCandidates(params: {
  preference: readonly string[];
  currentAccountId: string;
  explicitlyMentioned: boolean;
  mentionedUserIds: readonly string[];
  hasReplyToCurrentBot: boolean;
  hasCurrentThreadParticipation: boolean;
  isThreadReply: boolean;
  answersUnmentionedTopLevel: boolean;
  channelId: string;
  channelName?: string;
}): SlackThreadOwnerCandidates | undefined {
  const mentionedOwner = params.preference.find((accountId) => {
    if (accountId === params.currentAccountId) {
      return params.explicitlyMentioned;
    }
    const botUserId = normalizeSlackId(getSlackThreadOwnerPeer(accountId)?.botUserId());
    return Boolean(botUserId && params.mentionedUserIds.includes(botUserId));
  });
  if (mentionedOwner) {
    return { kind: "mentioned", accountIds: [mentionedOwner] };
  }
  if (params.explicitlyMentioned || params.hasReplyToCurrentBot) {
    return { kind: "current", accountIds: [params.currentAccountId] };
  }
  if (params.isThreadReply) {
    return params.hasCurrentThreadParticipation
      ? { kind: "participants", accountIds: params.preference }
      : undefined;
  }
  if (!params.answersUnmentionedTopLevel) {
    return undefined;
  }
  return {
    kind: "responders",
    accountIds: params.preference.filter(
      (accountId) =>
        accountId === params.currentAccountId ||
        getSlackThreadOwnerPeer(accountId)?.answersUnmentioned(
          params.channelId,
          params.channelName,
        ) === true,
    ),
  };
}

export function hasSlackAssistantThreadMetadata(
  context: Omit<SlackAssistantThreadContext, "updatedAt"> | undefined,
): boolean {
  return Boolean(context?.channelId || context?.teamId || context?.enterpriseId !== undefined);
}

export function resolveSlackMessageAssistantThreadContext(
  message: SlackMessageEvent,
): Omit<SlackAssistantThreadContext, "updatedAt"> | undefined {
  const thread = asRecord(message.assistant_thread);
  if (!thread) {
    return undefined;
  }
  const context = asRecord(thread.context);
  const assistantChannelId = normalizeOptionalString(thread.channel_id) ?? message.channel;
  const threadTs = normalizeOptionalString(thread.thread_ts) ?? message.thread_ts ?? message.ts;
  if (!assistantChannelId || !threadTs) {
    return undefined;
  }
  return {
    assistantChannelId,
    threadTs,
    channelId: normalizeOptionalString(context?.channel_id),
    teamId: normalizeOptionalString(context?.team_id),
    enterpriseId:
      context?.enterprise_id === null ? null : normalizeOptionalString(context?.enterprise_id),
  };
}

export async function restoreSlackAssistantThreadContextFromMetadata(params: {
  ctx: SlackMonitorContext;
  message: SlackMessageEvent;
  eventScope?: SlackEventScope;
}): Promise<Omit<SlackAssistantThreadContext, "updatedAt"> | undefined> {
  const threadTs = params.message.thread_ts;
  const parentUserId = params.message.parent_user_id?.trim();
  if (
    !params.message.channel ||
    !threadTs ||
    !parentUserId ||
    (parentUserId !== params.ctx.botUserId && parentUserId !== params.ctx.botId)
  ) {
    return undefined;
  }
  try {
    return await readSlackAssistantThreadContext({
      client: params.eventScope?.client ?? params.ctx.app.client,
      channelId: params.message.channel,
      threadTs,
    });
  } catch (err) {
    logVerbose(
      `slack assistant context restore failed channel=${params.message.channel} ts=${threadTs}: ${formatErrorMessage(err)}`,
    );
  }
  return undefined;
}

export function resolveCachedMentionRegexes(
  ctx: SlackMonitorContext,
  agentId: string | undefined,
  options?: Parameters<typeof buildMentionRegexes>[2],
): RegExp[] {
  const key = [
    normalizeOptionalString(agentId) ?? "__default__",
    normalizeOptionalString(options?.provider),
    normalizeOptionalString(options?.conversationId ?? undefined),
    options?.providerPolicy ? JSON.stringify(options.providerPolicy) : "",
  ].join("\u001f");
  const byAgent = getOrCreateWeakOwnerMap(mentionRegexCache, ctx);
  const cached = byAgent.get(key);
  if (cached) {
    return cached;
  }
  const built = buildMentionRegexes(ctx.cfg, agentId, options);
  byAgent.set(key, built);
  return built;
}

export type SlackInboundDropReason =
  | "bot-disabled"
  | "missing-user"
  | "missing-sender"
  | "channel-not-allowed"
  | "dm-disabled"
  | "dm-unauthorized"
  | "configured-binding-unavailable"
  | "ambiguous-thread"
  | "unauthorized-sender"
  | "unauthorized-bot"
  | "control-command-unauthorized"
  | "bot-missing-mention"
  | "mention-detection-unavailable"
  | "other-mention"
  | "missing-mention"
  | "empty-content"
  | "final-route-denied";

export function createSlackInboundDropReporter(params: Parameters<typeof prepareSlackMessage>[0]) {
  const { ctx, account, message, opts } = params;
  return (reason: SlackInboundDropReason, parentUserId?: string): null => {
    // Record this preparation attempt; a later message/app_mention twin can still dispatch.
    // Logical-message deduplication remains owned by the handler's dispatch claim.
    ctx.logger.info(
      {
        provider: "slack",
        accountId: account.accountId,
        teamId: opts.eventScope?.teamId ?? ctx.teamId,
        channelId: message.channel,
        messageTs: message.ts,
        source: opts.source,
        reason,
        ...(parentUserId ? { parentUserId } : {}),
      },
      "Slack inbound event rejected during preparation",
    );
    // A dropped DM is invisible to everyone but its sender, who sees only
    // silence, so every gate that ends one is named at warn level rather than
    // left to an info record nobody greps.
    if (normalizeSlackChannelType(message.channel_type, message.channel) === "im") {
      logSlackDroppedDirectMessage({
        accountId: account.accountId,
        channelId: message.channel,
        userId: message.user,
        messageTs: message.ts,
        reason,
      });
    }
    return null;
  };
}

const SLACK_ANY_MENTION_RE = /<@[^>]+>|<!subteam\^[^>]+>/;
const SLACK_USER_MENTION_RE = /<@([^>|]+)(?:\|[^>]+)?>/g;
const SLACK_SUBTEAM_MENTION_RE = /<!subteam\^([^>|]+)(?:\|[^>]+)?>/g;
const SLACK_SUBTEAM_MENTION_MARKER = "<!subteam^";

export function collectSlackMentionMetadata(messageText: string) {
  const mentionMetadata = {
    mentionedUserIds: collectSlackMentionIds(messageText, SLACK_USER_MENTION_RE),
    mentionedSubteamIds: collectSlackMentionIds(messageText, SLACK_SUBTEAM_MENTION_RE),
    hasAnyMention: SLACK_ANY_MENTION_RE.test(messageText),
    hasSubteamMention: messageText.includes(SLACK_SUBTEAM_MENTION_MARKER),
  };
  return mentionMetadata;
}
