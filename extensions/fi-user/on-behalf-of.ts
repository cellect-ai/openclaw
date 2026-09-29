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
 * Rewrite exec params so the command sees exactly this turn's assertion. A
 * model-supplied `FI_ON_BEHALF_OF` is always discarded: an assertion is minted
 * here or not at all.
 */
export function withOnBehalfOfEnv(
  params: Record<string, unknown>,
  assertion: string | undefined,
): Record<string, unknown> {
  const env =
    params.env && typeof params.env === "object" && !Array.isArray(params.env)
      ? { ...(params.env as Record<string, unknown>) }
      : {};
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === ON_BEHALF_OF_ENV) {
      delete env[key];
    }
  }
  if (assertion) {
    env[ON_BEHALF_OF_ENV] = assertion;
  }
  const next = { ...params };
  if (Object.keys(env).length > 0) {
    next.env = env;
  } else {
    delete next.env;
  }
  return next;
}
