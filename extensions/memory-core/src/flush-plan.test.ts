// Memory Core tests cover flush plan plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMemoryFlushPlan } from "./flush-plan.js";

describe("buildMemoryFlushPlan", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back when the injected timestamp is outside Date range", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 4, 30, 12, 0, 0));

    const plan = buildMemoryFlushPlan({
      nowMs: 8_640_000_000_000_001,
    });

    expect(plan?.relativePath).toBe("memory/2026-05-30.md");
  });

  it.each([
    [8_000, 2_000, 3_000],
    [32_768, 8_192, 4_000],
    [128_000, 20_000, 4_000],
  ])(
    "sizes its reserve and maintenance headroom to a %i-token context window",
    (contextWindowTokens, reserveTokensFloor, softThresholdTokens) => {
      expect(buildMemoryFlushPlan({ contextWindowTokens })).toMatchObject({
        reserveTokensFloor,
        softThresholdTokens,
      });
    },
  );

  it("tells the agent to attribute every note to who it is for and its scope", () => {
    const plan = buildMemoryFlushPlan({});
    for (const text of [plan?.prompt, plan?.systemPrompt]) {
      expect(text).toContain("[for: <requester email");
      expect(text).toContain('"Fi requester:"');
      expect(text).toContain('or "unknown"');
      expect(text).toContain("[scope: private | room:<conversation or room id> | org]");
      expect(text).toContain("private DMs and private rooms");
      expect(text).toContain("trusted person");
      expect(text).toContain("[source: untrusted]");
      expect(text).toContain("record them as facts");
    }
  });
});
