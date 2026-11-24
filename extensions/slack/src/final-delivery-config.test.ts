import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSlackAccount, resolveSlackOperationToken } from "./accounts.js";
import { prepareSlackFinalDeliveryConfig } from "./final-delivery-config.js";

describe("Slack final sender continuity", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["bot", "user"] as const)("pins the admitted %s environment credential", (identity) => {
    const variable = identity === "bot" ? "SLACK_BOT_TOKEN" : "SLACK_USER_TOKEN";
    vi.stubEnv(variable, "fixture-admitted");
    const cfg = { channels: { slack: { postAs: identity } } };
    const admitted = resolveSlackAccount({ cfg });
    const pinned = prepareSlackFinalDeliveryConfig(cfg, admitted, "fixture-admitted");
    vi.stubEnv(variable, "fixture-replacement");
    expect(resolveSlackOperationToken(resolveSlackAccount({ cfg: pinned }), "write")).toBe(
      "fixture-admitted",
    );
    expect(() => prepareSlackFinalDeliveryConfig(cfg, admitted, "fixture-admitted")).toThrow(
      "Slack reply sender changed",
    );
  });

  it("rejects disabled accounts and changed posting identities", () => {
    const admitted = { accountId: "fi-admin", identity: "bot" as const };
    for (const config of [
      { enabled: false, botToken: "fixture-token" },
      { postAs: "user" as const, userToken: "fixture-token" },
    ]) {
      expect(() =>
        prepareSlackFinalDeliveryConfig(
          { channels: { slack: { accounts: { "fi-admin": config } } } },
          admitted,
          "fixture-token",
        ),
      ).toThrow("Slack reply sender changed");
    }
  });

  it("pins the exact default account when normalized keys collide", () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "fixture-admitted");
    const cfg = { channels: { slack: { accounts: { DEFAULT: {}, default: {} } } } };
    const admitted = resolveSlackAccount({ cfg });
    const pinned = prepareSlackFinalDeliveryConfig(cfg, admitted, "fixture-admitted");
    vi.stubEnv("SLACK_BOT_TOKEN", "fixture-replacement");
    expect(resolveSlackOperationToken(resolveSlackAccount({ cfg: pinned }), "write")).toBe(
      "fixture-admitted",
    );
  });

  it("retains account settings and uses the normalized configured account key", () => {
    const cfg = {
      channels: {
        slack: {
          accounts: { "Fi-Admin": { botToken: "fixture-token", replyToMode: "all" as const } },
        },
      },
    };
    const pinned = prepareSlackFinalDeliveryConfig(
      cfg,
      { accountId: "fi-admin", identity: "bot" },
      "fixture-token",
    );
    expect(pinned.channels?.slack?.accounts?.["Fi-Admin"]).toMatchObject({
      botToken: "fixture-token",
      replyToMode: "all",
    });
    expect(pinned.channels?.slack?.accounts?.["fi-admin"]).toBeUndefined();
  });
});
