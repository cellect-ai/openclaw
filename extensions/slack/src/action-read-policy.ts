import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { ResolvedSlackAccount } from "./accounts.js";
import type { SlackActionContext } from "./action-context.js";
import type { SlackConversationInfo } from "./channel-type.js";
const loadSlackAccountsRuntime = createLazyRuntimeModule(() => import("./accounts.js"));
import { normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { slackActionRuntime } from "./action-runtime-bindings.js";
import { buildSlackChannelIdCandidates, hasPotentialSlackNamedPolicy } from "./group-policy.js";
import { getSlackInstallationKind } from "./installation-identity-state.js";
import { resolveSlackChannelConfig } from "./monitor/channel-config.js";
import { isSlackChannelAllowedByPolicy } from "./monitor/policy.js";
import { readSlackPlatformErrorCode, resolveSlackReadRequester } from "./read-requester.js";
import { formatSlackTarget } from "./target-parsing.js";
import { parseSlackTarget, slackContextTargetsMatch } from "./targets.js";

export type ConversationReadInvocationOrigin = NonNullable<
  ChannelMessageActionContext["conversationReadOrigin"]
>;

export function resolveSlackDmReadAllowed(account: ResolvedSlackAccount): boolean {
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  return account.config.dm?.enabled !== false && dmPolicy !== "disabled";
}

export function normalizeConfiguredSlackDmUserId(value: unknown): string | undefined {
  const target = parseSlackTarget(String(value), { defaultKind: "user" });
  if (target?.kind !== "user") {
    return undefined;
  }
  const userId = target.id.trim().toLowerCase();
  return /^[uw][a-z0-9]+$/i.test(userId) ? userId : undefined;
}

export async function isSlackDmTargetConfigured(params: {
  account: ResolvedSlackAccount;
  cfg: OpenClawConfig;
  channelId: string;
  userId?: string;
}): Promise<boolean> {
  const defaultTo = params.account.config.defaultTo?.trim();
  if (
    defaultTo &&
    slackContextTargetsMatch(params.channelId, {
      currentChannelId: defaultTo,
    })
  ) {
    return true;
  }
  const userId = normalizeConfiguredSlackDmUserId(params.userId);
  if (!userId) {
    return false;
  }
  const { resolveSlackAccountAllowFrom } = await loadSlackAccountsRuntime();
  const configuredUsers = [
    ...(resolveSlackAccountAllowFrom({
      cfg: params.cfg,
      accountId: params.account.accountId,
    }) ?? []),
    ...Object.keys(params.account.config.dms ?? {}),
    ...(defaultTo ? [defaultTo] : []),
  ];
  return configuredUsers.some((entry) => normalizeConfiguredSlackDmUserId(entry) === userId);
}

export function hasSlackRequesterAccount(
  account: ResolvedSlackAccount,
  context?: SlackActionContext,
) {
  const requesterAccountId = context?.requesterAccountId?.trim();
  return Boolean(
    normalizeOptionalLowercaseString(context?.currentChannelProvider) === "slack" &&
    requesterAccountId &&
    normalizeAccountId(requesterAccountId) === normalizeAccountId(account.accountId),
  );
}

export function assertSlackMemberInfoAllowed(params: {
  account: ResolvedSlackAccount;
  context?: SlackActionContext;
  userId: string;
}) {
  if (params.context?.conversationReadOrigin === "direct-operator") {
    return;
  }
  // Operator-trusted accounts may resolve any member of their own workspace;
  // the workspace itself is still pinned by the trusted current team below.
  if (params.account.config.memberInfoScope === "workspace") {
    return;
  }
  const requesterSenderId = normalizeOptionalLowercaseString(params.context?.requesterSenderId);
  if (
    !hasSlackRequesterAccount(params.account, params.context) ||
    !requesterSenderId ||
    requesterSenderId !== normalizeOptionalLowercaseString(params.userId)
  ) {
    throw new Error("Delegated Slack member info is limited to the current requester.");
  }
}

export function resolveSlackChannelReadPolicy(params: {
  account: ResolvedSlackAccount;
  cfg: OpenClawConfig;
  channelId: string;
  teamId?: string;
  channelName?: string;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  metadataResolved?: boolean;
  currentConversation?: boolean;
}) {
  const channels = params.account.config.channels;
  const channelKeys = Object.keys(channels ?? {});
  const channelConfig = resolveSlackChannelConfig({
    teamId: params.teamId,
    allowUnscoped: getSlackInstallationKind(params.account.accountId) !== "enterprise",
    channelId: params.channelId,
    channelName: params.channelName,
    channels,
    channelKeys,
    allowNameMatching: params.account.config.dangerouslyAllowNameMatching,
    defaultRequireMention: params.account.config.requireMention,
  });
  const channelAllowed = channelConfig?.allowed !== false;
  const channelExplicitlyDisabled = !channelAllowed && channelConfig?.matchSource === "direct";
  const channelWildcardDisabled = !channelAllowed && channelConfig?.matchSource === "wildcard";
  const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.slack !== undefined,
    groupPolicy: params.account.config.groupPolicy,
    defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy,
  });
  const policyAllowed = isSlackChannelAllowedByPolicy({
    groupPolicy,
    channelAllowlistConfigured: channelKeys.length > 0,
    channelAllowed,
  });
  const delegatedChannelAllowed =
    policyAllowed && !(!channelAllowed && (groupPolicy !== "open" || channelConfig?.matchSource));
  const directChannelAllowed =
    groupPolicy !== "disabled" && !channelExplicitlyDisabled && !channelWildcardDisabled;
  const baseChannelAllowed =
    params.conversationReadOrigin === "direct-operator" || params.currentConversation
      ? directChannelAllowed
      : delegatedChannelAllowed;
  const allowNameMatching = params.account.config.dangerouslyAllowNameMatching;
  const shouldResolveName =
    !params.metadataResolved &&
    !params.channelName &&
    ((baseChannelAllowed &&
      channelConfig?.matchSource !== "direct" &&
      hasPotentialSlackNamedPolicy({
        channels,
        allowNameMatching,
        decision: "deny",
      })) ||
      (!baseChannelAllowed &&
        groupPolicy !== "disabled" &&
        !channelExplicitlyDisabled &&
        hasPotentialSlackNamedPolicy({
          channels,
          allowNameMatching,
          decision: "allow",
        })));
  return {
    channelAllowed: baseChannelAllowed,
    channelExplicitlyDisabled,
    channelReadsDisabled:
      groupPolicy === "disabled" || channelExplicitlyDisabled || channelWildcardDisabled,
    groupDmAllowed:
      params.account.config.dm?.enabled !== false &&
      params.account.config.dm?.groupEnabled === true &&
      (params.currentConversation ||
        isSlackGroupDmTargetConfigured(params.account, params.channelId, params.teamId)),
    shouldResolveName,
  };
}

