/** MCP SDK OAuth provider backed by canonical OpenClaw state. */
import { randomUUID } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawStateAsyncLeaseContext } from "../state/openclaw-state-lease.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { McpOAuthIdentity } from "./mcp-oauth-identity.js";
import { readMcpOAuthStore, mutateMcpOAuthStore, type McpOAuthStore } from "./mcp-oauth-store.js";
import { MCP_OAUTH_DEFAULT_REDIRECT_URL } from "./mcp-oauth-store.mutations.js";
import type { McpOAuthMutation } from "./mcp-oauth-store.types.js";

export type McpOAuthConfig = {
  scope?: unknown;
  redirectUrl?: unknown;
  clientMetadataUrl?: unknown;
};

export type McpOAuthLoginLifecycle = {
  signal: AbortSignal;
  assertCurrent: () => void;
  onAuthorizationPublished: (state: string) => void;
  beforeTokensSaved: () => void;
  onTokensSaved: () => void;
};

type McpOAuthMutationAuthority = {
  assertCurrent: () => void;
  beforeCommit?: () => void;
};

function resolveTokenExpiresAt(tokens: OAuthTokens): number | undefined {
  const expiresIn = tokens.expires_in;
  return typeof expiresIn === "number" && Number.isFinite(expiresIn)
    ? Date.now() + expiresIn * 1000
    : undefined;
}

function hasCredentialIssuer(credential: OAuthTokens | OAuthClientInformationMixed): boolean {
  if (typeof credential.issuer !== "string") {
    return false;
  }
  if (!URL.canParse(credential.issuer)) {
    return false;
  }
  const issuer = new URL(credential.issuer);
  return issuer.protocol === "https:" || issuer.protocol === "http:";
}

/** Stored discovery is mutable; only the SDK's credential stamp is issuer authority. */
export function hasUnboundMcpOAuthCredentials(store: McpOAuthStore): boolean {
  return (
    (store.clientInformation !== undefined && !hasCredentialIssuer(store.clientInformation)) ||
    (store.tokens !== undefined && !hasCredentialIssuer(store.tokens)) ||
    (store.clientInformation !== undefined &&
      store.tokens !== undefined &&
      store.clientInformation.issuer !== store.tokens.issuer)
  );
}

function resolveOAuthRedirectUrl(config: McpOAuthConfig, store: McpOAuthStore = {}): string {
  return (
    normalizeOptionalString(config.redirectUrl) ??
    normalizeOptionalString(store.redirectUrl) ??
    MCP_OAUTH_DEFAULT_REDIRECT_URL
  );
}

