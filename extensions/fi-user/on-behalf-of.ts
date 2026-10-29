import { createHmac } from "node:crypto";
import type { AdminActionRecord } from "./admin-action.js";

/**
 * Gateway-signed requester attribution for fi-admin / superadmin shell work.
 *
 * Fi verifies `x-fi-on-behalf-of` (src/lib/openclaw/on-behalf-of.ts) with the
 * broker secret it shares with this gateway: HS256, iss `openclaw-gateway`, aud
 * `fi-on-behalf-of`, `iat`/`exp` (≤ 15 minutes), `agent_id`, and exactly one
 * requester claim. The sandbox only ever receives the signed assertion in
 * `FI_ON_BEHALF_OF`; the secret stays in the gateway. The assertion changes
 * attribution only — it grants nothing.
 */
export const ON_BEHALF_OF_ENV = "FI_ON_BEHALF_OF";
/** Where Fi's CLI reads the requester's own delegated token; it prefers it to the assertion. */
export const DELEGATED_USER_TOKEN_ENV = "FI_DELEGATED_USER_TOKEN";
/** One issued credential and the Fi origin that issued it; never split at the tool boundary. */
export type CommandDelegation = { token: string; baseUrl: string; command?: string };
export const ON_BEHALF_OF_AGENTS = new Set(["cellect-fi-admin", "cellect-main"]);
export const ON_BEHALF_OF_TOOLS = new Set(["exec", "sandbox_exec"]);
const ASSERTION_TTL_SECONDS = 10 * 60;
const SLACK_USER_ID = /^U[A-Z0-9]{8,}$/i;
const MATRIX_USER_ID = /^@[^\s:]+:[^\s]+$/;
const MAIL_WAKE_SESSION = /(?:^|:)hook:fi-mail:/i;
const MAIL_REQUESTER_EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

