// Fork regression: the generated bundled channel metadata must admit the
// Slack custom keys at every level the live config uses them (root,
// per-channel, per-account, per-account-channel). The raw bundled validator
// below is the exact production path behind doctor and gateway pre-bootstrap.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./types.js";
import { collectRawBundledChannelConfigIssues } from "./validation-channel-rules.js";

function sanitizedLiveShapedSlackSection() {
  return {
    enabled: true,
    mode: "socket",
    botToken: "xoxb-sanitized",
    appToken: "xapp-sanitized",
    threadOwnership: { preferredAccounts: ["fi-admin", "fi-user"] },
    reactionTriggers: {
      inbox_tray: { prompt: "File the attachments.", requestUsers: ["U123"] },
    },
    channels: {
      C0000000001: { users: ["U_OWNER"], requestUsers: ["U_OWNER"] },
    },
    accounts: {
      "fi-user": {
        reactionTriggers: { eyes: { prompt: "Review this." } },
        channels: {
          C0000000002: { requestUsers: ["U_OWNER"] },
          "*": { requestUsers: ["U_OWNER"] },
        },
      },
    },
  };
}

describe("bundled slack metadata fork keys", () => {
  it("admits the live custom layout at root, channel, account, and account-channel levels", () => {
    const issues = collectRawBundledChannelConfigIssues({
      channels: { slack: sanitizedLiveShapedSlackSection() },
    } as unknown as OpenClawConfig);
    expect(issues).toEqual([]);
  });

  it("still rejects unknown keys (strictness preserved)", () => {
    const issues = collectRawBundledChannelConfigIssues({
      channels: {
        slack: { ...sanitizedLiveShapedSlackSection(), bogusForkKey: true },
      },
    } as unknown as OpenClawConfig);
    expect(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")).toContain(
      "bogusForkKey",
    );
  });
});
