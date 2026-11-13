import { createHmac } from "node:crypto";
/** Synthetic trusted-server response only; the plugin does not verify signatures. */
export function mailWakeCredential(
  overrides: Record<string, unknown> = {},
  agentId = "cellect-fi-admin",
) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "fi-openclaw-user-delegation",
    aud: "fi-openclaw-user-api",
    sub: "admin@example.com",
    agent_id: agentId,
    org_slug: "a",
    env: "prod",
    cred: "fixture-broker",
    iat: now,
    exp: now + (agentId === "cellect-fi-admin" ? 600 : 300),
    wake_session: true,
    wake_message_id: "message-1",
    ...overrides,
  };
  const body = `${Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return {
    token: `${body}.${createHmac("sha256", "synthetic-fi-test-secret").update(body).digest("base64url")}`,
    expiresAt: claims.exp,
  };
}
