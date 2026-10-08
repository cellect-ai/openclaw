import fs from "node:fs/promises";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../config/types.mcp.js";
import { handleMcpOAuthCallback } from "../gateway/mcp-oauth-callback.js";
import { createRequest, createResponse } from "../gateway/server-http.test-harness.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  authorizationCode,
  startAuthorizationServer,
} from "./mcp-oauth-authorization-server.test-harness.js";
import { operatorMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import {
  readMcpOAuthPendingAuthorization as readPending,
  readMcpOAuthStore,
} from "./mcp-oauth-store.js";
import {
  clearMcpOAuthCredentials,
  completeMcpOAuthAuthorization,
  countMcpOAuthPrincipals,
  readMcpOAuthCredentialsStatus,
  recordMcpOAuthAuthorizationRequired,
  resolveMcpOAuthAccessToken,
  startMcpOAuthAuthorization,
} from "./mcp-oauth.js";
import { requesterIdentity, withTempHome } from "./mcp-oauth.test-harness.js";
import {
  resolvedOAuthConfig,
  seedMcpOAuthStoreForTest,
  withMcpOAuthProviderForTest,
} from "./mcp-oauth.test-support.js";
import { resolveMcpTransportConfig } from "./mcp-transport-config.js";

const authMock = vi.hoisted(() => vi.fn());
const ROTATED_ACCESS = "gateway-token";
const LEGACY_ACCESS = "example";
const REMOTE_IDENTITY = operatorMcpOAuthIdentity("Remote Docs", "https://mcp.example.com/mcp");
const CALENDLY_IDENTITY = operatorMcpOAuthIdentity("Calendly", "https://mcp.calendly.com/");
async function runGatewayOAuthCallback(params: {
  serverName: string;
  server: McpServerConfig;
  code: string;
  state: string;
}) {
  const response = createResponse();
  await handleMcpOAuthCallback(
    createRequest({
      path: `/oauth/mcp/callback?code=${params.code}&state=${params.state}`,
    }),
    response.res,
    {
      config: { mcp: { servers: { [params.serverName]: params.server } } },
      log: { warn: vi.fn() },
    },
  );
  return response;
}

async function persistRedirect(provider: OAuthClientProvider) {
  await provider.saveCodeVerifier("verifier");
  const authorizationUrl = new URL("https://auth.example.com/authorize");
  authorizationUrl.searchParams.set("redirect_uri", String(provider.redirectUrl));
  authorizationUrl.searchParams.set("state", "state-1234567890");
  await provider.redirectToAuthorization(authorizationUrl);
  return "REDIRECT" as const;
}

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  auth: authMock,
}));

