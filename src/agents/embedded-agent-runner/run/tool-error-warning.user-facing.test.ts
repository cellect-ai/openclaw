// A turn that dies on a tool must still leave the reader something they can
// act on. The regression these guard is a real one: an external contractor was
// shown a bare "⚠️ 🧰 Process failed" in a shared Slack channel, which named an
// internal tool, said nothing about what had happened to their request, and
// offered no next step.
import { describe, expect, it } from "vitest";
import type { ToolErrorSummary } from "../../tool-error-summary.js";
import { buildFailureWarning } from "./tool-error-warning.js";

const warn = (lastToolError: ToolErrorSummary, verbose?: "full") =>
  buildFailureWarning({
    lastToolError,
    hasUserFacingReply: false,
    useMarkdown: true,
    ...(verbose ? { verboseLevel: verbose } : {}),
  });

describe("user-facing tool failure warnings", () => {
  it("never shows the progress emoji prefix reserved for internal traces", () => {
    // "🧰 Process" is the progress-line shape; a user warning uses the label.
    const text = warn({ toolName: "process", error: "Aborted" });
    expect(text).toBe(
      "⚠️ Process failed. I stopped there, so nothing was saved or sent. Ask me to try again, or tell me to take a different route.",
    );
    expect(text).not.toContain("🧰");
  });

  it("tells the reader what happened and what to do next", () => {
    const text = warn({ toolName: "process", error: "Aborted" });
    expect(text).toContain("nothing was saved or sent");
    expect(text).toContain("Ask me to try again");
  });

  it("keeps the provider's raw error text out of the default banner", () => {
    const text = warn({
      toolName: "browser",
      error: "ECONNREFUSED 127.0.0.1:9222 while attaching to target",
    });
    expect(text).not.toContain("ECONNREFUSED");
    expect(text).not.toContain("127.0.0.1");
  });

  it("adds the recovery line to a process terminal failure", () => {
    const text = warn({
      toolName: "process",
      error: "Aborted",
      terminalDiagnostic: {
        kind: "process",
        sessionId: "salty-claw",
        reason: { kind: "timeout", timeoutKind: "no-output-timeout" },
      },
    });
    expect(text).toContain("timed out waiting for output");
    expect(text).toContain("Ask me to try again");
    // The session id is operator detail, not something a channel reader needs.
    expect(text).not.toContain("salty-claw");
  });

  it("adds the recovery line to a tool timeout", () => {
    const text = warn({
      toolName: "browser",
      terminalDiagnostic: { kind: "timeout", timeoutMs: 30_000 },
    });
    expect(text).toContain("timed out after 30s");
    expect(text).toContain("Ask me to try again");
  });

  it("leaves a verbose run untouched so operators still get the raw detail", () => {
    const text = warn({ toolName: "process", error: "Aborted" }, "full");
    expect(text).toBe("⚠️ Process failed: Aborted");
    expect(text).not.toContain("Ask me to try again");
  });

  it("says nothing when the turn already produced a reply the reader can use", () => {
    expect(
      buildFailureWarning({
        lastToolError: { toolName: "process", error: "Aborted" },
        hasUserFacingReply: true,
        useMarkdown: true,
      }),
    ).toBeUndefined();
  });
});
