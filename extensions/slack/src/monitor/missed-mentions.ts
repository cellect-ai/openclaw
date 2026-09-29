// Slack Socket Mode delivers nothing that happened while the app was
// disconnected: Slack neither queues nor redelivers socket events, and the
// durable ingress queue can only replay what already reached this process. A
// mention posted during a restart, a crash or a broken deploy is therefore lost
// for good, with no reply and no notice — exactly how a principal's request
// went unanswered for 44h across the 2026.9.6 cutover.
//
// So the socket records that it is alive while connected, and on every
// (re)connect it re-reads the conversations it can see over the window it was
// away and replays what it missed through the normal message handler. Replayed
// messages take the same admission, ownership and unanswered-mention paths as
// live ones, and the persistent dispatch dedupe drops anything already handled.
//
// Direct messages are swept too, and first. A room mention that went unanswered
// at least sits where everyone can see it; a DM lost to the same outage is seen
// by nobody, which is how an external GC's messages were dropped on 2026-09-21
// and 2026-09-25 and only surfaced weeks later in a manual audit.
import type { WebClient } from "@slack/web-api";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createSubsystemLogger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { mergeSlackAccountConfig } from "../accounts.js";
import {
  collectSlackCursorPages,
  fetchSlackChannelListPage,
  fetchSlackDirectListPage,
} from "../cursor-pages.js";
import { formatSlackError } from "../errors.js";
import { getSlackRuntime } from "../runtime.js";
import { parseSlackMessageEvent, type SlackMessageEvent } from "../types.js";
import type { SlackMonitorContext } from "./context.js";

/** How often a connected socket refreshes its liveness mark. */
export const SLACK_LIVENESS_HEARTBEAT_MS = 60_000;
/**
 * Liveness marks outlive any plausible outage we would still replay, so a mark
 * is never expired out from under a recovery we would have wanted to run.
 */
const SLACK_LIVENESS_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const SLACK_LIVENESS_MAX_ENTRIES = 1_000;
/**
 * Below this the socket only blipped; Slack had nowhere to drop a message, so a
 * sweep would re-read history for nothing.
 */
const SLACK_RECOVERY_MIN_GAP_MS = 2 * SLACK_LIVENESS_HEARTBEAT_MS;
/** Default ceiling on how far back a reconnect will look. */
export const SLACK_RECOVERY_DEFAULT_WITHIN_MINUTES = 12 * 60;
/** Bounds on one sweep, so a long outage cannot turn into an unbounded API run. */
const SLACK_RECOVERY_MAX_CHANNELS = 200;
/**
 * Direct messages are swept before rooms and capped separately: a room mention
 * that went unanswered is at least visible to everyone in the room, while a
 * lost DM is seen by nobody at all.
 */
const SLACK_RECOVERY_MAX_DIRECT_CONVERSATIONS = 200;
const SLACK_RECOVERY_MAX_MESSAGES_PER_CHANNEL = 50;
const SLACK_RECOVERY_MAX_THREADS_PER_CHANNEL = 20;
/** Slack's conversations.* reads are tier 3 (~50/min); stay under it. */
const SLACK_RECOVERY_CALL_SPACING_MS = 1_200;

let missedMentionLogger: ReturnType<typeof createSubsystemLogger> | undefined;
const missedMentionLog = () =>
  (missedMentionLogger ??= createSubsystemLogger("gateway/channels/slack").child("missed-mention"));

/**
 * Undefined on a host without plugin state. Recovery is an enhancement over a
 * connection that already works, so a host that cannot persist a liveness mark
 * loses the replay, never the socket.
 */
export function openSlackSocketLivenessStore(): PluginStateKeyedStore<number> | undefined {
  try {
    return getSlackRuntime().state.openKeyedStore<number>({
      namespace: "socket-liveness",
      maxEntries: SLACK_LIVENESS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      defaultTtlMs: SLACK_LIVENESS_TTL_MS,
    });
  } catch (error) {
    logVerbose(`slack socket liveness store unavailable: ${formatSlackError(error)}`);
    return undefined;
  }
}

