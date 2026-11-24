import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  asNonArrayRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedSlackAccount } from "../accounts.js";
import { createSlackStartupAuthClient } from "../client.js";
import { formatSlackBotTokenIdentityWarning } from "../token.js";
import type { SlackMonitorContext } from "./context.js";
import {
  assertEnterpriseSlackBindingsAreWorkspaceQualified,
  assertEnterpriseSlackPolicyConfig,
  type SlackAuthTestIdentity,
} from "./enterprise-install.js";
import type { SlackInstallationIdentity } from "./enterprise-install.js";
import { resolveSlackIdentityHealth } from "./enterprise-install.js";

export type SlackRuntimeIdentity = {
  botUserId: string;
  botId?: string;
};

export function resolveSlackRuntimeIdentity(params: {
  identity: "bot" | "user";
  botUserId?: unknown;
  botId?: unknown;
}): SlackRuntimeIdentity | undefined {
  // User identity has no bot_id; its human id is both the mention target and self-send dedupe
  // source. Bot identity stays bot_id-gated so token mismatches fail closed.
  const botUserId = normalizeOptionalString(params.botUserId);
  const botId = normalizeOptionalString(params.botId);
  if (!botUserId || (params.identity === "bot" && !botId)) {
    return undefined;
  }
  return {
    botUserId,
    ...(botId ? { botId } : {}),
  };
}

export function applySlackInstallationIdentity(
  ctx: SlackMonitorContext,
  identity: SlackInstallationIdentity,
) {
  ctx.installationIdentity = identity;
  ctx.teamId = identity.kind === "workspace" ? identity.teamId : "";
  ctx.apiAppId = identity.kind === "degraded" ? "" : (identity.apiAppId ?? "");
}

export function adoptSlackIdentity(params: {
  ctx: SlackMonitorContext;
  identity: "bot" | "user";
  installationIdentity: SlackInstallationIdentity;
  botUserId?: unknown;
  botId?: unknown;
}): boolean {
  if (
    params.ctx.identityHealth.lifecycle !== "blocked" ||
    params.installationIdentity.kind === "degraded"
  ) {
    return false;
  }
  const resolved = resolveSlackRuntimeIdentity(params);
  if (!resolved) {
    return false;
  }
  applySlackInstallationIdentity(params.ctx, params.installationIdentity);
  params.ctx.botUserId = resolved.botUserId;
  params.ctx.botId = resolved.botId;
  params.ctx.identityHealth = resolveSlackIdentityHealth({
    installationIdentity: params.installationIdentity,
    botUserId: resolved.botUserId,
  });
  return true;
}

export function resolveSlackRelayConfig(params: { relay: unknown; accountId: string }): {
  url: string;
  authToken: string;
  gatewayId: string;
} {
  const relay = asNonArrayRecord(params.relay);
  const url = normalizeOptionalString(relay.url);
  const authToken = normalizeResolvedSecretInputString({
    value: relay.authToken,
    path: `channels.slack.accounts.${params.accountId}.relay.authToken`,
  });
  const gatewayId = normalizeOptionalString(relay.gatewayId);
  if (!url || !authToken || !gatewayId) {
    throw new Error(
      `Slack relay mode requires relay.url, relay.authToken, and relay.gatewayId for account "${params.accountId}".`,
    );
  }
  return {
    url,
    authToken,
    gatewayId,
  };
}

export async function resolveSlackBootIdentity(params: {
  token: string;
  clientOptions: Parameters<typeof createSlackStartupAuthClient>[1];
  account: ResolvedSlackAccount;
}) {
  const { token, clientOptions, account } = params;
  let botUserId = "";
  let botId = "";
  let authTestError: string | undefined;
  let authIdentityWarning: string | undefined;
  let authTestIdentity: SlackAuthTestIdentity | undefined;
  try {
    const auth = await createSlackStartupAuthClient(token, clientOptions).auth.test();
    const authUserId = normalizeOptionalString(auth.user_id) ?? "";
    const resolvedIdentity = resolveSlackRuntimeIdentity({
      identity: account.identity,
      botUserId: authUserId,
      botId: (auth as { bot_id?: string }).bot_id,
    });
    botUserId = resolvedIdentity?.botUserId ?? "";
    botId = resolvedIdentity?.botId ?? "";
    authTestIdentity = auth;
    if (account.identity === "bot") {
      authIdentityWarning = formatSlackBotTokenIdentityWarning({
        auth,
        accountId: account.accountId,
      });
    }
    if (!authUserId) {
      authTestError = "auth.test returned no user_id";
    }
  } catch (err) {
    authTestError = err instanceof Error ? err.message : String(err);
  }
  return { botUserId, botId, authTestError, authIdentityWarning, authTestIdentity };
}

export function createSlackInstallationPolicy(params: {
  account: ResolvedSlackAccount;
  cfg: OpenClawConfig;
  slackMode: "socket" | "http" | "relay";
}) {
  const { account, cfg, slackMode } = params;
  const assertSlackInstallationPolicy = (identity: SlackInstallationIdentity) => {
    if (identity.kind === "degraded") {
      if (slackMode === "relay") {
        throw new Error(
          `Slack relay account "${account.accountId}" requires a successful auth.test before startup`,
        );
      }
      return;
    }
    if (identity.kind !== "enterprise") {
      return;
    }
    if (slackMode === "relay") {
      throw new Error(
        `Slack Enterprise Grid org account "${account.accountId}" requires direct socket or HTTP delivery; relay mode is unsupported`,
      );
    }
    assertEnterpriseSlackPolicyConfig({ config: account.config, accountId: account.accountId });
    assertEnterpriseSlackBindingsAreWorkspaceQualified({ cfg, accountId: account.accountId });
  };
  return assertSlackInstallationPolicy;
}

export function resolveSlackSocketAppId(slackMode: string, appToken: string | undefined | null) {
  return slackMode === "socket"
    ? /^xapp-\d-([a-z0-9]+)-/i.exec(appToken?.trim() ?? "")?.[1]?.toUpperCase()
    : undefined;
}
