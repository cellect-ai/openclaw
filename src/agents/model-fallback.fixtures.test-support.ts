import { assert, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { AUTH_STORE_VERSION } from "./auth-profiles/constants.js";
import { createApiKeyCredential } from "./auth-profiles/credential-fixtures.test-support.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { isFallbackSummaryError } from "./model-fallback-attempt.js";
import { createModelFallbackConfig } from "./test-helpers/model-fallback-config-fixture.js";

export function makeProviderFallbackCfg(provider: string): OpenClawConfig {
  return createModelFallbackConfig(`${provider}/m1`, ["fallback/ok-model"]);
}

export function configuredFallback(primary: string, fallbacks: string[]) {
  const separator = primary.indexOf("/");
  return {
    cfg: createModelFallbackConfig(primary, fallbacks),
    provider: primary.slice(0, separator),
    model: primary.slice(separator + 1),
  };
}

export function recoverAfter(error: unknown, result = "ok") {
  return failInOrder(error).mockResolvedValueOnce(result);
}

export function failInOrder(...errors: unknown[]) {
  const run = vi.fn();
  for (const error of errors) {
    run.mockRejectedValueOnce(error);
  }
  return run;
}

export function namedError(name: string, message: string, cause?: unknown) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { name });
}

export function cooldown(cooldownUntil: number, cooldownModel: string) {
  return {
    cooldownUntil,
    cooldownModel,
    cooldownReason: "rate_limit" as const,
    lastRateLimitAt: 1,
  };
}

export function apiKeyStore(
  providers: string[],
  usageStats?: AuthProfileStore["usageStats"],
): AuthProfileStore {
  return {
    version: AUTH_STORE_VERSION,
    profiles: Object.fromEntries(
      providers.map((provider) => [
        `${provider}:default`,
        createApiKeyCredential(provider, "test-key"),
      ]),
    ),
    usageStats,
  };
}

export function oauthCredential(provider: string) {
  return {
    type: "oauth" as const,
    provider,
    access: "expired-access",
    refresh: "refresh-token",
    expires: 1,
  };
}

export function makeProviderOrderFallbackCfg(
  entries: Array<[provider: string, model: string]>,
): OpenClawConfig {
  return {
    models: {
      providers: Object.fromEntries(
        entries.map(([provider, model]) => [
          provider,
          { baseUrl: `https://${provider}.example.test`, models: [{ id: model }] },
        ]),
      ),
    },
  } as unknown as OpenClawConfig;
}

export async function expectFallbackSummary(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    assert(isFallbackSummaryError(error));
    return error;
  }
  throw new Error("expected fallback summary");
}

export function createFallbackOnlyRun() {
  return vi.fn().mockImplementation(async (providerId, modelId) => {
    if (providerId === "fallback") {
      return "ok";
    }
    throw new Error(`unexpected provider: ${providerId}/${modelId}`);
  });
}