export function buildSlackLivenessKey(params: { accountId: string; teamId?: string }): string {
  return `${params.teamId?.trim() ?? ""}:${params.accountId}`;
}

function resolveRecoveryConfig(ctx: SlackMonitorContext) {
  const unanswered = ctx.cfg
    ? mergeSlackAccountConfig(ctx.cfg, ctx.accountId).unansweredMentions
    : undefined;
  const withinMinutes = unanswered?.recoverWithinMinutes ?? SLACK_RECOVERY_DEFAULT_WITHIN_MINUTES;
  return {
    enabled: unanswered?.recoverMissed !== false && withinMinutes > 0,
    windowMs: withinMinutes * 60_000,
  };
}

const sleep = async (ms: number) => {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
};

function slackTsToMs(ts: string | undefined): number | undefined {
  const seconds = Number.parseFloat(ts ?? "");
  return Number.isFinite(seconds) ? seconds * 1_000 : undefined;
}

function mentionsBot(text: string | undefined, botUserId: string | undefined): boolean {
  if (!botUserId || !text) {
    return false;
  }
  // Slack renders a user mention as <@U123> or <@U123|name>.
  return new RegExp(`<@${botUserId}(\\|[^>]*)?>`, "u").test(text);
}

type SlackRecoveryHistoryMessage = {
  text?: string;
  user?: string;
  ts?: string;
  subtype?: string;
  bot_id?: string;
};

/** A conversation this sweep may replay from, and how to judge its messages. */
type SlackRecoverableConversation = {
  channelId: string;
  /** `im` drops the mention requirement: a DM is addressed to the bot already. */
  kind: "channel" | "im";
};

/**
 * Anything this account posted itself, and anything any other app posted. A
 * replay must never feed the bot its own words back, and an app's post is not a
 * request even when it names the bot.
 */
function isNonHumanMessage(
  message: SlackRecoveryHistoryMessage,
  botUserId: string | undefined,
): boolean {
  return Boolean(message.bot_id) || (Boolean(botUserId) && message.user === botUserId);
}

function isWithinRecoveryWindow(message: SlackRecoveryHistoryMessage, oldestMs: number): boolean {
  // Joins, topic changes and edits carry a subtype; none of them is a request.
  if (message.subtype && message.subtype !== "file_share") {
    return false;
  }
  if (!message.user || !message.ts) {
    return false;
  }
  const postedMs = slackTsToMs(message.ts);
  return postedMs !== undefined && postedMs >= oldestMs;
}

/**
 * A history row only needs replaying when a human posted it, it names this bot,
 * and it landed inside the window the socket was away.
 */
function isRecoverableMention(params: {
  message: SlackRecoveryHistoryMessage;
  botUserId: string | undefined;
  oldestMs: number;
}): boolean {
  const { message } = params;
  if (isNonHumanMessage(message, params.botUserId)) {
    return false;
  }
  if (!isWithinRecoveryWindow(message, params.oldestMs)) {
    return false;
  }
  return mentionsBot(message.text, params.botUserId);
}

/**
 * In a DM there is nobody else to address, so `requireMention` does not apply
 * and every human message is a request. What replaces it is an answered check:
 * anything this account already replied past was handled before the socket
 * went away, and replaying it would answer the sender twice.
 */
function isRecoverableDirectMessage(params: {
  message: SlackRecoveryHistoryMessage;
  botUserId: string | undefined;
  oldestMs: number;
  answeredThroughMs: number | undefined;
}): boolean {
  const { message } = params;
  if (isNonHumanMessage(message, params.botUserId)) {
    return false;
  }
  if (!isWithinRecoveryWindow(message, params.oldestMs)) {
    return false;
  }
  const postedMs = slackTsToMs(message.ts);
  if (
    postedMs !== undefined &&
    params.answeredThroughMs !== undefined &&
    postedMs <= params.answeredThroughMs
  ) {
    return false;
  }
  return true;
}

