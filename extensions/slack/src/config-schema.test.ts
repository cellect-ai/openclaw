import { describe, expect, it } from "vitest";
import { SlackConfigSchema } from "../config-api.js";

function expectSlackConfigKeyRejected(config: unknown, key: string) {
  const res = SlackConfigSchema.safeParse(config);
  expect(res.success).toBe(false);
  if (!res.success) {
    expect(res.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unrecognized_keys",
          keys: expect.arrayContaining([key]),
        }),
      ]),
    );
  }
}

function expectSlackConfigIssue(config: unknown, path: string) {
  const res = SlackConfigSchema.safeParse(config);
  expect(res.success).toBe(false);
  if (!res.success) {
    expect(res.error.issues.map((issue) => issue.path.join("."))).toContain(path);
  }
}

function expectSlackConfigValid(config: unknown) {
  const res = SlackConfigSchema.safeParse(config);
  expect(res.success).toBe(true);
}
const user = { postAs: "user", userToken: "test-user-token" };
const relay = {
  url: "test-relay-url",
  authToken: "test-relay-auth-token",
  gatewayId: "test-gateway-id",
};

describe("slack config schema", () => {
  it("defaults groupPolicy to allowlist", () => {
    expect(SlackConfigSchema.parse({}).groupPolicy).toBe("allowlist");
  });

  it.each([
    ["inherited user transport", { ...user, appToken: "test-app-token", accounts: { work: {} } }],
    ["relay user transport", { ...user, mode: "relay", relay }],
    ["disabled relay", { enabled: false, mode: "relay" }],
    [
      "disabled inherited relay",
      { enabled: false, mode: "relay", accounts: { ops: { mode: "relay" } } },
    ],
    [
      "disabled inherited HTTP account",
      {
        mode: "http",
        accounts: {
          disabled: { enabled: false },
          ops: { botToken: "test-bot-token", signingSecret: "test-ops-signing-secret" },
        },
      },
    ],
    ["only disabled HTTP account", { mode: "http", accounts: { ops: { enabled: false } } }],
  ])("accepts %s", (_name, config) => {
    expect(SlackConfigSchema.safeParse(config).success).toBe(true);
  });

  it.each([
    ["allowFrom", { dmPolicy: "open", allowFrom: ["U123"] }, false],
    ["relay.url", { mode: "relay" }, false],
    ["relay.authToken", { mode: "relay", relay: { url: relay.url } }, false],
    [
      "relay.gatewayId",
      { mode: "relay", relay: { url: relay.url, authToken: relay.authToken } },
      false,
    ],
    ["signingSecret", { mode: "http" }, false],
    [
      "accounts.ops.signingSecret",
      { mode: "http", accounts: { ops: { botToken: "test-bot-token" } } },
      true,
    ],
  ] as const)("reports missing or invalid %s", (path, config, exact) => {
    const result = SlackConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toEqual(exact ? [path] : expect.arrayContaining([path]));
    }
  });

  it("accepts unanswered-mention notice settings", () => {
    expectSlackConfigValid({
      unansweredMentions: { notice: true, contact: "Ask Alex for access.", alertAfterMinutes: 0 },
      accounts: { "fi-user": { unansweredMentions: { notice: false } } },
    });
    expectSlackConfigIssue(
      { unansweredMentions: { alertAfterMinutes: -1 } },
      "unansweredMentions.alertAfterMinutes",
    );
    expectSlackConfigKeyRejected({ unansweredMentions: { text: "x" } }, "text");
  });

  it("accepts the opt-in payment-detail warning at root and account level", () => {
    expectSlackConfigValid({
      paymentDetailWarning: true,
      accounts: { "fi-admin": { paymentDetailWarning: false } },
    });
    expectSlackConfigIssue({ paymentDetailWarning: "yes" }, "paymentDetailWarning");
  });

  it("accepts reaction triggers keyed by emoji name at root and account level", () => {
    expectSlackConfigValid({
      reactionTriggers: {
        inbox_tray: { prompt: "File the attachments.", requestUsers: ["U123"] },
      },
      accounts: { "fi-admin": { reactionTriggers: { eyes: { prompt: "Review this." } } } },
    });
    expectSlackConfigIssue(
      { reactionTriggers: { ":inbox_tray:": { prompt: "x" } } },
      "reactionTriggers.:inbox_tray:",
    );
    expectSlackConfigIssue(
      { reactionTriggers: { inbox_tray: { prompt: " " } } },
      "reactionTriggers.inbox_tray.prompt",
    );
  });

  it("accepts a root-only cross-account thread owner preference", () => {
    expectSlackConfigValid({
      threadOwnership: { preferredAccounts: ["fi-admin", "fi-user"] },
      accounts: { "fi-admin": {}, "fi-user": {} },
    });
    expectSlackConfigIssue(
      { accounts: { "fi-admin": { threadOwnership: { preferredAccounts: ["fi-admin"] } } } },
      "accounts.fi-admin",
    );
  });

  it("accepts channel request-user allowlists, including an explicit empty list", () => {
    expectSlackConfigValid({
      channels: {
        C123: { users: ["U_OWNER", "U_CONTEXT"], requestUsers: ["U_OWNER"] },
        C456: { users: ["U_CONTEXT"], requestUsers: [] },
      },
    });
  });
});
