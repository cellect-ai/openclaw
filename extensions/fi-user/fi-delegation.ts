import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { RECONCILE_FULL_REFRESH_BUDGET } from "./reconciliation-batch.js";

export type PluginConfig = {
  baseUrl?: string;
  brokerTokenEnv?: string;
  /** Explicit Fi origins and broker credentials for Matrix account environments. */
  matrixEnvironments?: Record<string, { baseUrl: string; brokerTokenEnv: string }>;
  /** Tenant whose credentials and sandbox this configured runtime owns. */
  matrixTenantOrgId?: string;
  gamBinary?: string;
  gamConfigDir?: string;
  /**
   * Shared tenant mailbox fi-user may search, and only for messages from, to
   * or copied to the verified requester. Unset: no shared-inbox access.
   */
  sharedInboxMailbox?: string;
  /** Slack or Matrix sender ids whose reply may approve an admin action. */
  adminApprovers?: string[];
  /** Slack user ids tagged on an admin-action approval card. */
  adminPrincipals?: string[];
  /** Agent that carries out an approved admin action. */
  adminAgentId?: string;
  /**
   * Drifted Slack projection rooms the periodic reconciler may refresh from a
   * full source snapshot per tick. Default 1; 0 keeps readers-only passes.
   */
  projectionFullRefreshesPerTick?: number;
};

export type ResolvedPluginConfig = Required<
  Pick<PluginConfig, "baseUrl" | "brokerTokenEnv" | "gamBinary" | "gamConfigDir" | "adminAgentId">
> & {
  sharedInboxMailbox?: string;
  adminApprovers: string[];
  adminPrincipals: string[];
  projectionFullRefreshesPerTick: number;
  matrixEnvironments: Record<string, { baseUrl: string; brokerTokenEnv: string }>;
  matrixTenantOrgId?: string;
};

export type Delegation = {
  user: { email: string; orgSlug: string; role: string };
  gmail: { enabled: boolean; mailbox: string | null };
  fi: { token: string; expiresAt: number };
};

export const FI_USER_AGENT_ID = "cellect-fi-user";
export const FI_USER_CHANNELS = new Set(["slack", "matrix", "webchat"]);
const ENVIRONMENT_VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/;
const SLACK_USER_ID = /^U[A-Z0-9]{8,}$/i;
const MATRIX_USER_ID = /^@[^\s:]+:[^\s]+$/;

function resolve(raw: PluginConfig | undefined): ResolvedPluginConfig {
  const list = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
      : [];
  return {
    baseUrl: raw?.baseUrl?.replace(/\/+$/, "") || "https://app.cellect.ai/fi",
    brokerTokenEnv: raw?.brokerTokenEnv || "OPENCLAW_FI_USER_BROKER_TOKEN",
    matrixEnvironments: raw?.matrixEnvironments ?? {},
    ...(raw?.matrixTenantOrgId?.trim() ? { matrixTenantOrgId: raw.matrixTenantOrgId.trim() } : {}),
    gamBinary: raw?.gamBinary || "/home/node/.openclaw/bin/gam7/gam",
    gamConfigDir: raw?.gamConfigDir || "/home/claude/GAMConfig",
    adminAgentId: raw?.adminAgentId?.trim() || "cellect-fi-admin",
    ...(raw?.sharedInboxMailbox?.trim()
      ? { sharedInboxMailbox: raw.sharedInboxMailbox.trim().toLowerCase() }
      : {}),
    adminApprovers: list(raw?.adminApprovers).map((id) => id.trim()),
    adminPrincipals: list(raw?.adminPrincipals).map((id) => id.trim()),
    projectionFullRefreshesPerTick:
      Number.isSafeInteger(raw?.projectionFullRefreshesPerTick) &&
      Number(raw?.projectionFullRefreshesPerTick) >= 0
        ? Number(raw?.projectionFullRefreshesPerTick)
        : RECONCILE_FULL_REFRESH_BUDGET,
  };
}

export function configFromRuntime(api: OpenClawPluginApi): ResolvedPluginConfig {
  const cfg = api.runtime.config?.current?.() ?? api.config;
  return resolve(cfg.plugins?.entries?.["fi-user"]?.config as PluginConfig | undefined);
}

