import { createTypingCallbacks } from "openclaw/plugin-sdk/channel-outbound";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import type { MatrixClient } from "../sdk.js";
import { createMatrixDraftController } from "./handler-draft-controller.js";
import { createMatrixReplyDispatcher } from "./handler-reply-dispatcher.js";

const sendMessageMatrixMock = vi.hoisted(() =>
  vi.fn<typeof import("../send.js").sendMessageMatrix>(),
);
const editMessageMatrixMock = vi.hoisted(() => vi.fn(async () => "$edited"));
const sendSingleTextMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async () => ({ messageId: "$draft1", roomId: "!room" })),
);
vi.mock("../send.js", () => ({
  editMessageMatrix: editMessageMatrixMock,
  prepareMatrixSingleText: vi.fn((text: string) => ({
    trimmedText: text.trim(),
    convertedText: text.trim(),
    singleEventLimit: 4000,
    fitsInSingleEvent: true,
  })),
  resolveMatrixMentionsForBody: vi.fn(async () => ({})),
  sendMessageMatrix: sendMessageMatrixMock,
  sendSingleTextMessageMatrix: sendSingleTextMessageMatrixMock,
  sendTypingMatrix: vi.fn(async () => {}),
}));

const ANSWER = { "ai.cellect.let_me_know_answer": { version: 1, triggerEventId: "$ask" } };
const context = {
  cfg: { channels: { matrix: {} } },
  client: {} as MatrixClient,
  roomId: "!room:example.org",
  accountId: "ops",
  replyToMode: "off" as const,
  logVerboseMessage: vi.fn(),
};

async function dispatcher(
  streaming: "off" | "partial",
  letMeKnowTriggerEventId?: string,
  durableProjection = false,
) {
  const draftController = await createMatrixDraftController({
    ...context,
    streaming,
    messageId: "$ask",
    previewToolProgressEnabled: false,
  });
  const typingCallbacks = createTypingCallbacks({ start: async () => {}, onStartError: vi.fn() });
  const replies = createMatrixReplyDispatcher({
    ...context,
    streaming,
    draftStream: draftController.draftStream,
    draftController,
    prefixOptions: { responsePrefixContextProvider: () => ({}) },
    humanDelay: undefined,
    typingCallbacks,
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    mediaLocalRoots: [],
    durableProjection,
    ...(durableProjection ? { threadTarget: "$root" } : {}),
    ...(letMeKnowTriggerEventId ? { letMeKnowTriggerEventId } : {}),
  });
  return { ...replies, draftController };
}

describe("Matrix let-me-know answer marking", () => {
  beforeEach(() => {
    installMatrixMonitorTestRuntime();
    editMessageMatrixMock.mockClear();
    sendSingleTextMessageMatrixMock.mockClear();
    sendMessageMatrixMock.mockReset().mockImplementation(async (_room, text, options) => {
      const result = {
        messageId: "$reply",
        primaryMessageId: "$reply",
        roomId: context.roomId,
        receipt: {
          primaryPlatformMessageId: "$reply",
          platformMessageIds: ["$reply"],
          parts: [{ platformMessageId: "$reply", kind: "text" as const, index: 0 }],
          sentAt: 1,
        },
        content: text ?? "",
      };
      await options.onDeliveryResult?.(result);
      return result;
    });
  });

  it("marks only the final reply of the flagged turn with its trigger", async () => {
    const { deliverReply } = await dispatcher("off", "$ask");

    await deliverReply({ text: "Checking the ledger" }, { kind: "tool" });
    await deliverReply({ text: "Part one" }, { kind: "block" });
    await deliverReply({ text: "The draw was funded Tuesday." }, { kind: "final" });

    const extras = sendMessageMatrixMock.mock.calls.map(
      (call) => call[2].extraContent?.["ai.cellect.let_me_know_answer"],
    );
    expect(extras).toEqual([undefined, undefined, ANSWER["ai.cellect.let_me_know_answer"]]);
  });

  it("leaves an unflagged turn's final reply unmarked", async () => {
    const { deliverReply } = await dispatcher("off");

    await deliverReply({ text: "Done." }, { kind: "final" });

    expect(
      sendMessageMatrixMock.mock.calls[0]?.[2].extraContent?.["ai.cellect.let_me_know_answer"],
    ).toBeUndefined();
  });

  it("routes projected final replacement through the exact durable owner without changing reply placement", async () => {
    const { preparePayload, durable } = await dispatcher("off", "$ask", true);
    const info = { kind: "final" } as const;
    const final = await preparePayload(
      setReplyPayloadMetadata(
        { text: "Done." },
        {
          pendingFinalDeliveryCompletion: {
            sourceMessageId: "$queued-followup",
            deliveryId: "df2257e8-ccfa-43ad-adb2-9709ddbd6c26",
            intentId: "intent",
            sessionId: "session",
            sessionKey: "agent:main:matrix:room",
            storePath: "sessions.json",
          },
        },
      ),
      info,
    );
    expect(final).not.toBeNull();
    expect(final).toMatchObject({
      channelData: {
        matrix: {
          extraContent: {
            ...ANSWER,
            "ai.cellect.reply_to_trigger": {
              version: 1,
              triggerEventId: "$queued-followup",
              deliveryId: "df2257e8-ccfa-43ad-adb2-9709ddbd6c26",
            },
            "com.openclaw.stream_phase": "answer",
          },
        },
      },
    });
    expect(durable(final!, info)).toMatchObject({
      to: `room:${context.roomId}`,
      threadId: "$root",
      replyToId: null,
      requiredCapabilities: { payload: true, reconcileUnknownSend: true },
    });
    expect(durable(final!, { kind: "block" })).toBe(false);
    expect(sendMessageMatrixMock).not.toHaveBeenCalled();
  });

  it("marks the final edit of a live preview instead of finalizing it silently", async () => {
    const { deliverReply, draftController } = await dispatcher("partial", "$ask");
    const draftStream = draftController.draftStream!;
    try {
      draftController.onPartialReply("The draw was funded Tuesday.");
      await draftStream.flush();
      const finalizeLive = vi.spyOn(draftStream, "finalizeLive");

      await deliverReply({ text: "The draw was funded Tuesday." }, { kind: "final" });

      expect(finalizeLive).not.toHaveBeenCalled();
      expect(editMessageMatrixMock).toHaveBeenCalledExactlyOnceWith(
        context.roomId,
        "$draft1",
        "The draw was funded Tuesday.",
        expect.objectContaining({ extraContent: ANSWER }),
      );
      expect(sendMessageMatrixMock).not.toHaveBeenCalled();
    } finally {
      await draftStream.discardPending();
      draftController.cancelProgressDraft();
    }
  });
});
