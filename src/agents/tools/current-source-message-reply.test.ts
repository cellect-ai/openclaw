import { describe, expect, it } from "vitest";
import { isCurrentSourcePlainMessageReply } from "./current-source-message-reply.js";

describe("current-source plain message reply eligibility", () => {
  const source = {
    toolName: "message",
    currentChannelProvider: "slack",
    currentChannelId: "C-voice-room",
  };

  it("allows only an implicit plain-text send to an authoritative source", () => {
    expect(
      isCurrentSourcePlainMessageReply({
        ...source,
        toolParams: { action: "send", message: "The lookup is complete." },
      }),
    ).toBe(true);
  });

  it.each([
    ["another channel", { channel: "discord" }],
    ["an explicit target", { target: "C-other-room" }],
    ["a thread override", { threadId: "other-thread" }],
    ["a media payload", { media: "file:///workspace/private.pdf" }],
    ["a different action", { action: "delete" }],
    ["an inline reply directive", { message: "[[reply_to:other-message]] Reply" }],
    ["an audio directive", { message: "[[audio_as_voice]] Reply" }],
    ["an extracted media directive", { message: "MEDIA: /workspace/private.pdf" }],
    ["a markdown image payload", { message: "![attachment](https://example.com/a.png)" }],
    ["a silent reply token", { message: "NO_REPLY" }],
  ])("does not exempt a reply with %s", (_label, extra) => {
    expect(
      isCurrentSourcePlainMessageReply({
        ...source,
        toolParams: { action: "send", message: "The lookup is complete.", ...extra },
      }),
    ).toBe(false);
  });

  it("fails closed without an authoritative source or nonempty message", () => {
    expect(
      isCurrentSourcePlainMessageReply({
        toolName: "message",
        toolParams: { action: "send", message: "No source." },
      }),
    ).toBe(false);
    expect(
      isCurrentSourcePlainMessageReply({
        ...source,
        toolParams: { action: "send", message: "  " },
      }),
    ).toBe(false);
  });
});