/** Resolve an environment only from the host-proven inbound Matrix account. */
export function matrixConnection(
  config: ResolvedPluginConfig,
  accountId: string | undefined,
): Pick<ResolvedPluginConfig, "baseUrl" | "brokerTokenEnv"> | undefined {
  if (!accountId) {
    return undefined;
  }
  let environments: unknown;
  try {
    environments = JSON.parse(process.env.FI_THREADS_ENV_BY_ACCOUNT ?? "{}");
  } catch {
    return undefined;
  }
  if (!environments || typeof environments !== "object" || Array.isArray(environments)) {
    return undefined;
  }
  const environment = Object.hasOwn(environments, accountId)
    ? (environments as Record<string, unknown>)[accountId]
    : undefined;
  return typeof environment === "string"
    ? (config.matrixEnvironments[environment] ?? (environment === "prod" ? config : undefined))
    : undefined;
}

export function pluginConfig(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
): ResolvedPluginConfig {
  const cfg = context.getRuntimeConfig?.() ?? context.runtimeConfig ?? context.config;
  const resolved = cfg
    ? resolve(cfg.plugins?.entries?.["fi-user"]?.config as PluginConfig | undefined)
    : configFromRuntime(api);
  if (context.messageChannel !== "matrix") {
    return resolved;
  }
  const accountId = context.agentAccountId?.trim();
  const deliveryAccountId = context.deliveryContext?.accountId?.trim();
  if (accountId && deliveryAccountId && accountId !== deliveryAccountId) {
    throw new Error("The Matrix requester account disagrees with its delivery route");
  }
  const connection = matrixConnection(
    resolved,
    accountId ?? (context.deliveryContext?.channel === "matrix" ? deliveryAccountId : undefined),
  );
  if (!connection) {
    throw new Error("The current Matrix account environment is not configured");
  }
  return { ...resolved, ...connection, baseUrl: connection.baseUrl.replace(/\/+$/, "") };
}

/**
 * OpenClaw resolves ${...} configuration references before plugins run, then
 * clears the source environment value. Keep the old environment-name form for
 * existing deployments, while accepting that already-resolved private value.
 */
export function brokerToken(
  config: Pick<ResolvedPluginConfig, "brokerTokenEnv">,
): string | undefined {
  const configured = config.brokerTokenEnv.trim();
  if (!configured) {
    return undefined;
  }
  return (
    process.env[configured]?.trim() ||
    (ENVIRONMENT_VARIABLE_NAME.test(configured) ? undefined : configured)
  );
}

/**
 * Webchat turns carry no gateway-verified person. The Fi widget embeds the
 * Fi-signed context credential it minted for the signed-in user; the gateway
 * remembers the latest one seen on each webchat session and Fi verifies it.
 */
const webchatContextTokens = new Map<string, { token: string; seenAt: number }>();
const WEBCHAT_CONTEXT_TTL_MS = 60 * 60 * 1000;
const FI_CONTEXT_TOKEN =
  /"type"\s*:\s*"fi_context"[\s\S]{0,4000}?"token"\s*:\s*"([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"|"token"\s*:\s*"([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"[\s\S]{0,4000}?"type"\s*:\s*"fi_context"/;

export function rememberWebchatContext(sessionKey: string | undefined, content: string): void {
  if (!sessionKey || !content) {
    return;
  }
  const match = FI_CONTEXT_TOKEN.exec(content);
  const token = match?.[1] ?? match?.[2];
  if (token) {
    webchatContextTokens.set(sessionKey, { token, seenAt: Date.now() });
  }
}

function webchatContextToken(sessionKey: string | undefined): string | undefined {
  const entry = sessionKey ? webchatContextTokens.get(sessionKey) : undefined;
  if (!entry || Date.now() - entry.seenAt > WEBCHAT_CONTEXT_TTL_MS) {
    return undefined;
  }
  return entry.token;
}

export type RequesterIdentity =
  | { channel: "slack"; requesterSenderId: string }
  | { channel: "matrix"; requesterMatrixUserId: string }
  | { channel: "webchat"; appContextToken: string };

/**
 * The trusted requester of this Fi-user turn, as the channel proved it.
 *
 * A realtime voice consult bound to a Matrix conversation arrives on the
 * Matrix channel with the speaker as its sender: Fi attested that Matrix
 * identity for its signed-in user when it minted the Talk binding, and the
 * Gateway stamps it on the consult run. Fi maps it back to the member exactly
 * as it does a typed Matrix message; the relaying browser is never the sender.
 */