export type SlackRequesterReadOpts = {
  cfg: OpenClawConfig;
  accountId?: string;
  token?: string;
  teamId?: string;
};

export async function assertSlackRequesterMember(params: {
  account: ResolvedSlackAccount;
  cfg: OpenClawConfig;
  channelId: string;
  teamId?: string;
  context?: SlackActionContext;
  readOpts: SlackRequesterReadOpts;
  preparedWorkspaceId?: string;
  info?: SlackConversationInfo;
}): Promise<void> {
  const requesterId = await resolveSlackReadRequester(
    params.account.accountId,
    params.context,
    params.readOpts,
    params.preparedWorkspaceId,
  );
  params.context?.assertDirectAdapterHandoff?.();
  if (!requesterId) {
    throw new Error("Slack read target channel is not allowed.");
  }
  const info =
    params.info ??
    (/^[DG]/i.test(params.channelId)
      ? await slackActionRuntime.resolveSlackConversationInfo({
          cfg: params.cfg,
          accountId: params.account.accountId,
          channelId: params.channelId,
          teamId: params.teamId,
          operation: "read",
          assertDirectAdapterHandoff: params.context?.assertDirectAdapterHandoff,
        })
      : undefined);
  let member: boolean;
  if (info?.type === "dm") {
    member = info.user?.toUpperCase() === requesterId;
  } else {
    try {
      member = await slackActionRuntime.isSlackConversationMember(
        params.channelId,
        requesterId,
        params.readOpts,
      );
    } catch (error) {
      const code = readSlackPlatformErrorCode(error) ?? "unknown_error";
      throw new Error(
        `Slack read target channel is not allowed: this Slack app cannot see conversation ${params.channelId} (${code}). ` +
          "It is usually a DM or private channel the bot is not in. Ask the requester to forward the message or share the file into this conversation.",
        { cause: error },
      );
    }
  }
  if (!member) {
    throw new Error(
      `Slack read target channel is not allowed: the requester is not a member of conversation ${params.channelId}.`,
    );
  }
}

