import { describe, expect, it } from "vitest";
import { resolveSlackChannelConfig } from "./channel-config.js";
import { resolveSlackRequestUserAllowed } from "./request-users.js";

describe("Slack request users", () => {
  it("preserves omitted, empty, wildcard, and explicit request policies", () => {
    expect(
      resolveSlackChannelConfig({ channelId: "C1", channels: { C1: { enabled: true } } })
        ?.requestUsers,
    ).toBeUndefined();
    expect(
      resolveSlackChannelConfig({
        channelId: "C1",
        channels: { C1: { requestUsers: [] } },
      })?.requestUsers,
    ).toEqual([]);
    expect(
      resolveSlackChannelConfig({
        channelId: "C1",
        channels: { C1: { requestUsers: ["*"] } },
      })?.requestUsers,
    ).toEqual(["*"]);
    expect(
      resolveSlackChannelConfig({
        teamId: "T1",
        channelId: "C1",
        channels: {
          "team:T1:channel:C1": { requestUsers: ["team:T1:user:U_OWNER"] },
        },
      })?.requestUsers,
    ).toEqual(["team:t1:user:u_owner"]);
  });

  it("treats admitted users as requesters only when the restrictive list allows them", () => {
    expect(resolveSlackRequestUserAllowed({ userId: "U_CONTEXT" })).toBe(true);
    expect(resolveSlackRequestUserAllowed({ requestUsers: [], userId: "U_CONTEXT" })).toBe(false);
    expect(resolveSlackRequestUserAllowed({ requestUsers: ["*"], userId: "U_CONTEXT" })).toBe(true);
    expect(
      resolveSlackRequestUserAllowed({
        requestUsers: ["U_OWNER"],
        userId: "U_CONTEXT",
      }),
    ).toBe(false);
    expect(resolveSlackRequestUserAllowed({ requestUsers: ["U_OWNER"], userId: "U_OWNER" })).toBe(
      true,
    );
  });
});
