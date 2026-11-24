import { normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SlackActionClientOpts, SlackActionContext } from "./action-context.js";
import type { SlackConversationInfo } from "./channel-type.js";
import { getOptionalSlackRuntime } from "./runtime.js";

/**
 * Returns the host-verified Slack sender for this action when it came from a
 * live Slack conversation on the same account; undefined for delegated,
 * detached, or cross-account callers.
 */
function resolveTrustedSlackRequesterId(
  accountId: string,
  context?: SlackActionContext,
): string | undefined {
  const requesterAccountId = context?.requesterAccountId?.trim();
  const requesterSenderId = context?.requesterSenderId?.trim();
  if (
    normalizeOptionalLowercaseString(context?.currentChannelProvider) !== "slack" ||
    !requesterAccountId ||
    normalizeAccountId(requesterAccountId) !== normalizeAccountId(accountId) ||
    !requesterSenderId ||
    !/^[UW][A-Z0-9]+$/i.test(requesterSenderId)
  ) {
    return undefined;
  }
  return requesterSenderId.toUpperCase();
}

async function resolveSlackReadWorkspace(
  context: SlackActionContext | undefined,
  readOpts: SlackActionClientOpts,
): Promise<{ workspaceId: string; enterprise: boolean } | undefined> {
  // Authenticate the token actually used for this read. A companion bot's
  // installation identity cannot establish the workspace of a user read token.
  const { getClient } = await import("./actions.js");
  const { resolveSlackInstallationIdentity } = await import("./monitor/enterprise-install.js");
  const auth = await (await getClient(readOpts)).auth.test();
  context?.assertDirectAdapterHandoff?.();
  if (!auth.ok) {
    return undefined;
  }
  const installation = resolveSlackInstallationIdentity({ auth });
  const workspaceId =
    installation.kind === "enterprise"
      ? readOpts.teamId?.trim().toUpperCase()
      : installation.kind === "workspace"
        ? installation.teamId.trim().toUpperCase()
        : undefined;
  if (!workspaceId || (readOpts.teamId && readOpts.teamId.toUpperCase() !== workspaceId)) {
    return undefined;
  }
  return { workspaceId, enterprise: installation.kind === "enterprise" };
}

/** A candidate account becomes authorized only after its read token proves the bound workspace. */
export async function prepareMatrixSlackRead(params: {
  cfg: OpenClawConfig;
  accountId: string;
  channelId: string;
  context?: SlackActionContext;
  readOpts: SlackActionClientOpts;
  resolveConversation: () => Promise<SlackConversationInfo>;
}): Promise<string | undefined> {
  const { context } = params;
  if (
    normalizeOptionalLowercaseString(context?.currentChannelProvider) !== "matrix" ||
    context?.conversationReadOrigin === "direct-operator"
  ) {
    return undefined;
  }
  const deny = () =>
    new Error("Slack read target channel is not allowed: no matching agent account binding.");
  if (
    !context?.agentId ||
    !context.sessionKey ||
    !context.requesterAccountId ||
    !context.requesterSenderId
  ) {
    throw deny();
  }
  const workspace = await resolveSlackReadWorkspace(context, params.readOpts);
  if (!workspace) {
    throw deny();
  }
  const info = /^[DG]/i.test(params.channelId)
    ? await params.resolveConversation()
    : { type: "channel" as const };
  context.assertDirectAdapterHandoff?.();
  if (info.type === "unknown" || (info.type === "dm" && !info.user)) {
    throw deny();
  }
  const kind = info.type === "dm" ? "direct" : info.type;
  const peerId = info.type === "dm" ? (info.user ?? params.channelId) : params.channelId;
  const [
    { resolveAgentRoute, normalizeAgentId },
    { normalizeSlackRouteBindingConfig },
    { qualifySlackRoutePeerId },
  ] = await Promise.all([
    import("openclaw/plugin-sdk/routing"),
    import("./conversation-binding-route.js"),
    import("./monitor/workspace-routing.js"),
  ]);
  context.assertDirectAdapterHandoff?.();
  const cfg = normalizeSlackRouteBindingConfig(params.cfg);
  const routeInput: Omit<Parameters<typeof resolveAgentRoute>[0], "cfg"> = {
    // Unmatched routes remain denials without consulting an ambient agent default.
    defaultAgentId: context.agentId,
    channel: "slack",
    accountId: params.accountId,
    teamId: workspace.workspaceId,
    peer: {
      kind,
      id: qualifySlackRoutePeerId({
        id: peerId,
        kind: kind === "direct" ? "user" : "channel",
        eventScope: workspace.enterprise ? { teamId: workspace.workspaceId } : undefined,
      }),
    },
  };
  const explicitAccountRoute = resolveAgentRoute({
    ...routeInput,
    cfg: {
      ...cfg,
      bindings: cfg.bindings?.filter((binding) => {
        const accountId = binding.match.accountId?.trim();
        return Boolean(
          accountId &&
          accountId !== "*" &&
          normalizeAccountId(accountId) === normalizeAccountId(params.accountId),
        );
      }),
    },
  });
  const route = resolveAgentRoute({ ...routeInput, cfg });
  const agentId = normalizeAgentId(context.agentId);
  if (
    explicitAccountRoute.matchedBy === "default" ||
    explicitAccountRoute.agentId !== agentId ||
    route.matchedBy === "default" ||
    route.agentId !== agentId
  ) {
    throw deny();
  }
  return workspace.workspaceId;
}

/** Identity mapping is read-only; the source provider and account stay intact. */
export async function resolveSlackReadRequester(
  accountId: string,
  context: SlackActionContext | undefined,
  readOpts: SlackActionClientOpts,
  preparedWorkspaceId?: string,
): Promise<string | undefined> {
  if (normalizeOptionalLowercaseString(context?.currentChannelProvider) === "slack") {
    return resolveTrustedSlackRequesterId(accountId, context);
  }
  if (
    normalizeOptionalLowercaseString(context?.currentChannelProvider) !== "matrix" ||
    !context?.sessionKey ||
    !context.requesterAccountId ||
    !context.requesterSenderId
  ) {
    return undefined;
  }
  const workspaceId =
    preparedWorkspaceId ?? (await resolveSlackReadWorkspace(context, readOpts))?.workspaceId;
  if (!workspaceId) {
    return undefined;
  }
  // Fi revalidates the admitted Matrix turn and its unique linked Slack actor.
  // Never use model params, MXID localparts, or display names.
  const resolver = getOptionalSlackRuntime()?.channel.runtimeContexts.get<{
    resolveSender: (requester: {
      sessionKey: string;
      accountId: string;
      senderId: string;
      workspaceId: string;
    }) => Promise<string | undefined>;
  }>({ channelId: "matrix", capability: "requester-slack-identity" });
  const senderId = await resolver?.resolveSender({
    sessionKey: context.sessionKey,
    accountId: context.requesterAccountId,
    senderId: context.requesterSenderId,
    workspaceId,
  });
  context.assertDirectAdapterHandoff?.();
  return senderId && /^[UW][A-Z0-9]+$/i.test(senderId) ? senderId.toUpperCase() : undefined;
}
export function readSlackPlatformErrorCode(error: unknown): string | undefined {
  const data = (error as { data?: { error?: unknown } } | undefined)?.data;
  if (typeof data?.error === "string") {
    return data.error;
  }
  const message = error instanceof Error ? error.message : undefined;
  return message?.match(/An API error occurred: ([a-z_]+)/)?.[1];
}
