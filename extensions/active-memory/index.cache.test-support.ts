import { expect, it } from "vitest";
import { buildCacheKey, getCachedResult, setCachedResult } from "./recall-state.js";

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

export function registerRecallCacheCases() {
  it("caps the active-memory cache size and evicts the oldest entries", () => {
    const key = (index: number) =>
      buildCacheKey({
        agentId: "main",
        sessionKey: "agent:main:cache-cap",
        query: `cache pressure prompt ${index}`,
        authorityFingerprint: "cache-authority",
        recallToolNames: ["memory_search"],
      });
    for (let index = 0; index <= 1000; index += 1) {
      setCachedResult(
        key(index),
        {
          status: "ok",
          elapsedMs: 1,
          rawReply: `memory ${index}`,
          summary: `memory ${index}`,
        },
        15_000,
      );
    }
    expect(getCachedResult(key(0))).toBeUndefined();
    expect(getCachedResult(key(1))).toMatchObject({ status: "ok", summary: "memory 1" });
  });

  it("partitions cached recall by turn authority and memory resource scope", () => {
    const base = {
      agentId: "main",
      sessionKey: "agent:main:cache-scope",
      query: "same prompt",
      authorityFingerprint: "authority-a",
      recallToolNames: ["memory_search"],
      memorySlot: "memory-core",
      activeProjectKeys: ["project-a"],
      modelProviderId: "openai",
      modelId: "gpt-5",
    };
    const original = buildCacheKey(base);
    for (const scope of [
      { authorityFingerprint: "authority-b" },
      { activeProjectKeys: ["project-b"] },
      { modelId: "gpt-5-mini" },
      { recallToolNames: ["memory_get"] },
      { resourceScope: "same-agent-private:sessions" },
    ]) {
      expect(buildCacheKey({ ...base, ...scope })).not.toBe(original);
    }
  });
}
