import { describe, expect, it } from "vitest";
import { matchesSandboxGeneration, planSandboxGeneration } from "./generation-plan.js";

describe("sandbox generation planning", () => {
  const logicalName = "sandbox-session-a";
  const configHash = "a".repeat(64);
  const containerPrefix = "openclaw-sbx-";

  it("is deterministic, bounded, and valid as a container name", () => {
    const first = planSandboxGeneration({ logicalName, containerPrefix, configHash });
    expect(planSandboxGeneration({ logicalName, containerPrefix, configHash })).toEqual(first);
    expect(first.containerName).toMatch(/^[a-z0-9][a-z0-9_.-]{0,62}$/);
    expect(first.containerName).toHaveLength(63);
    expect(first.containerName.startsWith(containerPrefix)).toBe(true);
    expect(first.generationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.configHash).toBe(configHash);
  });

  it("uses the full scope and all config hash bits, including the last nibble", () => {
    const first = planSandboxGeneration({ logicalName, containerPrefix, configHash });
    const changedConfig = planSandboxGeneration({
      logicalName,
      containerPrefix,
      configHash: `${"a".repeat(63)}b`,
    });
    const changedScope = planSandboxGeneration({
      logicalName: `${logicalName}-b`,
      containerPrefix,
      configHash,
    });
    expect(
      new Set([first.containerName, changedConfig.containerName, changedScope.containerName]).size,
    ).toBe(3);
    const longScope = `s${"x".repeat(61)}a`;
    const longScopeOther = `s${"x".repeat(61)}b`;
    expect(
      planSandboxGeneration({ logicalName: longScope, containerPrefix, configHash }).containerName,
    ).not.toBe(
      planSandboxGeneration({ logicalName: longScopeOther, containerPrefix, configHash })
        .containerName,
    );
  });

  it("keeps custom prefixes bounded and does not assume a tenant", () => {
    const custom = "service-".repeat(8);
    const plan = planSandboxGeneration({ logicalName, containerPrefix: custom, configHash });
    expect(plan.containerName.startsWith(custom.slice(0, 29))).toBe(true);
    expect(plan.containerName).toHaveLength(63);
    expect(
      planSandboxGeneration({ logicalName, containerPrefix: "", configHash }).containerName,
    ).toMatch(/^g-/);
    expect(matchesSandboxGeneration(plan, { ...plan, containerPrefix: `${custom}x` })).toBe(false);
  });

  it("rejects a short-name collision, incomplete custody, or any mismatched identity", () => {
    const plan = planSandboxGeneration({ logicalName, containerPrefix, configHash });
    expect(matchesSandboxGeneration(plan, plan)).toBe(true);
    expect(matchesSandboxGeneration(plan, { containerName: plan.containerName })).toBe(false);
    expect(matchesSandboxGeneration(plan, { ...plan, logicalName: "other" })).toBe(false);
    expect(matchesSandboxGeneration(plan, { ...plan, configHash: "b".repeat(64) })).toBe(false);
    expect(
      matchesSandboxGeneration(plan, {
        ...plan,
        generationHash: `${plan.generationHash.slice(0, 60)}${plan.generationHash.endsWith("0000") ? "ffff" : "0000"}`,
      }),
    ).toBe(false);
  });

  it("rejects malformed hashes and invalid or unbounded logical names", () => {
    for (const logicalName of ["", ".bad", "contains/path", "-bad", `s${"x".repeat(63)}`]) {
      expect(() => planSandboxGeneration({ logicalName, containerPrefix, configHash })).toThrow(
        "Invalid logical sandbox name",
      );
    }
    expect(() =>
      planSandboxGeneration({ logicalName, containerPrefix: "/bad", configHash }),
    ).toThrow("Invalid sandbox container prefix");
    for (const invalidHash of ["", "a".repeat(63), "A".repeat(64), "g".repeat(64)]) {
      expect(() =>
        planSandboxGeneration({ logicalName, containerPrefix, configHash: invalidHash }),
      ).toThrow("Invalid sandbox configuration hash");
    }
  });
});
