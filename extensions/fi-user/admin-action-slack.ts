import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { brokerToken, configFromRuntime, type ResolvedPluginConfig } from "./fi-delegation.js";

/**
 * Slack transport for administrator approval cards. Nothing here decides
 * anything: Fi names the reviewers and authorizes each click, and the stored
 * record stays channel-neutral.
 */

/** Interactive namespace. Button action id: `fi-admin-action:<decision>`; value: `<requestId>:<revision>`. */
export const SLACK_ADMIN_ACTION_NAMESPACE = "fi-admin-action";
export type SlackDecision = "approve" | "hold" | "decline" | "resume";
const DECISION_LABEL: Record<SlackDecision, string> = {
  approve: "Approve",
  hold: "Hold",
  decline: "Decline",
  resume: "Resume",
};
const SLACK_ID = /^[UW][A-Z0-9]{8,}$/;
const MAX_REVIEWERS = 25;

export const isSlackUserId = (value: unknown): value is string =>
  typeof value === "string" && SLACK_ID.test(value);

/** What the host passes to a namespace handler: the part after `fi-admin-action:`. */
export function parseSlackActionPayload(
  payload: unknown,
): { decision: SlackDecision; requestId: string; revision: number } | undefined {
  const match =
    typeof payload === "string"
      ? /^(approve|hold|decline|resume):([A-Z0-9]{6}):([1-9]\d{0,8})$/.exec(payload)
      : null;
  return match
    ? { decision: match[1] as SlackDecision, requestId: match[2]!, revision: Number(match[3]) }
    : undefined;
}

export type SlackCardView = {
  id: string;
  revision: number;
  status: string;
  title: string;
  summary: string;
  decisions: string[];
  expiresAtMs: number;
  decidedBy?: string;
};

export const escapeSlack = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const STATE_LABEL: Record<string, string> = {
  pending: "Waiting for a decision",
  held: "On hold",
  approved: "Approved",
  declined: "Declined",
  expired: "Expired",
};

export function slackStateLabel(card: Pick<SlackCardView, "status" | "decidedBy">): string {
  const label = STATE_LABEL[card.status] ?? card.status;
  const by = card.decidedBy?.startsWith("slack:") ? ` by <@${card.decidedBy.slice(6)}>` : "";
  return ["approved", "declined"].includes(card.status) ? `${label}${by}` : label;
}

function decisionButton(decision: SlackDecision, value: string) {
  const style = decision === "approve" ? "primary" : decision === "decline" ? "danger" : undefined;
  return {
    type: "button",
    action_id: `${SLACK_ADMIN_ACTION_NAMESPACE}:${decision}`,
    value,
    text: { type: "plain_text", text: DECISION_LABEL[decision] },
    ...(style ? { style } : {}),
  };
}

/** Plain-text fallback plus Block Kit; the buttons appear only while a decision is open. */
export function slackReviewerMessage(card: SlackCardView, requesterSlackUserId: string) {
  const open = ["pending", "held"].includes(card.status);
  const text = `${escapeSlack(card.title)}\n${escapeSlack(card.summary)}\n${slackStateLabel(card)}`;
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: card.title.slice(0, 150) } },
    { type: "section", text: { type: "plain_text", text: card.summary, emoji: false } },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Requested by <@${requesterSlackUserId}> · Request ${card.id} · ${slackStateLabel(card)}`,
        },
      ],
    },
  ];
  if (open) {
    blocks.push({
      type: "actions",
      elements: card.decisions
        .filter((decision): decision is SlackDecision => decision in DECISION_LABEL)
        .map((decision) => decisionButton(decision, `${card.id}:${card.revision}`)),
    });
  }
  return { text, blocks };
}

async function fiPost(
  config: Pick<ResolvedPluginConfig, "baseUrl" | "brokerTokenEnv">,
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  const token = brokerToken(config);
  if (!token) {
    throw new Error("Approval verifier unavailable.");
  }
  return await fetch(`${config.baseUrl.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000),
  });
}

type SlackFiConfig = Pick<
  ResolvedPluginConfig,
  "baseUrl" | "brokerTokenEnv" | "tenantOrgId" | "tenantOrgConflict"
>;

function requireTenant(config: SlackFiConfig): string {
  if (!config.tenantOrgId || config.tenantOrgConflict) {
    throw new Error("Approval environment or tenant mismatch.");
  }
  return config.tenantOrgId;
}