function buildOAuthClientMetadata(
  config: McpOAuthConfig,
  store: McpOAuthStore = {},
): OAuthClientMetadata {
  const redirectUrl = resolveOAuthRedirectUrl(config, store);
  return {
    client_name: "OpenClaw MCP",
    redirect_uris: [redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(normalizeOptionalString(config.scope)
      ? { scope: normalizeOptionalString(config.scope) }
      : {}),
  };
}

/** Bind OAuth network work to the lease that fences its persisted side effects. */
export function withMcpOAuthLeaseSignal(
  fetchFn: FetchLike | undefined,
  leaseSignal: AbortSignal,
  assertCurrent?: () => void,
): FetchLike {
  const baseFetch: FetchLike = fetchFn ?? ((url, init) => fetch(url, init));
  return async (url, init) => {
    assertCurrent?.();
    const requestSignal = init?.signal;
    const signal = requestSignal ? AbortSignal.any([requestSignal, leaseSignal]) : leaseSignal;
    const response = await baseFetch(url, { ...init, signal });
    assertCurrent?.();
    return response;
  };
}

/** Creates the MCP SDK OAuth provider backed by canonical shared SQLite state. */
export async function createMcpOAuthClientProvider(params: {
  identity: McpOAuthIdentity;
  config?: McpOAuthConfig;
  allowAuthorizationRedirect?: boolean;
  suppressStoredTokens?: boolean;
  lease: OpenClawStateAsyncLeaseContext;
  login?: McpOAuthLoginLifecycle;
  storeContext: OpenClawStateWorkerContext;
}): Promise<OAuthClientProvider> {
  const config = params.config ?? {};
  const storeKey = params.identity.storeKey;
  const storeContext = params.storeContext;
  let preparedVerifier: string | undefined;
  let prepared: { redirectUrl?: string } | { error: unknown } = {};
  let preparation = 0;
  let nextWrite = 0;
  let lastSettledWrite = 0;
  // Explicit sign-in may replace legacy credentials, but never offer their
  // refresh grant to a freshly registered client during that sign-in.
  let freshAuthorizationRequired = false;
  let tokensIssued = false;
  const settleWrite = (write: number, value: typeof prepared) => {
    if (write < lastSettledWrite) {
      return;
    }
    lastSettledWrite = write;
    // Reads dispatched before settlement may still carry the pre-write snapshot.
    preparation++;
    prepared = value;
  };
  const readStore = async () => {
    params.login?.assertCurrent();
    const currentPreparation = ++preparation;
    const store = await readMcpOAuthStore(storeKey, storeContext);
    params.login?.assertCurrent();
    await params.lease.assertOwned();
    params.login?.assertCurrent();
    if (currentPreparation === preparation) {
      if (
        params.allowAuthorizationRedirect === true &&
        (hasUnboundMcpOAuthCredentials(store) ||
          (!tokensIssued &&
            store.codeVerifier !== undefined &&
            store.lastAuthorizationUrl !== undefined))
      ) {
        freshAuthorizationRequired = true;
      }
      prepared = { redirectUrl: store.redirectUrl };
    }
    return store;
  };
  await readStore();
  params.login?.assertCurrent();
  const updateStore = async (
    mutation: McpOAuthMutation,
    options: { beforeCommit?: () => void; onAcknowledged?: () => void } = {},
  ) => {
    params.login?.assertCurrent();
    preparation++;
    const write = ++nextWrite;
    const authority: McpOAuthMutationAuthority | undefined = params.login
      ? { assertCurrent: params.login.assertCurrent, beforeCommit: options.beforeCommit }
      : undefined;
    try {
      const { store } = await mutateMcpOAuthStore(
        { storeKey, lease: params.lease, context: storeContext },
        mutation,
        authority,
      );
      // Record acknowledged persistence before a later authority loss can reject publication.
      options.onAcknowledged?.();
      params.login?.assertCurrent();
      settleWrite(write, { redirectUrl: store.redirectUrl });
      return store;
    } catch (error) {
      // A possible commit invalidates earlier reads until a new read is acknowledged.
      settleWrite(write, { error });
      throw error;
    }
  };
  const preparedStore = () => {
    if ("error" in prepared) {
      throw prepared.error;
    }
    return prepared;
  };
  const assertAuthorizationRedirectAllowed = () => {
    params.login?.assertCurrent();
    if (params.allowAuthorizationRedirect !== true) {
      throw new Error(
        `MCP server "${params.identity.serverName}" requires OAuth authorization. Run openclaw mcp login ${params.identity.serverName}.`,
      );
    }
  };
  const assertCredentialsBound = (store: McpOAuthStore) => {
    if (hasUnboundMcpOAuthCredentials(store) && params.allowAuthorizationRedirect !== true) {
      throw new Error(
        `MCP server "${params.identity.serverName}" has OAuth credentials without a trustworthy issuer. Run openclaw mcp login ${params.identity.serverName} to sign in again.`,
      );
    }
  };
  return {
    get redirectUrl() {
      return resolveOAuthRedirectUrl(config, preparedStore());
    },
    clientMetadataUrl: normalizeOptionalString(config.clientMetadataUrl),
    get clientMetadata() {
      return buildOAuthClientMetadata(config, preparedStore());
    },
    async state() {
      assertAuthorizationRedirectAllowed();
      if (params.login) {
        const store = await readStore();
        params.login.assertCurrent();
        if (
          store.tokens?.access_token &&
          !freshAuthorizationRequired &&
          store.pendingAuthorizationChallenge?.requiresAuthorization !== true &&
          (store.tokenExpiresAt === undefined || store.tokenExpiresAt > Date.now())
        ) {
          throw new Error(
            "Existing authentication could not be refreshed. Use the CLI sign-in flow.",
          );
        }
      }
      // State validates one browser round trip. It is not reusable persisted state.
      return randomUUID();
    },
    async clientInformation() {
      const store = await readStore();
      params.login?.assertCurrent();
      assertCredentialsBound(store);
      const authorizationServerUrl = store.discoveryState?.authorizationServerUrl;
      if (
        params.allowAuthorizationRedirect !== true &&
        store.clientInformation !== undefined &&
        authorizationServerUrl !== undefined &&
        store.clientInformation.issuer !== authorizationServerUrl
      ) {
        // Discovery identifies this request's destination, never an old credential's authority.
        // Stop before the SDK can register a replacement client and overwrite the stored pair.
        assertAuthorizationRedirectAllowed();
      }
      return store.clientInformation && hasCredentialIssuer(store.clientInformation)
        ? store.clientInformation
        : undefined;
    },
    async saveClientInformation(clientInformation) {
      await updateStore({ kind: "clientInformation", clientInformation });
      params.login?.assertCurrent();
    },
    async tokens() {
      if (params.suppressStoredTokens) {
        params.login?.assertCurrent();
        await params.lease.assertOwned();
        params.login?.assertCurrent();
        return undefined;
      }
      const store = await readStore();
      params.login?.assertCurrent();
      assertCredentialsBound(store);
      if (freshAuthorizationRequired) {
        return undefined;
      }
      const discoveredAuthorizationServerUrl = store.discoveryState?.authorizationServerUrl;
      if (!store.tokens?.refresh_token || discoveredAuthorizationServerUrl === undefined) {
        return store.tokens;
      }
      return store.tokensAuthorizationServerUrl !== undefined &&
        discoveredAuthorizationServerUrl === store.tokensAuthorizationServerUrl
        ? store.tokens
        : undefined;
    },
    async saveTokens(tokens) {
      await updateStore(
        { kind: "tokens", tokens, tokenExpiresAt: resolveTokenExpiresAt(tokens) },
        {
          beforeCommit: params.login?.beforeTokensSaved,
          onAcknowledged: params.login?.onTokensSaved,
        },
      );
      tokensIssued = true;
      freshAuthorizationRequired = false;
      params.login?.assertCurrent();
    },
    async redirectToAuthorization(authorizationUrl) {
      assertAuthorizationRedirectAllowed();
      const state = authorizationUrl.searchParams.get("state");
      if (params.login && (!state || !preparedVerifier)) {
        throw new Error("MCP OAuth authorization preparation is incomplete.");
      }
      await updateStore(
        {
          kind: "authorizationRedirect",
          authorizationUrl: authorizationUrl.toString(),
          redirectUrl: normalizeOptionalString(config.redirectUrl),
          codeVerifier: preparedVerifier,
        },
        {
          onAcknowledged: () => {
            preparedVerifier = undefined;
            if (state) {
              params.login?.onAuthorizationPublished(state);
            }
          },
        },
      );
      params.login?.assertCurrent();
    },
    saveCodeVerifier(codeVerifier) {
      assertAuthorizationRedirectAllowed();
      preparedVerifier = codeVerifier;
    },
    async codeVerifier() {
      params.login?.assertCurrent();
      let codeVerifier = preparedVerifier;
      if (codeVerifier !== undefined) {
        await params.lease.assertOwned();
        params.login?.assertCurrent();
      } else {
        const store = await readStore();
        params.login?.assertCurrent();
        codeVerifier = store.codeVerifier;
      }
      if (!codeVerifier) {
        throw new Error("Missing MCP OAuth code verifier. Run the login flow again.");
      }
      return codeVerifier;
    },
    async invalidateCredentials(scope) {
      params.login?.assertCurrent();
      if (params.login) {
        throw new Error("Existing authentication was retained. Use the CLI sign-in flow.");
      }
      const store = await readStore();
      if (hasUnboundMcpOAuthCredentials(store)) {
        throw new Error("Legacy OAuth credentials were retained. Use the CLI sign-in flow.");
      }
      await updateStore({
        kind: "invalidate",
        scope,
        suppressStoredTokens: params.suppressStoredTokens === true,
      });
    },
    async saveDiscoveryState(discoveryState) {
      await updateStore({ kind: "discoveryState", discoveryState });
      params.login?.assertCurrent();
    },
    async discoveryState() {
      const store = await readStore();
      params.login?.assertCurrent();
      return store.discoveryState;
    },
  };
}