export async function assertSlackReadTargetAllowed(
  params: Parameters<typeof assertSlackReadTargetPolicy>[0] & {
    personScope?: { readOpts: SlackRequesterReadOpts; preparedWorkspaceId?: string };
  },
): Promise<void> {
  const membership = { verified: false };
  await assertSlackReadTargetPolicy({ ...params, membership });
  // A target the policy admitted only through membership was already checked.
  if (params.personScope && !membership.verified) {
    await assertSlackRequesterMember({ ...params, ...params.personScope });
  }
}

export async function assertSlackReadTargetPolicy(params: {
  account: ResolvedSlackAccount;
  cfg: OpenClawConfig;
  channelId: string;
  teamId?: string;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  context?: SlackActionContext;
  /**
   * Read-only callers may also admit a conversation the trusted requester
   * belongs to (a pasted permalink). Writes never pass this.
   */
  requesterMembership?: {
    readOpts: { cfg: OpenClawConfig; accountId?: string; token?: string; teamId?: string };
    preparedWorkspaceId?: string;
  };
  /** Set when the requester's membership was proven on the way. */
  membership?: { verified: boolean };
}) {
  const deny = () => {
    throw new Error("Slack read target channel is not allowed.");
  };
  // Policy said no. Admit the target only when the trusted requester is a
  // member of it; explicit channel or DM disables never reach this path.
  const denyUnlessRequesterMember = async (info?: SlackConversationInfo): Promise<void> => {
    const read = params.requesterMembership;
    const requesterId = read
      ? await resolveSlackReadRequester(
          params.account.accountId,
          params.context,
          read.readOpts,
          read.preparedWorkspaceId,
        )
      : undefined;
    params.context?.assertDirectAdapterHandoff?.();
    if (!requesterId || !read) {
      return deny();
    }
    let member: boolean;
    if (info?.type === "dm") {
      member = info.user?.toUpperCase() === requesterId;
    } else {
      try {
        member = await slackActionRuntime.isSlackConversationMember(
          params.channelId,
          requesterId,
          read.readOpts,
        );
      } catch (error) {
        const code = readSlackPlatformErrorCode(error) ?? "unknown_error";
        throw new Error(
          `Slack read target channel is not allowed: this Slack app cannot see conversation ${params.channelId} (${code}). ` +
            "It is usually a DM or private channel the bot is not in. Ask the requester to forward the message or share the file into this conversation.",
          { cause: error },
        );
      }
    }
    if (!member) {
      throw new Error(
        `Slack read target channel is not allowed: the requester is not a member of conversation ${params.channelId}.`,
      );
    }
    if (params.membership) {
      params.membership.verified = true;
    }
  };
  const target = formatSlackTarget({
    teamId: params.teamId,
    kind: "channel",
    id: params.channelId,
  });
  const currentConversation = Boolean(
    hasSlackRequesterAccount(params.account, params.context) &&
    params.context &&
    slackContextTargetsMatch(target, params.context),
  );
  const directOperator = params.conversationReadOrigin === "direct-operator";
  if (/^D/i.test(params.channelId)) {
    if (!resolveSlackDmReadAllowed(params.account)) {
      deny();
    }
    if (directOperator || currentConversation) {
      return;
    }
    const info = await slackActionRuntime.resolveSlackConversationInfo({
      cfg: params.cfg,
      accountId: params.account.accountId,
      channelId: params.channelId,
      teamId: params.teamId,
      operation: "read",
      assertDirectAdapterHandoff: params.context?.assertDirectAdapterHandoff,
    });
    if (
      info.type !== "dm" ||
      !(await isSlackDmTargetConfigured({
        ...params,
        userId: info.user,
      }))
    ) {
      await denyUnlessRequesterMember(info);
    }
    return;
  }

  const preliminary = resolveSlackChannelReadPolicy({
    ...params,
    currentConversation,
  });
  if (
    preliminary.channelExplicitlyDisabled ||
    (preliminary.channelReadsDisabled &&
      !preliminary.shouldResolveName &&
      /^C/i.test(params.channelId))
  ) {
    deny();
  }
  const needsMetadata =
    preliminary.shouldResolveName ||
    preliminary.channelAllowed !== preliminary.groupDmAllowed ||
    preliminary.channelReadsDisabled;
  if (!needsMetadata) {
    if (!preliminary.channelAllowed) {
      await denyUnlessRequesterMember();
    }
    return;
  }

  const info: SlackConversationInfo = await slackActionRuntime.resolveSlackConversationInfo({
    cfg: params.cfg,
    accountId: params.account.accountId,
    channelId: params.channelId,
    teamId: params.teamId,
    operation: "read",
    ...(preliminary.shouldResolveName ? { requireFreshName: true } : {}),
    assertDirectAdapterHandoff: params.context?.assertDirectAdapterHandoff,
  });
  const resolved = resolveSlackChannelReadPolicy({
    ...params,
    channelName: info.name,
    metadataResolved: true,
    currentConversation,
  });
  if (
    resolved.channelExplicitlyDisabled ||
    (resolved.channelReadsDisabled && (info.type === "channel" || info.type === "unknown"))
  ) {
    deny();
  }
  if (
    preliminary.shouldResolveName &&
    (info.type === "channel" || info.type === "unknown") &&
    !info.name
  ) {
    await denyUnlessRequesterMember(info);
    return;
  }
  if (info.type === "dm") {
    if (!resolveSlackDmReadAllowed(params.account)) {
      deny();
    }
    if (
      !directOperator &&
      !currentConversation &&
      !(await isSlackDmTargetConfigured({
        ...params,
        userId: info.user,
      }))
    ) {
      await denyUnlessRequesterMember(info);
    }
    return;
  }
  if (
    info.type === "group" &&
    (params.account.config.dm?.enabled === false ||
      params.account.config.dm?.groupEnabled === false)
  ) {
    deny();
  }
  const allowed =
    info.type === "channel"
      ? resolved.channelAllowed
      : info.type === "group"
        ? resolved.groupDmAllowed
        : resolved.channelAllowed && resolved.groupDmAllowed;
  if (!allowed) {
    await denyUnlessRequesterMember(info);
  }
}

export function isSlackGroupDmTargetConfigured(
  account: ResolvedSlackAccount,
  channelId: string,
  teamId?: string,
): boolean {
  const entries = account.config.dm?.groupChannels ?? [];
  if (entries.length === 0) {
    return true;
  }
  const candidates = new Set(
    buildSlackChannelIdCandidates(channelId, teamId, {
      allowUnscoped: getSlackInstallationKind(account.accountId) !== "enterprise",
    }).map((candidate) => candidate.toLowerCase()),
  );
  const target = channelId.trim().toLowerCase();
  return entries.some((entry) => {
    const candidate = String(entry).trim().toLowerCase();
    return (
      candidate === "*" ||
      candidates.has(candidate) ||
      candidate === target ||
      candidate === `slack:${target}` ||
      candidate === `channel:${target}` ||
      candidate === `group:${target}` ||
      candidate === `mpim:${target}`
    );
  });
}
