import { describe, expect, it, vi } from "vitest";

const cliProviders = new Set(["claude-cli", "codex-cli"]);
vi.mock("./run-execution.runtime.js", () => ({
  isCliProvider: (provider: string) => cliProviders.has(provider),
}));
vi.mock("./run.runtime.js", () => ({
  resolveEffectiveAgentRuntime: () => "openclaw",
}));
vi.mock("../../agents/model-runtime-aliases.js", () => ({
  resolveCliRuntimeExecutionProvider: ({ provider }: { provider: string }) =>
    provider === "anthropic" ? "claude-cli" : undefined,
}));

const { assertShadowRunNotCli, createCronCandidateExecutionResolver, SHADOW_CLI_REFUSAL } =
  await import("./run-candidate-runtime.js");

function resolver(sessionKey: string, agentSessionKey?: string) {
  return createCronCandidateExecutionResolver({
    cfgWithAgentDefaults: {},
    agentId: "cellect-fi-user",
    runSessionKey: sessionKey,
    agentSessionKey,
    cronSession: { sessionEntry: {} },
  } as never);
}

describe("Fi shadow runs never select a CLI backend", () => {
  it.each(["hook:fi-shadow:abc", "agent:cellect-fi-user:hook:fi-shadow:abc"])(
    "refuses a CLI model, runtime override or alias for %s",
    (key) => {
      const resolve = resolver(key);
      expect(() => resolve("claude-cli", "m", undefined)).toThrow(SHADOW_CLI_REFUSAL);
      expect(() => resolve("openai", "m", "codex-cli")).toThrow(SHADOW_CLI_REFUSAL);
      expect(() => resolve("anthropic", "m", undefined)).toThrow(SHADOW_CLI_REFUSAL);
    },
  );

  it("matches on the agent session key too", () => {
    const resolve = resolver("opaque", "hook:fi-shadow:abc");
    expect(() => resolve("claude-cli", "m", undefined)).toThrow(SHADOW_CLI_REFUSAL);
  });

  it("lets a shadow run use a non-CLI model and leaves other runs alone", () => {
    expect(resolver("hook:fi-shadow:abc")("openai", "m", undefined).cliExecution).toBe(false);
    expect(resolver("agent:main:hook:fi-mail:abc")("claude-cli", "m", undefined).cliExecution).toBe(
      true,
    );
  });

  it("asserts directly", () => {
    expect(() => assertShadowRunNotCli(["hook:fi-shadow:x"], true)).toThrow(SHADOW_CLI_REFUSAL);
    expect(() => assertShadowRunNotCli(["hook:fi-shadow:x"], false)).not.toThrow();
    expect(() => assertShadowRunNotCli(["cron:x", undefined], true)).not.toThrow();
  });
});
