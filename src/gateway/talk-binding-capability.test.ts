import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeTalkBindingCapability,
  mintTalkBindingCapability,
  talkBindingCapabilityTesting,
} from "./talk-binding-capability.js";

const INPUT = {
  sessionKey: "agent:admin:matrix:room:!room:example:thread:$root",
  agentId: "admin",
  accountId: "admin",
  roomId: "!room:example",
  threadRootEventId: "$root",
  speakerMxid: "@alice:example",
};

describe("Talk binding capabilities", () => {
  beforeEach(() => talkBindingCapabilityTesting.clear());

  it("is opaque and consumed exactly once", () => {
    const token = mintTalkBindingCapability(INPUT);
    expect(token).not.toContain(INPUT.sessionKey);
    expect(consumeTalkBindingCapability(token)).toEqual(expect.objectContaining(INPUT));
    expect(consumeTalkBindingCapability(token)).toBeUndefined();
  });

  it("rejects expiry", () => {
    vi.useFakeTimers();
    try {
      const token = mintTalkBindingCapability(INPUT);
      vi.advanceTimersByTime(60_001);
      expect(consumeTalkBindingCapability(token)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