export function requesterIdentity(context: OpenClawPluginToolContext): RequesterIdentity | null {
  if (context.agentId !== FI_USER_AGENT_ID) {
    return null;
  }
  const sender = context.requesterSenderId?.trim() ?? "";
  if (context.messageChannel === "slack" && SLACK_USER_ID.test(sender)) {
    return { channel: "slack", requesterSenderId: sender.toUpperCase() };
  }
  if (context.messageChannel === "matrix" && MATRIX_USER_ID.test(sender)) {
    return { channel: "matrix", requesterMatrixUserId: sender };
  }
  if (context.messageChannel === "webchat") {
    const token = webchatContextToken(context.sessionKey);
    return token ? { channel: "webchat", appContextToken: token } : null;
  }
  return null;
}

/**
 * Whether this turn carries a verified Fi-user requester. Webchat shares its
 * credential inside the message, so its tools stay offered to explain a
 * missing one; Slack and Matrix turns, voice included, need a proven sender.
 */
export function isFiUserTurn(context: OpenClawPluginToolContext): boolean {
  if (context.agentId !== FI_USER_AGENT_ID || !FI_USER_CHANNELS.has(context.messageChannel ?? "")) {
    return false;
  }
  return context.messageChannel === "webchat" || requesterIdentity(context) !== null;
}

export async function exchange(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
): Promise<{ delegation: Delegation; config: ResolvedPluginConfig; identity: RequesterIdentity }> {
  const config = pluginConfig(api, context);
  const identity = requesterIdentity(context);
  if (!identity) {
    throw new Error(
      context.messageChannel === "webchat"
        ? "This Fi chat has not shared its signed-in user yet; reopen the Fi chat panel and ask again"
        : "This operation requires a verified requester on Cellect Fi",
    );
  }
  const { channel: _channel, ...requester } = identity;
  const delegation = await lookupDelegation(config, requester);
  if (!delegation) {
    throw new Error("The current requester is not linked to an active Fi member");
  }
  return { delegation, config, identity };
}

/** Fi's delegation for a channel-verified person; null when no active member is linked. */
export async function lookupDelegation(
  config: Pick<ResolvedPluginConfig, "baseUrl" | "brokerTokenEnv">,
  requester: Record<string, string>,
): Promise<Delegation | null> {
  const token = brokerToken(config);
  if (!token) {
    throw new Error("Fi user delegation broker is not configured");
  }
  const response = await fetch(`${config.baseUrl}/api/openclaw-user-delegation`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...requester, agentId: FI_USER_AGENT_ID }),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Fi user delegation failed (${response.status})`);
  }
  return (await response.json()) as Delegation;
}

export async function delegatedFetch(
  config: Pick<ResolvedPluginConfig, "baseUrl">,
  delegation: Delegation,
  pathname: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${delegation.fi.token}`);
  return fetch(`${config.baseUrl}${pathname}`, {
    ...init,
    headers,
  });
}

/** Read a Fi response as JSON when it says so, otherwise as text. */
export async function readFiResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

export async function delegatedJson(
  config: Pick<ResolvedPluginConfig, "baseUrl">,
  delegation: Delegation,
  pathname: string,
  init: RequestInit = {},
  label = "Fi request",
): Promise<unknown> {
  const response = await delegatedFetch(config, delegation, pathname, init);
  const result = await readFiResponse(response);
  if (!response.ok) {
    const detail = typeof result === "string" ? result : JSON.stringify(result);
    throw new Error(`${label} failed (${response.status}): ${detail.slice(0, 1_000)}`);
  }
  return result;
}

/** One URL path segment supplied by the model: no separators or traversal. */
export function pathSegment(value: string | undefined, label: string): string {
  const trimmed = value?.trim() ?? "";
  if (
    !trimmed ||
    trimmed.length > 200 ||
    /[/\\?#]|\.\./.test(trimmed) ||
    /%2e|%2f/i.test(trimmed)
  ) {
    throw new Error(`${label} must be a single identifier`);
  }
  return encodeURIComponent(trimmed);
}
