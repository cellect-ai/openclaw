// Slack tests cover payment-detail screening on the inbound message listener.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSlackMessageEvents } from "./messages.js";
import {
  createSlackSystemEventTestHarness,
  type SlackSystemEventHandler,
} from "./system-event-test-harness.js";

const maybeWarnSlackPaymentDetails = vi.hoisted(() => vi.fn(async () => false));
vi.mock("../payment-detail-warning.js", () => ({ maybeWarnSlackPaymentDetails }));
vi.mock("../../draft-message-boundaries.js", () => ({
  noteSlackDraftConversationMessage: () => {},
}));
vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueRoutedSystemEvent: () => {},
}));

function createMessageHandler() {
  const harness = createSlackSystemEventTestHarness({ channelType: "channel" });
  const handleSlackMessage = vi.fn(async () => {});
  registerSlackMessageEvents({ ctx: harness.ctx, handleSlackMessage });
  return {
    ctx: harness.ctx,
    handler: harness.getHandler("message") as SlackSystemEventHandler,
    handleSlackMessage,
  };
}

describe("Slack payment-detail screening", () => {
  beforeEach(() => {
    maybeWarnSlackPaymentDetails.mockClear();
  });

  it("screens every channel message, independent of the reply pipeline", async () => {
    const { ctx, handler, handleSlackMessage } = createMessageHandler();

    await handler({
      event: {
        type: "message",
        channel: "C1",
        channel_type: "channel",
        user: "U1",
        ts: "123.456",
        text: "routing 021000021",
      },
      body: { event_id: "Ev-pay" },
    });

    expect(maybeWarnSlackPaymentDetails).toHaveBeenCalledWith(
      expect.objectContaining({ ctx, message: expect.objectContaining({ ts: "123.456" }) }),
    );
    expect(handleSlackMessage).toHaveBeenCalledTimes(1);
  });

  it("does not screen edits or deletions", async () => {
    const { handler } = createMessageHandler();

    await handler({
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        message: { ts: "123.456", user: "U1", text: "routing 021000021" },
        previous_message: { ts: "123.450", user: "U1" },
        event_ts: "123.456",
      },
      body: { event_id: "Ev-edit" },
    });

    expect(maybeWarnSlackPaymentDetails).not.toHaveBeenCalled();
  });
});
