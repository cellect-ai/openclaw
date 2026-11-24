// Focused tests: unresolved SecretRefs must not throw at normalize time,
// and the hydrated OPENAI_REALTIME_API_KEY env name is honored alongside
// OPENAI_API_KEY (precedence preserved). No secret values are asserted.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasOpenAIRealtimeApiKeyInput,
  hasOpenAIRealtimePlatformAuthInput,
  normalizeProviderConfig,
  requireOpenAIRealtimePlatformAuth,
  resolveOpenAIRealtimeEnvApiKey,
  resolveOpenAIRealtimePlatformAuth,
} from "./realtime-voice-session-policy.js";

const ENV_A = "OPENAI_API_KEY";
const ENV_REALTIME = "OPENAI_REALTIME_API_KEY";

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of [ENV_A, ENV_REALTIME]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of [ENV_A, ENV_REALTIME]) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

const UNRESOLVED_REF = {
  source: "env",
  provider: "default",
  id: "OPENAI_REALTIME_API_KEY",
} as const;

const noProfiles = {
  isProviderAuthProfileConfigured: () => false,
  resolveAgentDir: () => "/nonexistent-agent-dir",
} as never;

const noProfileKey = {
  resolveProviderAuthProfileApiKey: async () => undefined,
  resolveAgentDir: () => "/nonexistent-agent-dir",
} as never;

describe("normalizeProviderConfig SecretRef custody", () => {
  it("passes literal apiKey strings through unchanged (explicit precedence)", () => {
    const normalized = normalizeProviderConfig({ apiKey: "live-key-value" }, {});
    expect(normalized.apiKey).toBe("live-key-value");
  });

  it("resolves the builtin-default realtime ref with empty gateway config", () => {
    process.env[ENV_REALTIME] = "realtime-key";
    const normalized = normalizeProviderConfig({ apiKey: UNRESOLVED_REF }, {});
    expect(normalized.apiKey).toBe("realtime-key");
  });

  it("resolves the builtin-default realtime ref without config context", () => {
    process.env[ENV_REALTIME] = "realtime-key";
    const normalized = normalizeProviderConfig({ apiKey: UNRESOLVED_REF });
    expect(normalized.apiKey).toBe("realtime-key");
  });

  it("honors an explicit env allowlist that includes the key", () => {
    process.env[ENV_REALTIME] = "realtime-key";
    const cfg = {
      secrets: { providers: { default: { source: "env", allowlist: [ENV_REALTIME] } } },
    } as never;
    const normalized = normalizeProviderConfig({ apiKey: UNRESOLVED_REF }, cfg);
    expect(normalized.apiKey).toBe("realtime-key");
  });

  it("denies an explicit env allowlist that excludes the key", () => {
    process.env[ENV_REALTIME] = "realtime-key";
    const cfg = {
      secrets: { providers: { default: { source: "env", allowlist: ["SOME_OTHER_KEY"] } } },
    } as never;
    expect(() => normalizeProviderConfig({ apiKey: UNRESOLVED_REF }, cfg)).toThrow(
      /active gateway runtime snapshot/,
    );
  });

  it("denies a custom default alias for the env source", () => {
    process.env[ENV_REALTIME] = "realtime-key";
    const cfg = {
      secrets: {
        defaults: { env: "custom-vault" },
        providers: { "custom-vault": { source: "env" } },
      },
    } as never;
    expect(() => normalizeProviderConfig({ apiKey: UNRESOLVED_REF }, cfg)).toThrow(
      /active gateway runtime snapshot/,
    );
  });

  it("fails closed when the env ref has no hydrated value", () => {
    expect(() => normalizeProviderConfig({ apiKey: UNRESOLVED_REF }, {})).toThrow(
      /Resolve this command against an active gateway runtime snapshot/,
    );
  });

  it("resolves string-form ${OPENAI_REALTIME_API_KEY} via coerce-before-literal", () => {
    process.env[ENV_REALTIME] = "realtime-key";
    const normalized = normalizeProviderConfig(
      {
        apiKey: "${OPENAI_REALTIME_API_KEY}",
      },
      {},
    );
    expect(normalized.apiKey).toBe("realtime-key");
  });

  it("never mints string-form refs as literal bearer text", () => {
    expect(() => normalizeProviderConfig({ apiKey: "$SOME_OTHER_KEY" }, {})).toThrow(
      /active gateway runtime snapshot/,
    );
  });

  it("rejects named (non-default) providers: needs gateway config context", () => {
    process.env[ENV_REALTIME] = "realtime-key";
    expect(() =>
      normalizeProviderConfig(
        {
          apiKey: { source: "env", provider: "my-vault", id: ENV_REALTIME },
        },
        {},
      ),
    ).toThrow(/active gateway runtime snapshot/);
  });

  it("rejects other env names even with another fallback key hydrated", () => {
    process.env[ENV_A] = "fallback-key";
    expect(() =>
      normalizeProviderConfig(
        {
          apiKey: { source: "env", provider: "default", id: "SOME_OTHER_KEY" },
        },
        {},
      ),
    ).toThrow(/active gateway runtime snapshot/);
  });

  it("rejects string-form refs to other names even when hydrated", () => {
    process.env[ENV_A] = "fallback-key";
    expect(() => normalizeProviderConfig({ apiKey: "${OPENAI_API_KEY}" }, {})).toThrow(
      /active gateway runtime snapshot/,
    );
  });

  it("fails closed on exec-source refs", () => {
    expect(() =>
      normalizeProviderConfig(
        {
          apiKey: { source: "exec", provider: "default", id: "echo key" },
        },
        {},
      ),
    ).toThrow();
  });

  it("fails closed on file-source refs (snapshot machinery owns them)", () => {
    expect(() =>
      normalizeProviderConfig(
        {
          apiKey: { source: "file", provider: "mounted-json", id: "/providers/openai/apiKey" },
        },
        {},
      ),
    ).toThrow();
  });

  it("treats malformed non-ref input as absent: no credential minted, auth refuses downstream", () => {
    expect(normalizeProviderConfig({ apiKey: { bogus: true } }, {}).apiKey).toBeUndefined();
  });

  it("leaves absent apiKey undefined without throwing", () => {
    expect(normalizeProviderConfig({}, {}).apiKey).toBeUndefined();
  });
});

