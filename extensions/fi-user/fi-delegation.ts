import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { projectedMatrixRun } from "./projected-matrix-runs.js";
import { RECONCILE_FULL_REFRESH_BUDGET } from "./reconciliation-batch.js";
import { shadowToolAttestation } from "./shadow-requester.js";

export type PluginConfig = {
  baseUrl?: string;
  brokerTokenEnv?: string;
  /** Explicit Fi origins and broker credentials for Matrix account environments. */
  matrixEnvironments?: Record<string, { baseUrl: string; brokerTokenEnv: string }>;
  /**
   * Fi org id of the one tenant this runtime serves. Every Fi answer about a
   * person or a Matrix turn must name it: the Matrix admission gate and the
   * Slack, Matrix and webchat delegation exchange both refuse another org.
   */
  tenantOrgId?: string;
  /** Dedicated operator runtime only; mutually exclusive with both tenant keys. */
  operatorAgentId?: "cellect-main";
  /** Earlier name of `tenantOrgId`, still honored. Both set must agree. */
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
  /**
   * "provider/model" a "Let me know" Matrix turn runs on, for that turn only.
   * Unset or malformed: the turn keeps the agent's own model.
   */
  letMeKnowModel?: string;
};

export type ResolvedPluginConfig = Required<
  Pick<PluginConfig, "baseUrl" | "brokerTokenEnv" | "gamBinary" | "gamConfigDir" | "adminAgentId">
> & {
  sharedInboxMailbox?: string;
  adminApprovers: string[];
  adminPrincipals: string[];
  projectionFullRefreshesPerTick: number;
  matrixEnvironments: Record<string, { baseUrl: string; brokerTokenEnv: string }>;
  tenantOrgId?: string;
  operatorAgentId?: "cellect-main";
  /** The two tenant keys disagree: no org can be trusted, so every tenant check refuses. */
  tenantOrgConflict?: true;
  letMeKnowModel?: { provider: string; model: string };
  /** `letMeKnowModel` is set but not "provider/model"; it is ignored. */
  letMeKnowModelInvalid?: true;
};

export type Delegation = {
  user: { email: string; orgSlug: string; orgId?: string; role: string };
  gmail: { enabled: boolean; mailbox: string | null };
  fi: { token: string; expiresAt: number };
  /** Fi's resolved requester; `email` is the active member's own address. Older Fi omits it. */
  requester?: { channel?: string; email?: string };
};