/** Pin ordinary CLI calls to the installed wrapper, never caller-controlled PATH/env. */
export function pinInstalledFiCliCommand(params: Record<string, unknown>): string | undefined {
  if (
    typeof params.command !== "string" ||
    params.command.includes("\0") ||
    /[\r\n;&|<>()`$\\]/.test(params.command) ||
    (params.env !== undefined &&
      (typeof params.env !== "object" ||
        params.env === null ||
        Array.isArray(params.env) ||
        Object.keys(params.env).length > 0))
  ) {
    return undefined;
  }
  const command = params.command.trim();
  return /^(?:cellect|\/usr\/local\/bin\/cellect)(?:[ \t]|$)/.test(command)
    ? command.replace(/^(?:cellect|\/usr\/local\/bin\/cellect)/, "/usr/local/bin/cellect")
    : undefined;
}

export type OnBehalfOfRequester =
  | { requester_slack_user_id: string }
  | { requester_matrix_user_id: string }
  | { requester_email: string };

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function signOnBehalfOf(params: {
  secret: string;
  agentId: string;
  requester: OnBehalfOfRequester;
  nowSeconds?: number;
}): string {
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: "openclaw-gateway",
      aud: "fi-on-behalf-of",
      iat: now,
      exp: now + ASSERTION_TTL_SECONDS,
      agent_id: params.agentId,
      ...params.requester,
    }),
  );
  const signature = createHmac("sha256", params.secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * The trusted requester of the tool call: the host-verified Slack or Matrix
 * sender, or the requester of an approved admin action. Webchat senders carry
 * no gateway-verified identity, so they get no assertion.
 */
export function onBehalfOfRequester(
  requester: { channel?: string; senderId?: string } | undefined,
  adminAction?: AdminActionRecord,
): OnBehalfOfRequester | undefined {
  if (adminAction) {
    const identity = adminAction.requester.identity;
    if (identity.channel === "slack") {
      return { requester_slack_user_id: identity.requesterSenderId };
    }
    if (identity.channel === "matrix") {
      return { requester_matrix_user_id: identity.requesterMatrixUserId };
    }
    // Fi itself resolved this email from its own signed webchat credential.
    return { requester_email: adminAction.requester.email };
  }
  const sender = requester?.senderId?.trim() ?? "";
  if (requester?.channel === "slack" && SLACK_USER_ID.test(sender)) {
    return { requester_slack_user_id: sender.toUpperCase() };
  }
  if (requester?.channel === "matrix" && MATRIX_USER_ID.test(sender)) {
    return { requester_matrix_user_id: sender };
  }
  return undefined;
}

/** Host-owned channel identity; a Matrix Talk consult names its speaker and thread here. */
export type TalkChannelContext = {
  sender?: { id?: unknown; [key: string]: unknown };
  chat?: { [key: string]: unknown };
};

/**
 * The speaker of a Matrix Talk consult the Gateway dispatches into this
 * thread's admin session, as the sender a typed message of theirs would carry.
 * Fi attested that identity for the Talk binding; it is no channel proof and
 * admits nothing by itself (the consult run stands on its own voice proof).
 * It is not someone unknown either: counted that way, it left that same
 * person's next typed message in the thread unadmitted, because a voice run
 * deliberately does not take up what arrived. Another speaker still counts
 * against a typed turn that is not theirs.
 */
export function talkConsultSender(
  adminAgentId: string,
  sessionKey: string,
  message: { senderId?: string; channelContext?: TalkChannelContext },
): string | undefined {
  const root = message.channelContext?.chat?.talkThreadRootEventId;
  const speaker = message.channelContext?.sender?.id;
  if (
    typeof root !== "string" ||
    !root.startsWith("$") ||
    typeof speaker !== "string" ||
    speaker !== message.senderId ||
    !sessionKey.startsWith(`agent:${adminAgentId.toLowerCase()}:matrix:`) ||
    !sessionKey.endsWith(`:thread:${root.toLowerCase()}`)
  ) {
    return undefined;
  }
  const requester = onBehalfOfRequester({ channel: "matrix", senderId: speaker });
  return requester ? JSON.stringify(requester) : undefined;
}

/**
 * The member a shared-mail hook acts as. The hooks caller attested this
 * sender; it is not a channel proof and it is not read from the prompt.
 * Slack-shaped ids mint as Slack members. An email mints as that mailbox.
 * Any other session, including ordinary cron, is not a mail wake.
 */
export function mailWakeRequester(
  sessionKey: string | undefined | null,
  senderId: string | undefined | null,
): OnBehalfOfRequester | undefined {
  if (!sessionKey || !MAIL_WAKE_SESSION.test(sessionKey)) {
    return undefined;
  }
  const sender = senderId?.trim() ?? "";
  if (SLACK_USER_ID.test(sender)) {
    return { requester_slack_user_id: sender.toUpperCase() };
  }
  if (MAIL_REQUESTER_EMAIL.test(sender.toLowerCase()) && sender.length <= 254) {
    return { requester_email: sender.toLowerCase() };
  }
  return undefined;
}

/**
 * Rewrite exec params so the command sees exactly this turn's credentials. A
 * model-supplied `FI_ON_BEHALF_OF` or `FI_DELEGATED_USER_TOKEN` is always
 * discarded, whatever its case: each is minted here or not at all.
 *
 * A command that carries the delegated token is pinned to the sandbox.
 *
 * The host merges these params over the model's, so an `env` the model sent is
 * always answered with one, even when nothing is left in it: omitting the key
 * would hand the model's own `env` back to the command.
 */
export function withOnBehalfOfEnv(
  params: Record<string, unknown>,
  assertion: string | undefined,
  delegation?: CommandDelegation,
): Record<string, unknown> {
  const env =
    params.env && typeof params.env === "object" && !Array.isArray(params.env)
      ? { ...(params.env as Record<string, unknown>) }
      : {};
  for (const key of Object.keys(env)) {
    if (
      [ON_BEHALF_OF_ENV, DELEGATED_USER_TOKEN_ENV].includes(key.toUpperCase()) ||
      (delegation && key.toUpperCase() === "FI_APP_URL")
    ) {
      delete env[key];
    }
  }
  if (assertion) {
    env[ON_BEHALF_OF_ENV] = assertion;
  }
  if (delegation) {
    env[DELEGATED_USER_TOKEN_ENV] = delegation.token;
    env.FI_APP_URL = delegation.baseUrl;
  }
  const next = { ...params };
  if (Object.keys(env).length > 0 || "env" in params) {
    next.env = env;
  }
  if (delegation) {
    // With no host named the effective one is configuration's, and a default
    // elevated level moves the command to the Gateway. Naming both makes the
    // host run it in the sandbox or refuse it; it never falls back.
    next.host = "sandbox";
    next.elevated = false;
    // Credential custody ends only after the native owner has reaped descendants.
    next.closeProcessTree = true;
    if (delegation.command !== undefined) {
      next.command = delegation.command;
    }
  }
  return next;
}
