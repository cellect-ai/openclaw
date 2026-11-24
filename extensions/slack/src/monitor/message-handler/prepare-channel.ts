import { resolveSlackChannelConfig } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import { normalizeSlackChannelType } from "../context.js";
import { noticeSlackUnansweredMention } from "../unanswered-mentions.js";
import type { prepareSlackMessage } from "./prepare.js";
export async function resolveSlackInboundChannel(
  params: Parameters<typeof prepareSlackMessage>[0],
) {
  const { ctx, message, opts } = params;
  const conversationEventScope = opts.eventScope;
  let channelInfo: Awaited<ReturnType<SlackMonitorContext["resolveChannelName"]>> = {};
  let resolvedChannelType = normalizeSlackChannelType(message.channel_type, message.channel);
  // D-prefixed channels are always direct messages. Skip channel lookups in
  // that common path to avoid an unnecessary API round-trip.
  if (resolvedChannelType !== "im" && message.channel_type !== "im") {
    channelInfo = await ctx.resolveChannelName(message.channel, conversationEventScope);
    resolvedChannelType = normalizeSlackChannelType(
      message.channel_type ??
        channelInfo.type ??
        ctx.recallSlackChannelType(message.channel, conversationEventScope),
      message.channel,
    );
  }
  const channelName = channelInfo.name;
  const isDirectMessage = resolvedChannelType === "im";
  const isGroupDm = resolvedChannelType === "mpim";
  const isRoom = resolvedChannelType === "channel" || resolvedChannelType === "group";
  const isRoomish = isRoom || isGroupDm;
  const channelConfig = isRoom
    ? resolveSlackChannelConfig({
        teamId: conversationEventScope?.teamId ?? ctx.teamId,
        allowUnscoped: ctx.installationIdentity?.kind !== "enterprise",
        channelId: message.channel,
        channelName,
        channels: ctx.channelsConfig,
        channelKeys: ctx.channelsConfigKeys,
        defaultRequireMention: ctx.defaultRequireMention,
        allowNameMatching: ctx.allowNameMatching,
      })
    : null;

  return {
    channelInfo,
    resolvedChannelType,
    channelName,
    isDirectMessage,
    isGroupDm,
    isRoom,
    isRoomish,
    channelConfig,
  };
}

export async function admitSlackInboundChannel(
  params: Parameters<typeof prepareSlackMessage>[0],
  channel: Awaited<ReturnType<typeof resolveSlackInboundChannel>>,
  flags: { explicitBotMention: boolean; isBotMessage: boolean },
) {
  const { ctx, message, opts } = params;
  const { channelName, resolvedChannelType, isRoom } = channel;
  const { explicitBotMention, isBotMessage } = flags;
  const authorizationEventScope = opts.eventScope;
  const onVisibleDrop = opts.onVisibleDrop;
  if (
    !ctx.isChannelAllowed({
      teamId: authorizationEventScope?.teamId ?? ctx.teamId,
      channelId: message.channel,
      channelName,
      channelType: resolvedChannelType,
    })
  ) {
    if (
      isRoom &&
      ctx.groupPolicy === "allowlist" &&
      explicitBotMention &&
      !isBotMessage &&
      message.user &&
      (await noticeSlackUnansweredMention({
        ctx,
        channelId: message.channel,
        userId: message.user,
        messageTs: message.ts,
        reason: "channel-not-allowed",
        eventScope: authorizationEventScope,
      }))
    ) {
      onVisibleDrop?.();
    }
    return false;
  }

  return true;
}
