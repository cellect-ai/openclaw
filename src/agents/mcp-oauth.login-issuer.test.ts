import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import {
  authorizationCode,
  startAuthorizationServer,
} from "./mcp-oauth-authorization-server.test-harness.js";
import { operatorMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import { readMcpOAuthStore } from "./mcp-oauth-store.js";
import { completeMcpOAuthAuthorization, startMcpOAuthAuthorization } from "./mcp-oauth.js";
import { withTempHome } from "./mcp-oauth.test-harness.js";
import { resolvedOAuthConfig, withMcpOAuthProviderForTest } from "./mcp-oauth.test-support.js";

describe("MCP OAuth legacy issuer sign-in", () => {
  beforeEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  });

  it.each(["legacy pair", "bound token with legacy client"] as const)(
    "reauthorizes a fresh %s through actual SDK start and a recreated callback provider",
    async (kind) => {
      await withTempHome(
        async () => {
          const fixture = await startAuthorizationServer();
          const identity = operatorMcpOAuthIdentity("legacy-login", `${fixture.issuer}/mcp`);
          const config = resolvedOAuthConfig(identity);
          const legacyTokens = {
            access_token: "legacy-access",
            refresh_token: "legacy-refresh-secret",
            token_type: "Bearer",
            expires_in: 3600,
            ...(kind === "bound token with legacy client" ? { issuer: fixture.issuer } : {}),
          };
          const controller = new AbortController();
          const login = {
            signal: controller.signal,
            assertCurrent: () => controller.signal.throwIfAborted(),
            onAuthorizationPublished: vi.fn(),
            beforeTokensSaved: vi.fn(),
            onTokensSaved: vi.fn(),
          };
          try {
            await withMcpOAuthProviderForTest({ identity }, async (provider) => {
              await provider.saveClientInformation?.({
                client_id: "legacy-client",
                client_secret: "legacy-client-secret",
              });
              await provider.saveTokens(legacyTokens);
            });
            const first = await startMcpOAuthAuthorization(identity, config, { login });
            if (first.status !== "redirect") {
              throw new Error("Legacy credentials must require a new browser authorization");
            }
            expect((await readMcpOAuthStore(identity.storeKey)).tokens).toEqual(legacyTokens);
            expect(login.onAuthorizationPublished).toHaveBeenCalledWith(first.state);
            await closeOpenClawStateDatabaseAsync();
            closeOpenClawStateDatabaseForTest();
            await expect(
              completeMcpOAuthAuthorization(identity, config, {
                code: authorizationCode(first.authorizationUrl),
              }),
            ).resolves.toBe("authorized");
            await closeOpenClawStateDatabaseAsync();
            closeOpenClawStateDatabaseForTest();
            const stored = await readMcpOAuthStore(identity.storeKey);
            expect(stored.tokens?.issuer).toBe(fixture.issuer);
            expect(stored.clientInformation?.issuer).toBe(fixture.issuer);
            expect(stored.tokens?.access_token).toMatch(/^access-/);
            expect(stored.tokens?.refresh_token).toBe("fixture-refresh");
            expect(stored).not.toHaveProperty("codeVerifier");
            expect(fixture.requests.join("\n")).not.toContain("legacy-refresh-secret");
            expect(fixture.requests.join("\n")).not.toContain("legacy-client-secret");
          } finally {
            await fixture.close();
          }
        },
        {
          prefix: "openclaw-mcp-legacy-explicit-login-",
          skipSessionCleanup: true,
          env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
        },
      );
    },
  );
});
