import { describe, expect, it } from "vitest";
import { runCliAgent } from "./cli-runner.js";
import type { RunCliAgentParams } from "./cli-runner/types.js";
import { SHADOW_CLI_REFUSAL } from "./shadow-hook-tool-policy.js";

describe("runCliAgent shadow refusal", () => {
  it("refuses bare and agent-qualified shadow session keys", async () => {
    for (const sessionKey of ["hook:fi-shadow:abc", "agent:main:hook:fi-shadow:abc"]) {
      await expect(runCliAgent({ sessionKey } as RunCliAgentParams)).rejects.toThrow(
        SHADOW_CLI_REFUSAL,
      );
    }
    await expect(
      runCliAgent({ runtimePolicySessionKey: "hook:fi-shadow:abc" } as RunCliAgentParams),
    ).rejects.toThrow(SHADOW_CLI_REFUSAL);
  });

  it("does not refuse non-shadow keys with the shadow error", async () => {
    const outcome = await runCliAgent({
      sessionKey: "agent:main:main",
      provider: "unknown-cli",
    } as RunCliAgentParams).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((outcome as Error | undefined)?.message).not.toBe(SHADOW_CLI_REFUSAL);
  });
});
