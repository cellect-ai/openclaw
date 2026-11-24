import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import { MatrixAdmissionRefusedError } from "../projection-execution.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";
import type { MatrixIngressLifecycle } from "./ingress.js";

const mocks = vi.hoisted(() => ({
  admit: vi.fn(),
  send: vi.fn(async (..._args: unknown[]) => ({ messageId: "$notice", roomId: "!room" })),
}));

vi.mock("../projection-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../projection-execution.js")>()),
  admitMatrixProjectionExecution: mocks.admit,
}));

vi.mock("../send.js", () => ({
  editMessageMatrix: vi.fn(async () => "$edited"),
  prepareMatrixSingleText: vi.fn((text: string) => ({
    trimmedText: text.trim(),
    convertedText: text.trim(),
    singleEventLimit: 4000,
    fitsInSingleEvent: true,
  })),
  reactMatrixMessage: vi.fn(async () => {}),
  resolveMatrixMentionsForBody: vi.fn(async () => ({})),
  sendMessageMatrix: mocks.send,
  sendSingleTextMessageMatrix: vi.fn(async () => ({ messageId: "$draft", roomId: "!room" })),
  sendReadReceiptMatrix: vi.fn(async () => {}),
  sendTypingMatrix: vi.fn(async () => {}),
}));

const roomId = "!room:example.org";
const lifecycle = {
  onDeferred: () => undefined,
  onAdopted: async () => {},
  onAbandoned: async () => {},
} as unknown as MatrixIngressLifecycle;

describe("Matrix message outside the canonical thread", () => {
  beforeEach(() => {
    installMatrixMonitorTestRuntime();
    mocks.admit
      .mockReset()
      .mockRejectedValue(new MatrixAdmissionRefusedError("thread_not_canonical"));
    mocks.send.mockClear();
  });

  function setup() {
    return createMatrixHandlerTestHarness({
      isDirectMessage: false,
      roomsConfig: { [roomId]: { requireMention: false } },
      client: {
        getEvent: async () =>
          createMatrixTextMessageEvent({
            eventId: "$briefing",
            sender: "@bot:example.org",
            body: "Briefing",
          }),
      },
    });
  }

  const reply = () =>
    createMatrixTextMessageEvent({
      eventId: "$reply",
      body: "a reply to the briefing",
      relatesTo: {
        rel_type: "m.thread",
        event_id: "$briefing",
        "m.in_reply_to": { event_id: "$briefing" },
      },
    });

  it("posts one in-thread notice across repeated deliveries and fails without dispatch", async () => {
    const { handler, runPrepared } = setup();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(handler(roomId, reply(), lifecycle)).rejects.toThrow("thread_not_canonical");
    }

    expect(runPrepared).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.send.mock.calls[0]?.[0]).toBe(roomId);
    expect(mocks.send.mock.calls[0]?.[1]).toContain("main conversation thread");
    expect(mocks.send.mock.calls[0]?.[2]).toMatchObject({
      threadId: "$briefing",
      deliveryQueueId: expect.stringContaining("matrix:thread-not-canonical:"),
      deliveryPartIndex: 0,
      deliveryPartCount: 1,
      extraContent: { msgtype: "m.notice" },
    });
    const options = mocks.send.mock.calls[0]?.[2] as { deliveryQueueId?: string } | undefined;
    expect(options?.deliveryQueueId).toContain("$reply");
  });

  it("still fails the event when the notice cannot be sent", async () => {
    mocks.send.mockRejectedValueOnce(new Error("homeserver unavailable"));
    const { handler } = setup();

    await expect(handler(roomId, reply(), lifecycle)).rejects.toBeInstanceOf(
      MatrixAdmissionRefusedError,
    );
    expect(mocks.send).toHaveBeenCalledOnce();
  });
});