describe("OPENAI_REALTIME_API_KEY env fallback", () => {
  it("prefers OPENAI_API_KEY when both names are hydrated", () => {
    process.env[ENV_A] = "primary-key";
    process.env[ENV_REALTIME] = "realtime-key";
    expect(resolveOpenAIRealtimeEnvApiKey()).toBe("primary-key");
  });

  it("uses OPENAI_REALTIME_API_KEY when OPENAI_API_KEY is absent", () => {
    process.env[ENV_REALTIME] = "realtime-key";
    expect(resolveOpenAIRealtimeEnvApiKey()).toBe("realtime-key");
    expect(hasOpenAIRealtimeApiKeyInput(undefined)).toBe(true);
  });

  it("reports no input when neither name is hydrated", () => {
    expect(resolveOpenAIRealtimeEnvApiKey()).toBeUndefined();
    expect(hasOpenAIRealtimeApiKeyInput(undefined)).toBe(false);
  });

  it("platform auth check passes on the realtime env name without profiles", () => {
    process.env[ENV_REALTIME] = "realtime-key";
    expect(
      hasOpenAIRealtimePlatformAuthInput(
        { configuredApiKey: undefined, cfg: undefined },
        noProfiles,
      ),
    ).toBe(true);
  });

  it("platform auth check fails closed with nothing hydrated", () => {
    expect(
      hasOpenAIRealtimePlatformAuthInput(
        { configuredApiKey: undefined, cfg: undefined },
        noProfiles,
      ),
    ).toBe(false);
  });

  it("platform auth resolves the realtime env value at connection time", async () => {
    process.env[ENV_REALTIME] = "realtime-key";
    await expect(
      resolveOpenAIRealtimePlatformAuth(
        { configuredApiKey: undefined, cfg: undefined },
        noProfileKey,
      ),
    ).resolves.toBe("realtime-key");
  });

  it("platform auth require throws a clear auth error (not unresolved-ref) when empty", async () => {
    await expect(
      requireOpenAIRealtimePlatformAuth(
        { configuredApiKey: undefined, cfg: undefined },
        noProfileKey,
      ),
    ).rejects.toThrow(/requires an OpenAI Platform API key/);
  });
});