/** Slack ids of the organization's current owners and admins; may be empty. */
export async function fetchSlackReviewers(
  config: SlackFiConfig,
  warn?: (message: string) => void,
): Promise<string[]> {
  const tenantOrgId = requireTenant(config);
  const response = await fiPost(config, "/api/threads/admin-action-reviewers", {
    tenantOrgId,
    channel: "slack",
  });
  if (!response.ok) {
    throw new Error("The organization's administrators could not be looked up. Nothing was filed.");
  }
  const body = (await response.json()) as { reviewers?: Array<{ slackUserId?: unknown }> };
  const ids = (Array.isArray(body.reviewers) ? body.reviewers : [])
    .map((entry) => (typeof entry?.slackUserId === "string" ? entry.slackUserId.toUpperCase() : ""))
    .filter(isSlackUserId);
  if (ids.length >= MAX_REVIEWERS) {
    warn?.(
      `fi-user: Slack reviewer list reached its cap of ${MAX_REVIEWERS}; some may not be notified`,
    );
  }
  return [...new Set(ids)].slice(0, MAX_REVIEWERS);
}

/**
 * The Slack account administrators are reached through: the one the admin
 * agent is bound to, so a click passes that account's DM allowlist. It comes
 * only from host config (the binding for the request's workspace when it is
 * known); an absent, ambiguous, disabled or tokenless account
 * fails closed, never falling back to the requester's bot.
 */
export function resolveReviewAccountId(api: OpenClawPluginApi, teamId?: string): string {
  const cfg = api.runtime.config.current() as unknown as {
    bindings?: Array<{
      type?: string;
      agentId?: string;
      match?: Record<string, unknown> & { channel?: string; accountId?: string };
    }>;
    channels?: {
      slack?: {
        enabled?: boolean;
        botToken?: unknown;
        accounts?: Record<string, { enabled?: boolean; botToken?: unknown }>;
      };
    };
  };
  const agent = configFromRuntime(api).adminAgentId.toLowerCase();
  const accounts = new Set(
    (cfg.bindings ?? [])
      .filter(
        (binding) =>
          (binding.type ?? "route") === "route" &&
          binding.agentId?.trim().toLowerCase() === agent &&
          binding.match?.channel === "slack" &&
          typeof binding.match.accountId === "string" &&
          binding.match.accountId !== "*" &&
          !binding.match.peer &&
          !binding.match.guildId &&
          // A workspace-scoped binding must be the request's own workspace, when that is known.
          (!teamId ||
            !binding.match.teamId ||
            String(binding.match.teamId).toUpperCase() === teamId.toUpperCase()),
      )
      .map((binding) => binding.match!.accountId as string),
  );
  const slack = cfg.channels?.slack;
  const [accountId] = accounts;
  const account = accountId ? slack?.accounts?.[accountId] : undefined;
  const token = account?.botToken;
  if (
    accounts.size !== 1 ||
    !accountId ||
    !account ||
    slack?.enabled === false ||
    account.enabled === false ||
    typeof token !== "string" ||
    !token.trim()
  ) {
    throw new Error(
      "The administrators' Slack account is not available, so nothing was sent. Ask an administrator directly.",
    );
  }
  return accountId;
}

/** Files nothing when no administrator can be told: the requester must ask them directly. */
export async function requireSlackReviewers(
  api: OpenClawPluginApi,
  config: SlackFiConfig,
  teamId?: string,
): Promise<{ reviewers: string[]; accountId: string }> {
  const accountId = resolveReviewAccountId(api, teamId);
  const reviewers = await fetchSlackReviewers(config, api.logger.warn);
  if (reviewers.length === 0) {
    throw new Error(
      "No administrator can receive this request in Slack; ask them directly. Nothing was filed.",
    );
  }
  return { reviewers, accountId };
}

/** Fi must name the clicker as a current administrator of this tenant. */
export async function authorizeSlackReviewer(
  config: SlackFiConfig,
  input: {
    requestId: string;
    revision: number;
    reviewerSlackUserId: string;
    requesterSlackUserId: string;
  },
  signal?: AbortSignal,
): Promise<{ email: string | undefined }> {
  const tenantOrgId = requireTenant(config);
  const response = await fiPost(
    config,
    "/api/threads/admin-action-authorize",
    { channel: "slack", tenantOrgId, ...input },
    signal,
  );
  if (!response.ok) {
    throw new Error("The current Fi administrator could not be verified.");
  }
  const result = (await response.json()) as {
    ok?: boolean;
    orgId?: string;
    slackUserId?: string;
    role?: string;
    email?: string;
  };
  if (
    result.ok !== true ||
    result.orgId !== tenantOrgId ||
    result.slackUserId?.toUpperCase() !== input.reviewerSlackUserId ||
    !["admin", "owner"].includes(result.role ?? "")
  ) {
    throw new Error("Only a current administrator of this organization may decide this request.");
  }
  return { email: result.email };
}

