// Slack mentions the bot will not act on: tell the requester once, and log the ones nobody answered.
import { createDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { createSubsystemLogger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { mergeSlackAccountConfig } from "../accounts.js";
import { formatSlackError } from "../errors.js";
import type { SlackMonitorContext } from "./context.js";
import type { SlackEventScope } from "./event-scope.js";
import { escapeSlackMrkdwn } from "./mrkdwn.js";

export type SlackUnansweredMentionReason =
  | "channel-not-allowed"
  | "sender-not-allowed"
  | "not-a-request-user";

const UNREADABLE_DM_REPLY_TEXT =
  "I couldn’t read that message — there was no text in it I could use. Could you send it as text, or add a line describing what you need?";

const SLACK_CHANNEL_ACCESS_DOCS_URL =
  "https://docs.openclaw.ai/channels/slack#access-control-and-routing";
const NOTICE_RATE_LIMIT_MS = 60 * 60 * 1_000;
const DEFAULT_ALERT_AFTER_MINUTES = 10;
const MAX_PENDING_MENTIONS = 1_000;

// Journal-greppable, like the `[slack] inbound` receipts, so alerting can key on it.
// Created on first use so importing this module has no logging side effects.
let unansweredMentionLogger: ReturnType<typeof createSubsystemLogger> | undefined;
const unansweredMentionLog = () =>
  (unansweredMentionLogger ??=
    createSubsystemLogger("gateway/channels/slack").child("unanswered-mention"));
// Per monitor context, so each account rate-limits its own notices.
const noticeLimits = new WeakMap<SlackMonitorContext, ReturnType<typeof createDedupeCache>>();
const pendingMentions = new Map<string, ReturnType<typeof setTimeout>>();

function resolveUnansweredMentionConfig(ctx: SlackMonitorContext) {
  return ctx.cfg ? mergeSlackAccountConfig(ctx.cfg, ctx.accountId).unansweredMentions : undefined;
}

function buildNoticeText(params: {
  subject: string;
  reason: SlackUnansweredMentionReason;
  contact?: string;
}): string {
  const { subject, contact } = params;
  switch (params.reason) {
    case "channel-not-allowed":
      return `${subject} can’t reply here because this channel isn’t in its OpenClaw channel allowlist. ${contact ?? "Ask the OpenClaw owner to allow this channel."} <${SLACK_CHANNEL_ACCESS_DOCS_URL}|Learn how to configure Slack channel access.>`;
    case "sender-not-allowed":
      return `${subject} can’t act on your request here because you aren’t on its list of allowed users for this channel. ${contact ?? "Ask the OpenClaw owner for access."}`;
    case "not-a-request-user":
      return `${subject} noted your message as context, but it only takes requests in this channel from approved requesters. ${contact ?? "Ask one of them, or the OpenClaw owner, to make the request."}`;
  }
  return subject;
}

async function resolveBotSubject(ctx: SlackMonitorContext, eventScope?: SlackEventScope) {
  if (!ctx.botUserId) {
    return "This OpenClaw bot";
  }
  try {
    const botName = normalizeOptionalString(
      (await ctx.resolveUserName(ctx.botUserId, eventScope))?.name,
    );
    return botName ? escapeSlackMrkdwn(botName) : "This OpenClaw bot";
  } catch (error) {
    logVerbose(`slack mention notice bot-name lookup failed: ${formatSlackError(error)}`);
    return "This OpenClaw bot";
  }
}

/**
 * Tells a user, ephemerally, why the bot will not act on their explicit
 * mention. At most one notice per user and channel per hour; sends nothing if
 * Slack rejects the ephemeral message.
 */
export async function noticeSlackUnansweredMention(params: {
  ctx: SlackMonitorContext;
  channelId: string;
  userId: string;
  messageTs?: string;
  reason: SlackUnansweredMentionReason;
  eventScope?: SlackEventScope;
}): Promise<boolean> {
  const { ctx, channelId, userId, reason, eventScope } = params;
  const teamId = eventScope?.teamId ?? ctx.teamId;
  unansweredMentionLog().warn(
    `Unanswered mention account=${ctx.accountId} channel=${channelId} user=${userId} ts=${params.messageTs ?? "unknown"} reason=${reason}`,
  );
  const config = resolveUnansweredMentionConfig(ctx);
  if (config?.notice === false) {
    return false;
  }
  let limits = noticeLimits.get(ctx);
  if (!limits) {
    limits = createDedupeCache({ ttlMs: NOTICE_RATE_LIMIT_MS, maxSize: 2_000 });
    noticeLimits.set(ctx, limits);
  }
  const limitKey = `${teamId}:${channelId}:${userId}`;
  if (limits.check(limitKey)) {
    return false;
  }
  try {
    await (eventScope?.client ?? ctx.app.client).chat.postEphemeral({
      token: ctx.botToken,
      channel: channelId,
      user: userId,
      text: buildNoticeText({
        subject: await resolveBotSubject(ctx, eventScope),
        reason,
        contact: normalizeOptionalString(config?.contact),
      }),
    });
    return true;
  } catch (error) {
    // Let the next mention retry: nothing reached the user.
    limits.delete(limitKey);
    ctx.runtime.error?.(
      `slack ${reason === "channel-not-allowed" ? "allowlist denial" : "mention"} notice failed for channel ${channelId}: ${formatSlackError(error)}`,
    );
    return false;
  }
}

/**
 * Records a DM that produced no turn.
 *
 * A room mention that goes nowhere is at least visible to the room; a dropped
 * DM is seen by nobody, so every path that ends one without a turn says so
 * here, on the same greppable subsystem as the unanswered-mention receipts.
 */
export function logSlackDroppedDirectMessage(params: {
  accountId: string;
  channelId: string;
  userId?: string;
  messageTs?: string;
  reason: string;
}): void {
  unansweredMentionLog().warn(
    `Dropped direct message account=${params.accountId} channel=${params.channelId} user=${params.userId ?? "unknown"} ts=${params.messageTs ?? "unknown"} reason=${params.reason}`,
  );
}

/**
 * Tells a DM sender that their message could not be read, so a message with no
 * usable text is answered rather than met with silence.
 *
 * At most one reply per sender and conversation per hour, on the same throttle
 * as the mention notices: a sender who pastes five images in a row gets one
 * answer, not five. Returns whether the sender was actually told.
 */
export async function noticeSlackUnreadableDirectMessage(params: {
  ctx: SlackMonitorContext;
  channelId: string;
  userId: string;
  threadTs?: string;
  eventScope?: SlackEventScope;
}): Promise<boolean> {
  const { ctx, channelId, userId, eventScope } = params;
  const config = resolveUnansweredMentionConfig(ctx);
  if (config?.notice === false) {
    return false;
  }
  let limits = noticeLimits.get(ctx);
  if (!limits) {
    limits = createDedupeCache({ ttlMs: NOTICE_RATE_LIMIT_MS, maxSize: 2_000 });
    noticeLimits.set(ctx, limits);
  }
  const teamId = eventScope?.teamId ?? ctx.teamId;
  const limitKey = `unreadable:${teamId}:${channelId}:${userId}`;
  if (limits.check(limitKey)) {
    return false;
  }
  try {
    const chat = (eventScope?.client ?? ctx.app.client).chat;
    // Bound rather than called inline, as in `client-delivery.ts`: this is
    // Slack's `chat.postMessage`, which the window-postMessage lint rule
    // otherwise claims is missing a target origin.
    const postChatMessage = chat.postMessage.bind(chat);
    // A real message, not an ephemeral one: the sender must still be able to
    // see why they never got an answer after a reload.
    await postChatMessage({
      token: ctx.botToken,
      channel: channelId,
      text: UNREADABLE_DM_REPLY_TEXT,
      ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
    });
    return true;
  } catch (error) {
    // Let the next message retry: nothing reached the sender.
    limits.delete(limitKey);
    ctx.runtime.error?.(
      `slack unreadable-dm notice failed for channel ${channelId}: ${formatSlackError(error)}`,
    );
    return false;
  }
}

function pendingMentionKey(params: { accountId: string; channelId: string; messageTs: string }) {
  return `${params.accountId}:${params.channelId}:${params.messageTs}`;
}

/**
 * Starts the unanswered-mention clock for an admitted explicit mention. If no
 * reply is delivered within `unansweredMentions.alertAfterMinutes`, it is logged.
 */
export function trackSlackPrincipalMention(params: {
  ctx: SlackMonitorContext;
  channelId: string;
  messageTs: string;
  userId?: string;
}): void {
  const minutes =
    resolveUnansweredMentionConfig(params.ctx)?.alertAfterMinutes ?? DEFAULT_ALERT_AFTER_MINUTES;
  if (!(minutes > 0)) {
    return;
  }
  const key = pendingMentionKey({ accountId: params.ctx.accountId, ...params });
  if (pendingMentions.has(key)) {
    return;
  }
  if (pendingMentions.size >= MAX_PENDING_MENTIONS) {
    const oldestKey = pendingMentions.keys().next().value;
    if (oldestKey !== undefined) {
      clearTimeout(pendingMentions.get(oldestKey));
      pendingMentions.delete(oldestKey);
    }
  }
  const timer = setTimeout(() => {
    pendingMentions.delete(key);
    unansweredMentionLog().warn(
      `Unanswered mention account=${params.ctx.accountId} channel=${params.channelId} user=${params.userId ?? "unknown"} ts=${params.messageTs} reason=no-reply-after-${minutes}m`,
    );
  }, minutes * 60_000);
  timer.unref?.();
  pendingMentions.set(key, timer);
}

/** Stops the clock once a reply to the mention was delivered. */
export function resolveSlackPrincipalMention(params: {
  accountId: string;
  channelId: string;
  messageTs: string;
}): void {
  const key = pendingMentionKey(params);
  clearTimeout(pendingMentions.get(key));
  pendingMentions.delete(key);
}

export function clearSlackPendingMentionsForTest(): void {
  for (const timer of pendingMentions.values()) {
    clearTimeout(timer);
  }
  pendingMentions.clear();
}