describe("MCP OAuth provider", () => {
  beforeEach(async () => {
    authMock.mockReset();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  });

  it("reuses a valid stored session without persisting an authorization redirect", async () => {
    await withTempHome(
      async () => {
        await withMcpOAuthProviderForTest({ identity: REMOTE_IDENTITY }, async (provider) => {
          await provider.saveTokens({
            issuer: "https://auth.example.com",
            access_token: "stored-access",
            refresh_token: "stored-refresh",
            token_type: "Bearer",
            expires_in: 3600,
          });
        });
        const before = await readMcpOAuthStore(REMOTE_IDENTITY.storeKey);
        authMock.mockImplementationOnce(async (loginProvider) =>
          (await loginProvider.tokens()) ? "AUTHORIZED" : await persistRedirect(loginProvider),
        );

        await expect(
          startMcpOAuthAuthorization(REMOTE_IDENTITY, resolvedOAuthConfig(REMOTE_IDENTITY), {}),
        ).resolves.toEqual({ status: "authorized" });
        expect(await readMcpOAuthStore(REMOTE_IDENTITY.storeKey)).toEqual(before);
      },
      {
        prefix: "openclaw-mcp-oauth-existing-session-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("preserves insufficient scope and forces the next login through authorization", async () => {
    await withTempHome(
      async () => {
        await withMcpOAuthProviderForTest(
          {
            identity: REMOTE_IDENTITY,
          },
          async (provider) => {
            await provider.saveTokens({
              issuer: "https://auth.example.com",
              access_token: "decoy-token",
              refresh_token: "test-auth-token",
              token_type: "Bearer",
              expires_in: 3600,
            });
          },
        );

        await expect(
          resolveMcpOAuthAccessToken({
            identity: REMOTE_IDENTITY,
            authorizationChallenge: true,
            interactiveAuthorizationRequired: true,
            rejectedAccessToken: "decoy-token",
            scope: "docs.write",
          }),
        ).rejects.toThrow(
          'MCP server "Remote Docs" requires additional OAuth authorization. Run openclaw mcp login Remote Docs.',
        );
        expect(authMock).not.toHaveBeenCalled();
        expect(
          await withMcpOAuthProviderForTest(
            {
              identity: REMOTE_IDENTITY,
            },
            async (provider) => await provider.tokens(),
          ),
        ).toMatchObject({
          access_token: "decoy-token",
          refresh_token: "test-auth-token",
        });
        expect(
          (await readMcpOAuthStore(REMOTE_IDENTITY.storeKey)).pendingAuthorizationChallenge,
        ).toEqual({
          requiresAuthorization: true,
          scope: "docs.write",
        });
        await expect(readMcpOAuthCredentialsStatus(REMOTE_IDENTITY)).resolves.toMatchObject({
          state: "requires-authorization",
        });

        const storeKey = REMOTE_IDENTITY.storeKey;
        seedMcpOAuthStoreForTest(storeKey, {
          ...(await readMcpOAuthStore(storeKey)),
          tokenExpiresAt: 0,
        });
        await expect(
          resolveMcpOAuthAccessToken({
            identity: REMOTE_IDENTITY,
          }),
        ).rejects.toThrow("requires additional OAuth authorization");
        expect(authMock).not.toHaveBeenCalled();
        expect(await readMcpOAuthStore(storeKey)).toMatchObject({
          tokens: { access_token: "decoy-token" },
          tokenExpiresAt: 0,
          pendingAuthorizationChallenge: {
            requiresAuthorization: true,
            scope: "docs.write",
          },
        });

        authMock.mockImplementationOnce(async (loginProvider, options) => {
          expect(await loginProvider.tokens()).toBeUndefined();
          expect(options.scope).toBe("docs.write");
          return await persistRedirect(loginProvider);
        });
        await expect(
          startMcpOAuthAuthorization(REMOTE_IDENTITY, resolvedOAuthConfig(REMOTE_IDENTITY), {}),
        ).resolves.toMatchObject({ status: "redirect", state: "state-1234567890" });
        expect(
          await withMcpOAuthProviderForTest(
            {
              identity: REMOTE_IDENTITY,
            },
            async (provider) => await provider.tokens(),
          ),
        ).toMatchObject({ access_token: "decoy-token" });

        authMock.mockImplementationOnce(async (loginProvider) => {
          await loginProvider.invalidateCredentials?.("tokens");
          throw new Error("replacement authorization failed");
        });
        await expect(
          completeMcpOAuthAuthorization(REMOTE_IDENTITY, resolvedOAuthConfig(REMOTE_IDENTITY), {
            code: "expired-code",
          }),
        ).rejects.toThrow("replacement authorization failed");
        expect(await readMcpOAuthStore(storeKey)).toMatchObject({
          tokens: { access_token: "decoy-token" },
          tokenExpiresAt: 0,
          pendingAuthorizationChallenge: { requiresAuthorization: true },
        });

        authMock.mockImplementationOnce(async (loginProvider) => {
          await loginProvider.saveTokens({
            issuer: "https://auth.example.com",
            access_token: "gateway-token",
            refresh_token: "secret-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
          return "AUTHORIZED";
        });
        await expect(
          completeMcpOAuthAuthorization(REMOTE_IDENTITY, resolvedOAuthConfig(REMOTE_IDENTITY), {
            code: "valid-code",
          }),
        ).resolves.toBe("authorized");
        expect(await readMcpOAuthStore(storeKey)).toMatchObject({
          tokens: { access_token: ROTATED_ACCESS },
        });
        expect((await readMcpOAuthStore(storeKey)).pendingAuthorizationChallenge).toBeUndefined();
      },
      {
        prefix: "openclaw-mcp-oauth-insufficient-scope-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("stops refreshing after a replacement token is rejected twice", async () => {
    await withTempHome(
      async () => {
        await withMcpOAuthProviderForTest({ identity: REMOTE_IDENTITY }, async (provider) => {
          await provider.saveTokens({
            issuer: "https://auth.example.com",
            access_token: "replacement-token",
            refresh_token: "replacement-refresh",
            token_type: "Bearer",
            expires_in: 3600,
          });
        });

        await expect(
          recordMcpOAuthAuthorizationRequired({
            identity: REMOTE_IDENTITY,
            rejectedAccessToken: "replacement-token",
            scope: "docs.read",
          }),
        ).resolves.toBe(true);
        await expect(resolveMcpOAuthAccessToken({ identity: REMOTE_IDENTITY })).rejects.toThrow(
          "requires additional OAuth authorization",
        );
        expect(authMock).not.toHaveBeenCalled();
        expect(
          await withMcpOAuthProviderForTest(
            { identity: REMOTE_IDENTITY },
            async (provider) => await provider.tokens(),
          ),
        ).toMatchObject({ access_token: "replacement-token" });

        await withMcpOAuthProviderForTest(
          { identity: REMOTE_IDENTITY },
          async (provider) =>
            await provider.saveTokens({
              issuer: "https://auth.example.com",
              access_token: "newer-token",
              refresh_token: "newer-refresh",
              token_type: "Bearer",
              expires_in: 3600,
            }),
        );
        await expect(
          recordMcpOAuthAuthorizationRequired({
            identity: REMOTE_IDENTITY,
            rejectedAccessToken: "replacement-token",
          }),
        ).resolves.toBe(false);
        expect(
          await withMcpOAuthProviderForTest(
            { identity: REMOTE_IDENTITY },
            async (provider) => await provider.tokens(),
          ),
        ).toMatchObject({ access_token: "newer-token" });
      },
      {
        prefix: "openclaw-mcp-oauth-terminal-rejection-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("keeps a rejected-token challenge for explicit reauthorization after refresh fails", async () => {
    await withTempHome(
      async () => {
        await withMcpOAuthProviderForTest(
          {
            identity: REMOTE_IDENTITY,
          },
          async (provider) => {
            await provider.saveTokens({
              issuer: "https://auth.example.com",
              access_token: "decoy-token",
              refresh_token: "test-auth-token",
              token_type: "Bearer",
              expires_in: 3600,
            });
            await provider.saveDiscoveryState?.({
              authorizationServerUrl: "https://old-auth.example.com",
              resourceMetadataUrl:
                "https://mcp.example.com/.well-known/oauth-protected-resource/old",
            });
          },
        );
        const resourceMetadataUrl = new URL(
          "https://mcp.example.com/.well-known/oauth-protected-resource",
        );
        authMock.mockRejectedValueOnce(new Error("scope refresh rejected"));

        await expect(
          resolveMcpOAuthAccessToken({
            identity: REMOTE_IDENTITY,
            authorizationChallenge: true,
            rejectedAccessToken: "decoy-token",
            resourceMetadataUrl,
            scope: "docs.write",
          }),
        ).rejects.toThrow("scope refresh rejected");
        expect(await readMcpOAuthStore(REMOTE_IDENTITY.storeKey)).toMatchObject({
          pendingAuthorizationChallenge: {
            resourceMetadataUrl: resourceMetadataUrl.toString(),
            scope: "docs.write",
          },
        });
        expect((await readMcpOAuthStore(REMOTE_IDENTITY.storeKey)).discoveryState).toBeUndefined();

        authMock.mockImplementationOnce(persistRedirect);
        await expect(
          startMcpOAuthAuthorization(REMOTE_IDENTITY, resolvedOAuthConfig(REMOTE_IDENTITY), {}),
        ).resolves.toMatchObject({ state: "state-1234567890" });
        expect(authMock.mock.calls[1]?.[1]).toMatchObject({
          resourceMetadataUrl,
          scope: "docs.write",
        });
      },
      {
        prefix: "openclaw-mcp-oauth-rejected-token-challenge-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("uses a persisted challenge when refreshing after Doctor credential import", async () => {
    await withTempHome(
      async () => {
        const storeKey = REMOTE_IDENTITY.storeKey;
        const resourceMetadataUrl = new URL(
          "https://mcp.example.com/.well-known/oauth-protected-resource",
        );
        await withMcpOAuthProviderForTest({ identity: REMOTE_IDENTITY }, async (provider) => {
          await provider.saveTokens({
            issuer: "https://auth.example.com",
            access_token: "legacy-access",
            refresh_token: "legacy-refresh",
            token_type: "Bearer",
            expires_in: 3600,
          });
        });
        seedMcpOAuthStoreForTest(storeKey, {
          ...(await readMcpOAuthStore(storeKey)),
          tokenExpiresAt: 0,
          pendingAuthorizationChallenge: {
            resourceMetadataUrl: resourceMetadataUrl.toString(),
            scope: "docs.read",
          },
        });
        authMock.mockImplementationOnce(async (refreshProvider, options) => {
          expect(options).toMatchObject({ resourceMetadataUrl, scope: "docs.read" });
          await refreshProvider.saveTokens({
            issuer: "https://auth.example.com",
            access_token: "gateway-token",
            refresh_token: "secret-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
          return "AUTHORIZED";
        });

        await expect(resolveMcpOAuthAccessToken({ identity: REMOTE_IDENTITY })).resolves.toBe(
          ROTATED_ACCESS,
        );
        expect((await readMcpOAuthStore(storeKey)).pendingAuthorizationChallenge).toBeUndefined();
      },
      {
        prefix: "openclaw-mcp-oauth-doctor-challenge-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("uses unknown-expiry tokens live but refreshes them before blind projection", async () => {
    await withTempHome(
      async () => {
        await withMcpOAuthProviderForTest(
          {
            identity: REMOTE_IDENTITY,
          },
          async (provider) => {
            await provider.saveTokens({
              issuer: "https://auth.example.com",
              access_token: "example",
              refresh_token: "test-auth-token",
              token_type: "Bearer",
              expires_in: 3600,
            });
          },
        );
        const storeKey = REMOTE_IDENTITY.storeKey;
        const legacyStore = await readMcpOAuthStore(storeKey);
        delete legacyStore.tokenExpiresAt;
        seedMcpOAuthStoreForTest(storeKey, legacyStore);

        await expect(
          resolveMcpOAuthAccessToken({
            identity: REMOTE_IDENTITY,
            acceptUnknownExpiry: true,
          }),
        ).resolves.toBe(LEGACY_ACCESS);
        expect(authMock).not.toHaveBeenCalled();

        authMock.mockImplementationOnce(async (refreshProvider) => {
          await refreshProvider.saveTokens({
            issuer: "https://auth.example.com",
            access_token: "gateway-token",
            refresh_token: "secret-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
          return "AUTHORIZED";
        });

        await expect(
          resolveMcpOAuthAccessToken({
            identity: REMOTE_IDENTITY,
          }),
        ).resolves.toBe(ROTATED_ACCESS);
        expect(authMock).toHaveBeenCalledOnce();
      },
      {
        prefix: "openclaw-mcp-oauth-legacy-token-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("requires explicit login when no native OAuth credentials exist", async () => {
    await withTempHome(
      async () => {
        await expect(
          resolveMcpOAuthAccessToken({
            identity: REMOTE_IDENTITY,
          }),
        ).rejects.toThrow("Run openclaw mcp login Remote Docs.");
        expect(authMock).not.toHaveBeenCalled();
      },
      {
        prefix: "openclaw-mcp-oauth-missing-token-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("marks challenge-only bootstrap state as safe for Doctor credential import", async () => {
    await withTempHome(
      async () => {
        await expect(
          resolveMcpOAuthAccessToken({
            identity: REMOTE_IDENTITY,
            authorizationChallenge: true,
            scope: "docs.read",
          }),
        ).rejects.toThrow("Run openclaw mcp login Remote Docs.");
        expect(await readMcpOAuthStore(REMOTE_IDENTITY.storeKey)).toMatchObject({
          credentialState: "uninitialized",
          pendingAuthorizationChallenge: { scope: "docs.read" },
        });
      },
      {
        prefix: "openclaw-mcp-oauth-challenge-provenance-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("persists challenge hints without mutating an in-flight PKCE login", async () => {
    await withTempHome(
      async () => {
        const resourceMetadataUrl = new URL(
          "https://mcp.example.com/.well-known/oauth-protected-resource",
        );
        await withMcpOAuthProviderForTest(
          {
            identity: REMOTE_IDENTITY,
            allowAuthorizationRedirect: true,
          },
          async (provider) => {
            await provider.saveCodeVerifier("existing-verifier");
            expect(await provider.codeVerifier()).toBe("existing-verifier");
            await provider.redirectToAuthorization(
              new URL("https://auth.example.com/authorize?state=existing-state"),
            );
          },
        );

        await expect(
          resolveMcpOAuthAccessToken({
            identity: REMOTE_IDENTITY,
            authorizationChallenge: true,
            resourceMetadataUrl,
            scope: "docs.read",
          }),
        ).rejects.toThrow("Run openclaw mcp login Remote Docs.");
        expect(authMock).not.toHaveBeenCalled();
        expect(await readMcpOAuthStore(REMOTE_IDENTITY.storeKey)).toMatchObject({
          codeVerifier: "existing-verifier",
          pendingAuthorizationChallenge: {
            resourceMetadataUrl: resourceMetadataUrl.toString(),
            scope: "docs.read",
          },
        });

        authMock.mockImplementationOnce(persistRedirect);
        await expect(
          startMcpOAuthAuthorization(REMOTE_IDENTITY, resolvedOAuthConfig(REMOTE_IDENTITY), {}),
        ).resolves.toMatchObject({ state: "state-1234567890" });
        expect(authMock.mock.calls[0]?.[1]).toMatchObject({
          resourceMetadataUrl,
          scope: "docs.read",
        });
      },
      {
        prefix: "openclaw-mcp-oauth-challenge-bootstrap-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("stores token state only in shared SQLite with restricted permissions", async () => {
    await withTempHome(
      async (home) => {
        await withMcpOAuthProviderForTest(
          {
            identity: REMOTE_IDENTITY,
          },
          async (provider) => {
            await provider.saveTokens({
              issuer: "https://auth.example.com",
              access_token: "access",
              token_type: "Bearer",
            });

            expect(await provider.tokens()).toEqual({
              issuer: "https://auth.example.com",
              access_token: "access",
              token_type: "Bearer",
            });
          },
        );

        const databasePath = resolveOpenClawStateSqlitePath();
        const rows = openOpenClawStateDatabase()
          .db.prepare("SELECT store_key, format_version FROM mcp_oauth_stores")
          .all();
        expect(rows).toEqual([
          { store_key: expect.stringMatching(/^Remote-Docs-[a-f0-9]{16}$/), format_version: 1 },
        ]);
        await expect(fs.readdir(`${home}/.openclaw/mcp-oauth`)).rejects.toMatchObject({
          code: "ENOENT",
        });
        const stat = await fs.stat(databasePath);
        expect(stat.mode & 0o777).toBe(0o600);
      },
      {
        prefix: "openclaw-mcp-oauth-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("does not create shared state for a read-only credential status check", async () => {
    await withTempHome(
      async () => {
        await expect(readMcpOAuthCredentialsStatus(REMOTE_IDENTITY)).resolves.toEqual({
          state: "unauthenticated",
        });
        expect(await countMcpOAuthPrincipals(REMOTE_IDENTITY)).toBe(0);
        await expect(fs.stat(resolveOpenClawStateSqlitePath())).rejects.toMatchObject({
          code: "ENOENT",
        });
        const database = openOpenClawStateDatabase().db;
        database.exec("DROP TABLE mcp_oauth_stores");
        expect(await countMcpOAuthPrincipals(REMOTE_IDENTITY)).toBe(0);
        expect(
          database.prepare("SELECT name FROM sqlite_schema WHERE name = ?").get("mcp_oauth_stores"),
        ).toBeUndefined();
      },
      {
        prefix: "openclaw-mcp-oauth-status-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("updates provider fields atomically and clears token expiry on invalidation", async () => {
    await withTempHome(
      async () => {
        await withMcpOAuthProviderForTest(
          {
            identity: REMOTE_IDENTITY,
            allowAuthorizationRedirect: true,
          },
          async (provider) => {
            await provider.saveClientInformation?.({
              client_id: "client-id",
              issuer: "https://auth.example.com",
            });
            await provider.saveTokens({
              issuer: "https://auth.example.com",
              access_token: "access",
              refresh_token: "refresh",
              token_type: "Bearer",
              expires_in: 3600,
            });
            await provider.saveCodeVerifier("verifier");
            expect(await provider.codeVerifier()).toBe("verifier");
            await provider.redirectToAuthorization(
              new URL("https://auth.example.com/authorize?state=published-state"),
            );
            await provider.invalidateCredentials?.("tokens");
          },
        );

        const store = await readMcpOAuthStore(REMOTE_IDENTITY.storeKey);
        expect(store.clientInformation).toEqual({
          client_id: "client-id",
          issuer: "https://auth.example.com",
        });
        expect(store.codeVerifier).toBe("verifier");
        expect(store.tokens).toBeUndefined();
        expect(store.tokenExpiresAt).toBeUndefined();
        expect(store.credentialState).toBe("cleared");
      },
      {
        prefix: "openclaw-mcp-oauth-atomic-fields-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("fails closed when canonical token expiry has no token state", async () => {
    await withTempHome(
      async () => {
        await withMcpOAuthProviderForTest(
          {
            identity: REMOTE_IDENTITY,
          },
          async (provider) => {
            await provider.saveTokens({
              issuer: "https://auth.example.com",
              access_token: "access",
              token_type: "Bearer",
            });
            const storeKey = REMOTE_IDENTITY.storeKey;
            openOpenClawStateDatabase()
              .db.prepare("UPDATE mcp_oauth_stores SET store_json = ? WHERE store_key = ?")
              .run(JSON.stringify({ tokenExpiresAt: 10_000 }), storeKey);

            await expect(provider.tokens()).rejects.toThrow("tokenExpiresAt requires tokens");
          },
        );
      },
      {
        prefix: "openclaw-mcp-oauth-orphan-expiry-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("persists the localhost retry for completion and then clears the session", async () => {
    await withTempHome(
      async () => {
        authMock
          .mockRejectedValueOnce(new Error("invalid_client_metadata: redirect_uri rejected"))
          .mockImplementationOnce(persistRedirect);

        const session = await startMcpOAuthAuthorization(
          CALENDLY_IDENTITY,
          resolvedOAuthConfig(CALENDLY_IDENTITY),
          {},
        );
        if (session.status !== "redirect") {
          throw new Error("expected MCP OAuth redirect");
        }

        expect(session.redirectUrl).toBe("http://localhost:8989/oauth/callback");
        expect(authMock.mock.calls[1]?.[0]?.clientMetadata.redirect_uris).toEqual([
          "http://localhost:8989/oauth/callback",
        ]);
        expect(await readMcpOAuthStore(CALENDLY_IDENTITY.storeKey)).toMatchObject({
          codeVerifier: "verifier",
          redirectUrl: "http://localhost:8989/oauth/callback",
        });

        authMock.mockReset();
        authMock.mockImplementationOnce(async (provider, options) => {
          expect(options.authorizationCode).toBe("code-123");
          expect(provider.redirectUrl).toBe("http://localhost:8989/oauth/callback");
          expect(await provider.codeVerifier()).toBe("verifier");
          return "AUTHORIZED";
        });
        await expect(
          completeMcpOAuthAuthorization(CALENDLY_IDENTITY, resolvedOAuthConfig(CALENDLY_IDENTITY), {
            code: "code-123",
          }),
        ).resolves.toBe("authorized");
        expect(await readMcpOAuthStore(CALENDLY_IDENTITY.storeKey)).not.toMatchObject({
          codeVerifier: expect.anything(),
          redirectUrl: expect.anything(),
        });
      },
      {
        prefix: "openclaw-mcp-oauth-localhost-persist-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("does not retry a code exchange redirect mismatch", async () => {
    await withTempHome(
      async () => {
        authMock.mockImplementationOnce(persistRedirect);
        await startMcpOAuthAuthorization(
          CALENDLY_IDENTITY,
          resolvedOAuthConfig(CALENDLY_IDENTITY),
          {},
        );
        authMock.mockReset();
        authMock.mockRejectedValueOnce(new Error("invalid_grant: redirect_uri mismatch"));

        await expect(
          completeMcpOAuthAuthorization(CALENDLY_IDENTITY, resolvedOAuthConfig(CALENDLY_IDENTITY), {
            code: "code-123",
          }),
        ).rejects.toThrow("redirect_uri mismatch");
        expect(authMock).toHaveBeenCalledOnce();
      },
      {
        prefix: "openclaw-mcp-oauth-code-mismatch-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("does not persist localhost when the fallback attempt fails", async () => {
    await withTempHome(
      async () => {
        authMock.mockReset();
        authMock
          .mockRejectedValueOnce(new Error("invalid_client_metadata: redirect_uri rejected"))
          .mockRejectedValueOnce(new Error("localhost redirect also rejected"));

        await expect(
          startMcpOAuthAuthorization(CALENDLY_IDENTITY, resolvedOAuthConfig(CALENDLY_IDENTITY), {}),
        ).rejects.toThrow("localhost redirect also rejected");

        expect(await readMcpOAuthStore(CALENDLY_IDENTITY.storeKey)).toEqual({});
      },
      {
        prefix: "openclaw-mcp-oauth-localhost-failure-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("does not start hidden authorization flows without an authorization callback", async () => {
    await withTempHome(
      async () => {
        await withMcpOAuthProviderForTest(
          {
            identity: REMOTE_IDENTITY,
          },
          async (provider) => {
            await expect(provider.state?.()).rejects.toThrow("Run openclaw mcp login Remote Docs.");
            expect(() => provider.saveCodeVerifier?.("verifier")).toThrow(
              "Run openclaw mcp login Remote Docs.",
            );
            await expect(
              provider.redirectToAuthorization?.(new URL("https://auth.example.com/authorize")),
            ).rejects.toThrow("Run openclaw mcp login Remote Docs.");
          },
        );
      },
      {
        prefix: "openclaw-mcp-oauth-noninteractive-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("clears stored credentials for a configured server URL", async () => {
    await withTempHome(
      async () => {
        await withMcpOAuthProviderForTest(
          {
            identity: REMOTE_IDENTITY,
          },
          async (provider) => {
            await provider.saveTokens({
              issuer: "https://auth.example.com",
              access_token: "access",
              token_type: "Bearer",
            });
          },
        );

        await clearMcpOAuthCredentials(REMOTE_IDENTITY);

        expect(
          await withMcpOAuthProviderForTest(
            {
              identity: REMOTE_IDENTITY,
            },
            async (provider) => await provider.tokens(),
          ),
        ).toBeUndefined();
        expect((await readMcpOAuthStore(REMOTE_IDENTITY.storeKey)).credentialState).toBe("cleared");
      },
      {
        prefix: "openclaw-mcp-oauth-clear-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("resumes authorization after restart, retains failures, and supersedes older starts", async () => {
    await withTempHome(
      async () => {
        const { auth: realAuth } = await vi.importActual<
          typeof import("@modelcontextprotocol/sdk/client/auth.js")
        >("@modelcontextprotocol/sdk/client/auth.js");
        authMock.mockImplementation(realAuth);
        const fixture = await startAuthorizationServer();
        const rawServer = {
          url: `${fixture.issuer}/mcp`,
          transport: "streamable-http" as const,
          auth: "oauth" as const,
          oauth: {
            identity: "per-requester" as const,
            redirectUrl: "https://gateway.example.com/oauth/mcp/callback",
          },
        };
        const config = resolveMcpTransportConfig("fixture", rawServer);
        if (config?.kind !== "http") {
          throw new Error("expected HTTP MCP OAuth config");
        }
        const identity = requesterIdentity("fixture", config.url, "sender-a");
        try {
          const first = await startMcpOAuthAuthorization(identity, config, {});
          if (first.status !== "redirect") {
            throw new Error("expected first MCP OAuth redirect");
          }
          expect(await readMcpOAuthStore(identity.storeKey)).toMatchObject({
            codeVerifier: expect.any(String),
            lastAuthorizationUrl: first.authorizationUrl,
            redirectUrl: first.redirectUrl,
          });
          await closeOpenClawStateDatabaseAsync();
          closeOpenClawStateDatabaseForTest();
          const callbacks = await Promise.all(
            [0, 1].map(() =>
              runGatewayOAuthCallback({
                serverName: "fixture",
                server: rawServer,
                code: authorizationCode(first.authorizationUrl),
                state: first.state,
              }),
            ),
          );
          expect(callbacks.map(({ res }) => res.statusCode).toSorted((a, b) => a - b)).toEqual([
            200, 404,
          ]);
          expect(await readMcpOAuthStore(identity.storeKey)).toMatchObject({
            tokens: { access_token: expect.any(String) },
          });
          expect(await readMcpOAuthStore(identity.storeKey)).not.toHaveProperty("codeVerifier");

          const secondIdentity = requesterIdentity("fixture", config.url, "sender-b");
          const second = await startMcpOAuthAuthorization(secondIdentity, config, {});
          if (second.status !== "redirect") {
            throw new Error("expected second MCP OAuth redirect");
          }
          await expect(
            completeMcpOAuthAuthorization(secondIdentity, config, { code: "wrong-code" }),
          ).rejects.toThrow();
          expect(await readMcpOAuthStore(secondIdentity.storeKey)).toMatchObject({
            lastAuthorizationUrl: second.authorizationUrl,
            redirectUrl: second.redirectUrl,
            codeVerifier: expect.any(String),
          });
          expect(await readMcpOAuthStore(secondIdentity.storeKey)).not.toHaveProperty("tokens");

          const third = await startMcpOAuthAuthorization(secondIdentity, config, {});
          if (third.status !== "redirect") {
            throw new Error("expected third MCP OAuth redirect");
          }
          expect(third.authorizationUrl).not.toBe(second.authorizationUrl);
          expect(await readPending(second.state)).toBeUndefined();
          expect(await readPending(third.state)).toBe(secondIdentity.storeKey);
          await expect(
            completeMcpOAuthAuthorization(secondIdentity, config, {
              code: authorizationCode(second.authorizationUrl),
            }),
          ).rejects.toThrow();
          expect((await readMcpOAuthStore(secondIdentity.storeKey)).lastAuthorizationUrl).toBe(
            third.authorizationUrl,
          );
          await expect(
            completeMcpOAuthAuthorization(secondIdentity, config, {
              code: authorizationCode(third.authorizationUrl),
            }),
          ).resolves.toBe("authorized");
        } finally {
          await fixture.close();
        }
      },
      {
        prefix: "openclaw-mcp-oauth-session-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });
});
