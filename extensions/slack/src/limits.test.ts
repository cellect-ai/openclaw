// Slack tests cover download size limits.
import { describe, expect, it } from "vitest";
import { resolveSlackMediaMaxBytes, SLACK_DEFAULT_MEDIA_MAX_MB } from "./limits.js";

describe("resolveSlackMediaMaxBytes", () => {
  it("defaults to at least 100 MB so large attachments stream to disk", () => {
    expect(SLACK_DEFAULT_MEDIA_MAX_MB).toBeGreaterThanOrEqual(100);
    expect(resolveSlackMediaMaxBytes(undefined)).toBe(SLACK_DEFAULT_MEDIA_MAX_MB * 1024 * 1024);
  });

  it("honors a configured mediaMaxMb and ignores invalid values", () => {
    expect(resolveSlackMediaMaxBytes(250)).toBe(250 * 1024 * 1024);
    expect(resolveSlackMediaMaxBytes(0)).toBe(SLACK_DEFAULT_MEDIA_MAX_MB * 1024 * 1024);
    expect(resolveSlackMediaMaxBytes(Number.NaN)).toBe(SLACK_DEFAULT_MEDIA_MAX_MB * 1024 * 1024);
  });
});