const REQUESTER_EMAIL = /^[^\s@<>"'`]{1,64}@[^\s@<>"'`]{1,190}$/;

/**
 * The requester email Fi resolved for this mint, only when it is a plain
 * address and the same as the delegated user. Never taken from the model,
 * the channel or a profile; absent on older Fi, and then there is none.
 */
export function mintedRequesterEmail(
  delegation: Delegation | null | undefined,
): string | undefined {
  const email = delegation?.requester?.email;
  if (typeof email !== "string" || !REQUESTER_EMAIL.test(email)) {
    return undefined;
  }
  return email.toLowerCase() === delegation?.user?.email?.trim().toLowerCase() ? email : undefined;
}

/** The turn line a Fi mail wake already carries, for a turn whose requester Fi just resolved. */
export function requesterContextLine(email: string): string {
  return `Fi requester: ${email}. This turn acts as that member. Pass --actor ${email} on every Fi command.`;
}

/** A user turn whose requester Fi did not confirm: an earlier turn's line is not this one's. */
export const REQUESTER_UNCONFIRMED_LINE =
  "Fi requester: not confirmed for this turn. A Fi requester line from an earlier turn belongs to that turn and may name someone else: never reuse it. If a command needs --actor, say you cannot confirm this requester's Fi email.";

export const FI_USER_AGENT_ID = "cellect-fi-user";
/**
 * Fi's protocol name for the token an admin agent's sandbox command carries,
 * whatever this runtime calls its own admin agent (`adminAgentId`).
 */
export const FI_ADMIN_DELEGATION_AGENT_ID = "cellect-fi-admin";
export const FI_USER_CHANNELS = new Set(["slack", "matrix", "webchat"]);
const ENVIRONMENT_VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/;
const SLACK_USER_ID = /^U[A-Z0-9]{8,}$/i;
const MATRIX_USER_ID = /^@[^\s:]+:[^\s]+$/;

function resolve(raw: PluginConfig | undefined): ResolvedPluginConfig {
  const list = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
      : [];
  const tenantOrgId = raw?.tenantOrgId?.trim() || undefined;
  const legacyTenantOrgId = raw?.matrixTenantOrgId?.trim() || undefined;
  const tenantOrgConflict =
    tenantOrgId !== undefined &&
    legacyTenantOrgId !== undefined &&
    tenantOrgId !== legacyTenantOrgId;
  const tenant = tenantOrgConflict ? undefined : (tenantOrgId ?? legacyTenantOrgId);
  const letMeKnowModel = raw?.letMeKnowModel?.trim() ?? "";
  const letMeKnowSlash = /\s/.test(letMeKnowModel) ? -1 : letMeKnowModel.indexOf("/");
  return {
    baseUrl: raw?.baseUrl?.replace(/\/+$/, "") || "https://app.cellect.ai/fi",
    brokerTokenEnv: raw?.brokerTokenEnv || "OPENCLAW_FI_USER_BROKER_TOKEN",
    matrixEnvironments: raw?.matrixEnvironments ?? {},
    ...(raw?.operatorAgentId === "cellect-main" ? { operatorAgentId: raw.operatorAgentId } : {}),
    ...(tenant ? { tenantOrgId: tenant } : {}),
    ...(tenantOrgConflict ? { tenantOrgConflict: true as const } : {}),
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
    ...(letMeKnowSlash > 0 && letMeKnowSlash < letMeKnowModel.length - 1
      ? {
          letMeKnowModel: {
            provider: letMeKnowModel.slice(0, letMeKnowSlash),
            model: letMeKnowModel.slice(letMeKnowSlash + 1),
          },
        }
      : letMeKnowModel
        ? { letMeKnowModelInvalid: true as const }
        : {}),
  };
}

/**
 * Requester handoff applies to the configured admin and the existing Cellect
 * Superadmin. This is not a grant: native sender proof, sandbox posture, the
 * tenant broker and Fi's current member permissions still decide each call.
 */
export function isAdminAgent(
  config: Pick<ResolvedPluginConfig, "adminAgentId">,
  agentId: string | undefined,
): boolean {
  const id = agentId?.toLowerCase();
  return id === config.adminAgentId.toLowerCase() || id === "cellect-main";
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
    // A verified projected Matrix reply in a Slack session is that person's
    // turn through the Matrix account its dispatch was received on, or none.
    const projected =
      context.agentId === FI_USER_AGENT_ID
        ? projectedMatrixRun(context.runId, context.sessionKey, context.requesterSenderId)
        : undefined;
    if (!projected) {
      return resolved;
    }
    const connection = matrixConnection(resolved, projected.accountId);
    if (!connection) {
      throw new Error("The current Matrix account environment is not configured");
    }
    return { ...resolved, ...connection, baseUrl: connection.baseUrl.replace(/\/+$/, "") };
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
  | { channel: "webchat"; appContextToken: string }
  /** A Fi shadow turn: Fi names the member from the attestation it minted. */
  | { channel: "shadow" };

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
  if (
    MATRIX_USER_ID.test(sender) &&
    (context.messageChannel === "matrix" ||
      // The host can report the Slack session's channel for a run its Matrix
      // projection started; only the recorded verified reply of this run counts.
      projectedMatrixRun(context.runId, context.sessionKey, sender) !== undefined)
  ) {
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
  if (isFiUserShadowTurn(context)) {
    return true;
  }
  if (context.agentId !== FI_USER_AGENT_ID || !FI_USER_CHANNELS.has(context.messageChannel ?? "")) {
    return false;
  }
  return context.messageChannel === "webchat" || requesterIdentity(context) !== null;
}

/** A Fi-user shadow-hook run whose host context carries Fi's attestation. */
export function isFiUserShadowTurn(context: OpenClawPluginToolContext): boolean {
  return context.agentId === FI_USER_AGENT_ID && shadowToolAttestation(context) !== undefined;
}

export async function exchange(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
  options: { privateConversation?: { roomId: string } } = {},
): Promise<{ delegation: Delegation; config: ResolvedPluginConfig; identity: RequesterIdentity }> {
  const config = pluginConfig(api, context);
  // Fi decides whom the attestation names; it is never kept in the identity.
  const shadowAttestation = isFiUserShadowTurn(context)
    ? shadowToolAttestation(context)
    : undefined;
  if (shadowAttestation) {
    const delegation = await lookupDelegation(config, {
      shadowAttestation,
      sessionKey: context.sessionKey ?? "",
    });
    if (!delegation) {
      throw new Error("The shadow turn's requester is not linked to an active Fi member");
    }
    return { delegation, config, identity: { channel: "shadow" } };
  }
  const identity = requesterIdentity(context);
  if (!identity) {
    throw new Error(
      context.messageChannel === "webchat"
        ? "This Fi chat has not shared its signed-in user yet; reopen the Fi chat panel and ask again"
        : "This operation requires a verified requester on Cellect Fi",
    );
  }
  const { channel: _channel, ...requester } = identity;
  const delegation = await lookupDelegation(config, requester, options);
  if (!delegation) {
    throw new Error("The current requester is not linked to an active Fi member");
  }
  return { delegation, config, identity };
}

/** Each (answered, served) org pair is reported once per process, not once per turn. */
const reportedTenantMismatches = new Set<string>();

/**
 * Fi answered for an org this runtime does not serve: a broker credential or
 * Fi origin configured for another tenant. Every requester is refused until it
 * is fixed, so say so loudly once. Org ids only; never the token or the person.
 */
function reportTenantMismatch(answered: unknown, served: string): void {
  const answeredOrg = typeof answered === "string" && answered ? answered : "(none)";
  const key = `${answeredOrg}\n${served}`;
  if (reportedTenantMismatches.has(key)) {
    return;
  }
  reportedTenantMismatches.add(key);
  console.error(
    JSON.stringify({
      evt: "fi_user.delegation_tenant_mismatch",
      level: "error",
      answeredOrgId: answeredOrg,
      servedOrgId: served,
      message:
        "Fi answered a delegation for an organization this runtime does not serve; every Fi-user delegation is refused until the broker credential, Fi origin or tenantOrgId agree",
    }),
  );
}

/**
 * Fi's delegation for a channel-verified person; null when no active member is linked.
 *
 * A runtime accepts only the members of the one tenant it is configured for.
 * Fi resolves the person, but which org it answers for follows the broker
 * credential, so a credential or Fi origin configured for another tenant would
 * otherwise hand this runtime that tenant's member and token. Absence is never
 * a match: a runtime with no tenant refuses everyone before asking Fi, and a
 * response that does not name its org is refused too.
 */
export async function lookupDelegation(
  config: Pick<
    ResolvedPluginConfig,
    "baseUrl" | "brokerTokenEnv" | "tenantOrgId" | "tenantOrgConflict"
  >,
  requester: Record<string, string>,
  options: {
    agentId?: typeof FI_USER_AGENT_ID | typeof FI_ADMIN_DELEGATION_AGENT_ID;
    signal?: AbortSignal;
    /** Fi verifies the room is the requester's private one before it stamps audience "private". */
    privateConversation?: { roomId: string };
  } = {},
): Promise<Delegation | null> {
  if (config.tenantOrgConflict) {
    throw new Error("This runtime's tenant is configured inconsistently");
  }
  if (!config.tenantOrgId) {
    throw new Error("This runtime has no Fi organization configured");
  }
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
    body: JSON.stringify({
      ...requester,
      agentId: options.agentId ?? FI_USER_AGENT_ID,
      ...(options.privateConversation ? { privateConversation: options.privateConversation } : {}),
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Fi user delegation failed (${response.status})`);
  }
  // Untrusted JSON: a body without a user must fail the tenant check, not throw past it.
  const delegation = (await response.json()) as Partial<Delegation> | null;
  if (delegation?.user?.orgId !== config.tenantOrgId) {
    reportTenantMismatch(delegation?.user?.orgId, config.tenantOrgId);
    throw new Error("The current requester does not belong to this runtime's Fi organization");
  }
  return delegation as Delegation;
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