/**
 * The newest timestamp this account posted in the rows just read. Only this
 * account counts: another app's post in the same DM answers nothing.
 */
function resolveAnsweredThroughMs(
  messages: readonly SlackRecoveryHistoryMessage[],
  botUserId: string | undefined,
): number | undefined {
  let answeredThroughMs: number | undefined;
  for (const message of messages) {
    if (!botUserId || message.user !== botUserId) {
      continue;
    }
    const postedMs = slackTsToMs(message.ts);
    if (
      postedMs !== undefined &&
      (answeredThroughMs === undefined || postedMs > answeredThroughMs)
    ) {
      answeredThroughMs = postedMs;
    }
  }
  return answeredThroughMs;
}

function toRecoveredEvent(params: {
  message: Record<string, unknown>;
  channelId: string;
  channelType: "channel" | "im";
  teamId?: string;
}): SlackMessageEvent | undefined {
  return parseSlackMessageEvent({
    ...params.message,
    type: "message",
    channel: params.channelId,
    channel_type: params.channelType,
    event_ts: params.message.ts,
    ...(params.teamId ? { team: params.teamId } : {}),
  });
}

/**
 * The conversations this bot is in and is allowed to answer in.
 *
 * Reuses the directory's own channel listing rather than a second Slack method,
 * so recovery needs no scope the deployed bot does not already hold. The
 * account's channel policy is applied unchanged, so recovery can never reach a
 * conversation a live event would have been refused.
 */
async function listRecoverableChannels(params: {
  client: WebClient;
  ctx: SlackMonitorContext;
}): Promise<SlackRecoverableConversation[]> {
  const listed = await collectSlackCursorPages({
    fetchPage: (cursor) => fetchSlackChannelListPage(params.client, cursor),
    collectPageItems: (response) => response.channels ?? [],
  });
  const channels: SlackRecoverableConversation[] = [];
  for (const channel of listed) {
    const channelId = channel.id;
    // Reading history of a conversation the bot never joined only earns a
    // not_in_channel per call.
    if (!channelId || channel.is_member !== true || channel.is_archived === true) {
      continue;
    }
    if (
      !params.ctx.isChannelAllowed({
        teamId: params.ctx.teamId,
        channelId,
        channelName: channel.name,
        channelType: channel.is_private ? "group" : "channel",
      })
    ) {
      continue;
    }
    channels.push({ channelId, kind: "channel" });
    if (channels.length >= SLACK_RECOVERY_MAX_CHANNELS) {
      break;
    }
  }
  return channels;
}

/**
 * The direct-message conversations this bot can answer in.
 *
 * Socket Mode never redelivers a DM either, and unlike a room mention a lost DM
 * is visible to nobody — the sender simply gets silence. `conversations.list`
 * reports an `im` with no name and no `is_member`, so the room filter cannot be
 * reused; the account's DM policy still decides through `isChannelAllowed`, and
 * the per-sender authorization runs later, in the message handler.
 */
async function listRecoverableDirectConversations(params: {
  client: WebClient;
  ctx: SlackMonitorContext;
}): Promise<SlackRecoverableConversation[]> {
  const listed = await collectSlackCursorPages({
    fetchPage: (cursor) => fetchSlackDirectListPage(params.client, cursor),
    collectPageItems: (response) => response.channels ?? [],
  });
  const conversations: SlackRecoverableConversation[] = [];
  for (const conversation of listed) {
    const channelId = conversation.id;
    if (!channelId || conversation.is_im !== true || conversation.is_user_deleted === true) {
      continue;
    }
    if (
      !params.ctx.isChannelAllowed({
        teamId: params.ctx.teamId,
        channelId,
        channelType: "im",
      })
    ) {
      continue;
    }
    conversations.push({ channelId, kind: "im" });
    if (conversations.length >= SLACK_RECOVERY_MAX_DIRECT_CONVERSATIONS) {
      missedMentionLog().warn(
        `Slack DM recovery reached its conversation cap account=${params.ctx.accountId} cap=${SLACK_RECOVERY_MAX_DIRECT_CONVERSATIONS}`,
      );
      break;
    }
  }
  return conversations;
}

