import { describe, expect, it, vi } from "vitest";
import { readMatrixIngressPrefix } from "./handler-ingress-prefix.js";
function fixture(content: Record<string, unknown>) {
  const config: Parameters<typeof readMatrixIngressPrefix>[0] = {
    client: { getUserId: vi.fn(async () => "@bot:example.test") },
    senderId: "@service:example.test",
    dropPreStartupMessages: false,
    startupMs: 0,
    startupGraceMs: 0,
    eventId: "$invitation",
    roomId: "!room:example.test",
    eventType: "m.room.message",
    event: {
      type: "m.room.message",
      origin_server_ts: 1_800_000_000_000,
      event_id: "$invitation",
      sender: "@service:example.test",
      content: { msgtype: "m.text", body: "You were added to this conversation.", ...content },
    },
    inboundDeduper: { claim: vi.fn(async () => ({ kind: "invalid" as const })) },
    directTracker: { isDirectMessage: vi.fn(async () => false) },
    logVerboseMessage: vi.fn(),
    claimInboundReplay: vi.fn(),
  };
  return config;
}
describe("invitation notices are not agent input", () => {
  it.each([{}, null, { version: 1 }, { version: 2, recipientUserId: "@person:example.test" }])(
    "does not claim, enrich or route a protected notice %j",
    async (marker) => {
      const config = fixture({ "ai.cellect.invitation": marker });
      expect(await readMatrixIngressPrefix(config)).toBeUndefined();
      expect(config.client.getUserId).not.toHaveBeenCalled();
      expect(config.inboundDeduper!.claim).not.toHaveBeenCalled();
      expect(config.directTracker.isDirectMessage).not.toHaveBeenCalled();
      expect(config.claimInboundReplay).not.toHaveBeenCalled();
    },
  );
  it("keeps ordinary messages with identical visible text in the existing ingress", async () => {
    const config = fixture({});
    expect(await readMatrixIngressPrefix(config)).toMatchObject({
      content: config.event.content,
      isDirectMessage: false,
    });
    expect(config.inboundDeduper!.claim).toHaveBeenCalled();
    expect(config.directTracker.isDirectMessage).toHaveBeenCalled();
  });
});