/** The bot token of the Slack account that sent the card; the plugin SDK has no message-edit seam. */
function slackBotToken(cfg: OpenClawConfig, accountId: string): string | undefined {
  const slack = (
    cfg as {
      channels?: {
        slack?: {
          enabled?: boolean;
          accounts?: Record<string, { enabled?: boolean; botToken?: unknown }>;
        };
      };
    }
  ).channels?.slack;
  const account = slack?.accounts?.[accountId];
  if (slack?.enabled === false || account?.enabled === false) {
    return undefined;
  }
  const token = account?.botToken;
  return typeof token === "string" && token.trim() ? token.trim() : undefined;
}

export async function updateSlackMessage(
  api: OpenClawPluginApi,
  params: {
    accountId: string;
    teamId?: string;
    channelId: string;
    ts: string;
    text: string;
    blocks: unknown[];
    assertCurrent: () => void;
  },
): Promise<void> {
  const token = slackBotToken(api.runtime.config.current() as OpenClawConfig, params.accountId);
  if (!token) {
    throw new Error("Slack bot token unavailable.");
  }
  params.assertCurrent();
  const response = await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      channel: params.channelId,
      ...(params.teamId ? { team_id: params.teamId } : {}),
      ts: params.ts,
      text: params.text,
      blocks: params.blocks,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!response.ok || body.ok !== true) {
    throw new Error(`Slack chat.update failed: ${body.error ?? response.status}`);
  }
}

/** A private card in one administrator's DM; the receipt is what later edits address. */
export async function sendSlackReviewerCard(
  api: OpenClawPluginApi,
  params: {
    accountId: string;
    reviewerSlackUserId: string;
    teamId?: string;
    text: string;
    blocks: unknown[];
    assertCurrent: () => void;
  },
): Promise<{ channelId: string; ts: string }> {
  const adapter = await api.runtime.channel.outbound.loadAdapter("slack");
  if (!adapter?.sendPayload) {
    throw new Error("Decision-card delivery is unavailable.");
  }
  params.assertCurrent();
  const result = await adapter.sendPayload({
    cfg: api.runtime.config.current() as OpenClawConfig,
    to: slackTarget(`user:${params.reviewerSlackUserId}`, params.teamId),
    accountId: params.accountId,
    text: params.text,
    assertDirectAdapterHandoff: params.assertCurrent,
    payload: { text: params.text, channelData: { slack: { blocks: params.blocks } } },
  });
  const channelId = result.target?.id;
  if (!channelId || !/^D[A-Z0-9]{6,}$/.test(channelId) || !result.messageId) {
    throw new Error("Approval publication has no native receipt; nothing can be approved.");
  }
  return { channelId, ts: result.messageId };
}

/** Plain text into the requester's own conversation or thread. */
export async function postSlackText(
  api: OpenClawPluginApi,
  params: {
    accountId: string;
    channelId: string;
    teamId?: string;
    threadTs?: string;
    text: string;
    assertCurrent: () => void;
  },
): Promise<void> {
  const adapter = await api.runtime.channel.outbound.loadAdapter("slack");
  if (!adapter?.sendText) {
    throw new Error("Slack delivery is unavailable.");
  }
  params.assertCurrent();
  await adapter.sendText({
    cfg: api.runtime.config.current() as OpenClawConfig,
    to: slackTarget(`channel:${params.channelId}`, params.teamId),
    text: params.text,
    accountId: params.accountId,
    assertDirectAdapterHandoff: params.assertCurrent,
    ...(params.threadTs ? { threadId: params.threadTs } : {}),
  });
}

/** Plain text into one person's DM with the bot; the receipt must be a real DM channel. */
export async function sendSlackDm(
  api: OpenClawPluginApi,
  params: {
    accountId: string;
    userId: string;
    teamId?: string;
    text: string;
    assertCurrent: () => void;
  },
): Promise<{ channelId: string }> {
  const adapter = await api.runtime.channel.outbound.loadAdapter("slack");
  if (!adapter?.sendText) {
    throw new Error("Slack delivery is unavailable.");
  }
  params.assertCurrent();
  const result = await adapter.sendText({
    cfg: api.runtime.config.current() as OpenClawConfig,
    to: slackTarget(`user:${params.userId}`, params.teamId),
    text: params.text,
    accountId: params.accountId,
    assertDirectAdapterHandoff: params.assertCurrent,
  });
  const channelId = result.target?.id;
  if (!channelId || !/^D[A-Z0-9]{6,}$/.test(channelId)) {
    throw new Error("Slack did not confirm a private delivery.");
  }
  return { channelId };
}

function slackTarget(target: string, teamId?: string): string {
  return teamId ? `team:${encodeURIComponent(teamId)}:${target}` : target;
}