/** Collects the messages one conversation received while the socket was away. */
async function collectMissedMentionsInChannel(params: {
  client: WebClient;
  ctx: SlackMonitorContext;
  conversation: SlackRecoverableConversation;
  oldestMs: number;
}): Promise<SlackMessageEvent[]> {
  const { client, ctx, oldestMs } = params;
  const { channelId, kind } = params.conversation;
  const oldest = (oldestMs / 1_000).toFixed(6);
  const recovered: SlackMessageEvent[] = [];
  const history = await client.conversations.history({
    channel: channelId,
    oldest,
    inclusive: false,
    limit: SLACK_RECOVERY_MAX_MESSAGES_PER_CHANNEL,
  });
  const messages = history.messages ?? [];
  // Scoped to the rows just read, so a thread's own replies decide that thread.
  const qualifies = (
    rows: readonly SlackRecoveryHistoryMessage[],
  ): ((message: SlackRecoveryHistoryMessage) => boolean) => {
    if (kind !== "im") {
      return (message) => isRecoverableMention({ message, botUserId: ctx.botUserId, oldestMs });
    }
    const answeredThroughMs = resolveAnsweredThroughMs(rows, ctx.botUserId);
    return (message) =>
      isRecoverableDirectMessage({
        message,
        botUserId: ctx.botUserId,
        oldestMs,
        answeredThroughMs,
      });
  };
  const isMissed = qualifies(messages);
  for (const message of messages) {
    if (isMissed(message)) {
      const event = toRecoveredEvent({
        message: message as Record<string, unknown>,
        channelId,
        channelType: kind,
        teamId: ctx.teamId,
      });
      if (event) {
        recovered.push(event);
      }
    }
  }
  // conversations.history returns thread parents only, so a mention posted as a
  // thread reply during the outage is invisible here. Re-read just the threads
  // that moved inside the window.
  const activeThreads = messages
    .filter((message) => {
      const latestReplyMs = slackTsToMs(message.latest_reply);
      return latestReplyMs !== undefined && latestReplyMs >= oldestMs;
    })
    .slice(0, SLACK_RECOVERY_MAX_THREADS_PER_CHANNEL);
  for (const parent of activeThreads) {
    if (!parent.ts) {
      continue;
    }
    await sleep(SLACK_RECOVERY_CALL_SPACING_MS);
    const replies = await client.conversations.replies({
      channel: channelId,
      ts: parent.ts,
      oldest,
      inclusive: false,
      limit: SLACK_RECOVERY_MAX_MESSAGES_PER_CHANNEL,
    });
    const replyMessages = replies.messages ?? [];
    const isMissedReply = qualifies(replyMessages);
    for (const reply of replyMessages) {
      if (reply.ts === parent.ts) {
        continue;
      }
      if (isMissedReply(reply)) {
        const event = toRecoveredEvent({
          message: reply as Record<string, unknown>,
          channelId,
          channelType: kind,
          teamId: ctx.teamId,
        });
        if (event) {
          recovered.push(event);
        }
      }
    }
  }
  return recovered;
}

export type SlackMissedMentionRecoveryResult = {
  channelsScanned: number;
  mentionsReplayed: number;
  directConversationsScanned: number;
  directMessagesReplayed: number;
};

/**
 * Replays the mentions and direct messages that arrived while this account's
 * socket was down.
 *
 * Returns without reading anything when the socket was only briefly away, when
 * there is no previous liveness mark (a first run has no outage to recover), or
 * when recovery is switched off.
 */
