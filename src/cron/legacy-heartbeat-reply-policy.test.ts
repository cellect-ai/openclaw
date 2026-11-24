import { describe, expect, it } from "vitest";
import { markReplyPayloadForSourceSuppressionDelivery } from "../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  requiresLegacyHeartbeatExplicitReply,
  selectLegacyHeartbeatReplyPayloads,
} from "./legacy-heartbeat-reply-policy.js";

describe("Doctor-converted heartbeat reply policy", () => {
  it.each([
    { runtime: "codex", explicit: true },
    { runtime: "openclaw", explicit: false },
    { runtime: "codex", mode: "automatic", explicit: false },
    { runtime: "openclaw", mode: "message_tool", explicit: true },
    {
      runtime: "openclaw",
      mode: "automatic",
      group: "message_tool",
      chat: "group",
      explicit: true,
    },
    {
      runtime: "codex",
      mode: "message_tool",
      group: "automatic",
      chat: "channel",
      explicit: false,
    },
    { runtime: "codex", chat: "group", explicit: true },
    { runtime: "openclaw", mode: "automatic", group: "message_tool", explicit: true },
    {
      runtime: "openclaw",
      mode: "automatic",
      group: "message_tool",
      chat: "direct",
      explicit: false,
    },
  ] as const)("uses current runtime and exact conversation policy: %j", (scenario) => {
    const config: OpenClawConfig = {
      messages: {
        visibleReplies: "mode" in scenario ? scenario.mode : undefined,
        groupChat: { visibleReplies: "group" in scenario ? scenario.group : undefined },
      },
    };
    const params = {
      config,
      runtime: scenario.runtime,
      chatType: "chat" in scenario ? scenario.chat : undefined,
    };
    expect(
      requiresLegacyHeartbeatExplicitReply({
        ...params,
        job: { legacyHeartbeatReplyPolicy: true },
      }),
    ).toBe(scenario.explicit);
    expect(requiresLegacyHeartbeatExplicitReply({ ...params, job: {} })).toBe(false);
  });

  it("withholds private prose, media and reasoning but keeps an already authorized host notice", () => {
    const notice = markReplyPayloadForSourceSuppressionDelivery({ text: "Approval required." });
    expect(
      selectLegacyHeartbeatReplyPayloads({
        explicitOnly: true,
        payloads: [
          { text: "Private work" },
          { mediaUrl: "https://example.test/private" },
          { text: "Reasoning", isReasoning: true },
          notice,
        ],
        successful: true,
        pending: false,
      }),
    ).toEqual([notice]);
  });

  it.each([
    { successful: false, pending: false },
    { successful: true, pending: true },
  ])("does not publish an uncommitted explicit result: %j", (state) => {
    expect(
      selectLegacyHeartbeatReplyPayloads({
        ...state,
        explicitOnly: true,
        payloads: [{ text: "Private" }],
        result: { outcome: "progress", summary: "Premature" },
      }),
    ).toEqual([]);
  });

  it("publishes only the explicit result once across shaping and terminal settlement", () => {
    const params = {
      explicitOnly: true,
      successful: true,
      pending: false,
      result: { outcome: "progress" as const, summary: "Explicit answer" },
    };
    const first = selectLegacyHeartbeatReplyPayloads({
      ...params,
      payloads: [{ text: "Private" }],
    });
    expect(first).toEqual([{ text: "Explicit answer" }]);
    expect(selectLegacyHeartbeatReplyPayloads({ ...params, payloads: first })).toEqual(first);
    expect(
      selectLegacyHeartbeatReplyPayloads({
        ...params,
        payloads: [{ text: "Private" }],
        result: { outcome: "no_change" },
      }),
    ).toEqual([]);
  });
});
