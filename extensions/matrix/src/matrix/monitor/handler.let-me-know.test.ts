import { beforeEach, describe, expect, it } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixRoomMessageEvent,
} from "./handler.test-helpers.js";

const roomId = "!room:example.org";

function letMeKnowEvent(sender: string, flag: unknown) {
  return createMatrixRoomMessageEvent({
    eventId: "$ask",
    sender,
    content: {
      msgtype: "m.text",
      body: "What changed in the draw schedule?",
      ...(flag === undefined ? {} : { "ai.cellect.let_me_know": flag }),
    } as Parameters<typeof createMatrixRoomMessageEvent>[0]["content"],
  });
}

describe("Matrix let-me-know flag", () => {
  beforeEach(() => installMatrixMonitorTestRuntime());

  function setup() {
    return createMatrixHandlerTestHarness({
      isDirectMessage: false,
      accountAllowBots: true,
      configuredBotUserIds: new Set(["@ops:example.org"]),
      roomsConfig: { [roomId]: { requireMention: false } },
      getMemberDisplayName: async () => "sender",
    });
  }

  it("exposes a person's flagged message on the hook chat context", async () => {
    const { handler, runPrepared } = setup();

    await handler(roomId, letMeKnowEvent("@person:example.org", { version: 1 }));

    expect(runPrepared.mock.calls[0]?.[0].ctxPayload.ChannelContext).toEqual({
      sender: { id: "@person:example.org" },
      chat: { id: roomId, eventId: "$ask", letMeKnow: true },
    });
  });

  it.each([
    ["no flag", "@person:example.org", undefined],
    ["an unknown version", "@person:example.org", { version: 2 }],
    ["a malformed flag", "@person:example.org", true],
    ["a configured bot sender", "@ops:example.org", { version: 1 }],
  ])("ignores %s", async (_label, sender, flag) => {
    const { handler, runPrepared } = setup();

    await handler(roomId, letMeKnowEvent(sender, flag));

    const chat = runPrepared.mock.calls[0]?.[0].ctxPayload.ChannelContext?.chat;
    expect(chat).toEqual({ id: roomId, eventId: "$ask" });
  });
});
