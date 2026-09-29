import { describe, expect, it } from "vitest";
import { projectionFailureKind } from "./projection-failure.js";

describe("value-safe projection failure categories", () => {
  it("reports only allowlisted Slack errors and Fi HTTP status", () => {
    expect(projectionFailureKind({ data: { error: "ratelimited" } })).toBe("slack_ratelimited");
    expect(projectionFailureKind(new Error("Fi channel projection failed (503)"))).toBe(
      "fi_http_503",
    );
    expect(projectionFailureKind(new Error("Slack snapshot deadline exceeded"))).toBe(
      "source_deadline",
    );
    expect(
      projectionFailureKind(new Error("Slack thread reader unavailable for this account")),
    ).toBe("source_reader_unavailable");
  });
  it("never forwards arbitrary upstream details or credential-shaped strings", () => {
    const secret = "fixture-token-must-not-be-logged";
    expect(projectionFailureKind(new Error(`Bearer ${secret}`))).toBe("unknown");
    expect(projectionFailureKind({ code: secret, data: { error: secret } })).toBe("unknown");
    expect(projectionFailureKind(secret)).toBe("unknown");
    expect(projectionFailureKind(null)).toBe("unknown");
  });
});