export async function recoverSlackMissedMentions(params: {
  ctx: SlackMonitorContext;
  client: WebClient;
  lastAliveAt: number | undefined;
  now?: number;
  dispatch: (message: SlackMessageEvent) => Promise<void>;
  abortSignal?: AbortSignal;
}): Promise<SlackMissedMentionRecoveryResult> {
  const { ctx, client, lastAliveAt } = params;
  const empty = {
    channelsScanned: 0,
    mentionsReplayed: 0,
    directConversationsScanned: 0,
    directMessagesReplayed: 0,
  };
  const now = params.now ?? Date.now();
  const { enabled, windowMs } = resolveRecoveryConfig(ctx);
  if (!enabled || lastAliveAt === undefined) {
    return empty;
  }
  const gapMs = now - lastAliveAt;
  if (gapMs < SLACK_RECOVERY_MIN_GAP_MS) {
    return empty;
  }
  // A long outage still only replays the tail: anything older is stale enough
  // that answering it now would be worse than leaving it to a human.
  const oldestMs = Math.max(lastAliveAt, now - windowMs);
  missedMentionLog().warn(
    `Recovering Slack mentions account=${ctx.accountId} offlineForMs=${gapMs} since=${new Date(oldestMs).toISOString()}`,
  );
  // Listed independently: a directory call that fails for rooms must not cost
  // the DM sweep, which is the half nobody else can see has gone missing.
  const listConversations = async (
    list: () => Promise<SlackRecoverableConversation[]>,
    label: string,
  ): Promise<SlackRecoverableConversation[]> => {
    try {
      return await list();
    } catch (error) {
      ctx.runtime.error?.(
        `slack missed-mention recovery could not list ${label}: ${formatSlackError(error)}`,
      );
      return [];
    }
  };
  // DMs first: they are the ones that vanish without a trace.
  const conversations = [
    ...(await listConversations(
      () => listRecoverableDirectConversations({ client, ctx }),
      "direct conversations",
    )),
    ...(await listConversations(() => listRecoverableChannels({ client, ctx }), "conversations")),
  ];
  let mentionsReplayed = 0;
  let channelsScanned = 0;
  let directMessagesReplayed = 0;
  let directConversationsScanned = 0;
  for (const conversation of conversations) {
    if (params.abortSignal?.aborted) {
      break;
    }
    const { channelId, kind } = conversation;
    const isDirect = kind === "im";
    try {
      const missed = await collectMissedMentionsInChannel({
        client,
        ctx,
        conversation,
        oldestMs,
      });
      if (isDirect) {
        directConversationsScanned += 1;
      } else {
        channelsScanned += 1;
      }
      for (const message of missed) {
        missedMentionLog().warn(
          `${isDirect ? "Missed direct message" : "Missed mention"} recovered account=${ctx.accountId} channel=${channelId} user=${message.user ?? "unknown"} ts=${message.ts ?? "unknown"} reason=socket-offline`,
        );
        // The dispatch dedupe owns "already handled"; a replay of a message this
        // account answered before the restart stops there, not here.
        await params.dispatch(message);
        if (isDirect) {
          directMessagesReplayed += 1;
        } else {
          mentionsReplayed += 1;
        }
      }
    } catch (error) {
      // One unreadable conversation must not abandon the rest of the sweep.
      logVerbose(
        `slack missed-mention recovery failed for channel ${channelId}: ${formatSlackError(error)}`,
      );
    }
    await sleep(SLACK_RECOVERY_CALL_SPACING_MS);
  }
  missedMentionLog().warn(
    `Slack mention recovery complete account=${ctx.accountId} channels=${channelsScanned} replayed=${mentionsReplayed} dms=${directConversationsScanned} dmsReplayed=${directMessagesReplayed}`,
  );
  return {
    channelsScanned,
    mentionsReplayed,
    directConversationsScanned,
    directMessagesReplayed,
  };
}
