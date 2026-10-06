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
/** The Fi origin Fi's CLI sends its bearer to. */
export const FI_APP_URL_ENV = "FI_APP_URL";
export const ON_BEHALF_OF_AGENTS = new Set(["cellect-fi-admin", "cellect-main"]);
export const ON_BEHALF_OF_TOOLS = new Set(["exec", "sandbox_exec"]);
const ASSERTION_TTL_SECONDS = 10 * 60;
const SLACK_USER_ID = /^U[A-Z0-9]{8,}$/i;
const MATRIX_USER_ID = /^@[^\s:]+:[^\s]+$/;

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

/**
 * Rewrite exec params so the command sees exactly this turn's credentials. A
 * model-supplied `FI_ON_BEHALF_OF` or `FI_DELEGATED_USER_TOKEN` is always
 * discarded, whatever its case: each is minted here or not at all. A delegated
 * token travels with the Fi origin it was minted at, so the command cannot be
 * pointed elsewhere by its own `FI_APP_URL`.
 *
 * The host merges these params over the model's, so an `env` the model sent is
 * always answered with one, even when nothing is left in it: omitting the key
 * would hand the model's own `env` back to the command.
 */
export function withOnBehalfOfEnv(
  params: Record<string, unknown>,
  assertion: string | undefined,
  delegated?: { token: string; appUrl: string },
): Record<string, unknown> {
  const env =
    params.env && typeof params.env === "object" && !Array.isArray(params.env)
      ? { ...(params.env as Record<string, unknown>) }
      : {};
  const minted = new Set([
    ON_BEHALF_OF_ENV,
    DELEGATED_USER_TOKEN_ENV,
    ...(delegated ? [FI_APP_URL_ENV] : []),
  ]);
  for (const key of Object.keys(env)) {
    if (minted.has(key.toUpperCase())) {
      delete env[key];
    }
  }
  if (assertion) {
    env[ON_BEHALF_OF_ENV] = assertion;
  }
  if (delegated) {
    env[DELEGATED_USER_TOKEN_ENV] = delegated.token;
    env[FI_APP_URL_ENV] = delegated.appUrl;
  }
  const next = { ...params };
  if (Object.keys(env).length > 0 || "env" in params) {
    next.env = env;
  }
  return next;
}
