import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createClientVoiceConfirmationReadiness } from "../../../talk/client-voice-confirmation-readiness.js";
import { VOICE_TRANSCRIPT_QUEUE_POLICY } from "../../../talk/voice-transcript.js";
import type { RelaySession } from "./state.js";
import { closeRelayVoiceSession, enqueueRelayVoiceTranscript } from "./voice.js";

const voiceSessionMocks = vi.hoisted(() => ({
  appendRelayVoiceTranscript: vi.fn(),
  closeRelayVoiceSessionRecord: vi.fn(),
  createOrResumeClientVoiceSession: vi.fn(),
}));
const projectionMocks = vi.hoisted(() => ({
  extractDeliveryInfo: vi.fn(),
  deliverOutboundPayloads: vi.fn(),
}));

vi.mock("../../../talk/client-voice-session.js", () => voiceSessionMocks);
vi.mock("../../../config/sessions/delivery-info.js", () => ({
  extractDeliveryInfo: projectionMocks.extractDeliveryInfo,
}));
vi.mock("../../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: projectionMocks.deliverOutboundPayloads,
}));

function createRelaySession(): {
  session: RelaySession;
  failSession: ReturnType<typeof vi.fn>;
} {
  const failSession = vi.fn(() => {
    void closeRelayVoiceSession(session);
  });
  const session = {
    id: "relay-voice-bounded",
    sessionTarget: {
      agentId: "main",
      sessionKey: "main",
      canonicalKey: "agent:main:work",
      storePath: "/tmp/relay-voice-sessions.sqlite",
    },
    provider: "openai",
    context: {
      getRuntimeConfig: () => ({}),
      logGateway: { warn: vi.fn() },
    },
    confirmationReadiness: createClientVoiceConfirmationReadiness({
      agentId: "main",
      voiceSessionId: "relay-voice-bounded",
      flushTranscript: async () => await session.voiceTranscriptQueue.flush(),
    }),
    voiceSessionCreated: false,
    voiceTranscriptSeq: 0,
    voiceTranscriptQueue: VOICE_TRANSCRIPT_QUEUE_POLICY.createQueue(),
    failSession,
  } as unknown as RelaySession;
  return { session, failSession };
}

describe("realtime relay voice transcript persistence", () => {
  beforeEach(() => {
    voiceSessionMocks.appendRelayVoiceTranscript.mockReset();
    voiceSessionMocks.closeRelayVoiceSessionRecord.mockReset().mockResolvedValue(undefined);
    voiceSessionMocks.createOrResumeClientVoiceSession.mockReset();
    projectionMocks.extractDeliveryInfo
      .mockReset()
      .mockReturnValue({ deliveryContext: undefined, threadId: undefined });
    projectionMocks.deliverOutboundPayloads.mockReset().mockResolvedValue([]);
  });

  it("projects a final once through the session-owned Matrix bot route", async () => {
    projectionMocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: { channel: "slack", to: "channel:C123", accountId: "shape" },
      threadId: "123.456",
    });
    const { session } = createRelaySession();
    session.matrixRoute = {
      channel: "matrix",
      roomId: "!owned:example.org",
      accountId: "shape",
      threadRootEventId: "$root",
    };
    expect(enqueueRelayVoiceTranscript(session, "user", "Run the report")).toBe(true);
    await session.voiceTranscriptQueue.flush();

    expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledOnce();
    expect(projectionMocks.deliverOutboundPayloads).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel: "matrix",
        to: "room:!owned:example.org",
        accountId: "shape",
        threadId: "$root",
        deliveryIntentId: "voice:relay-voice-bounded:1",
        payloads: [expect.objectContaining({ text: "Run the report" })],
      }),
    );
  });

  it("persists assistant speech without duplicating it into the Matrix conversation", async () => {
    const { session } = createRelaySession();
    session.matrixRoute = {
      channel: "matrix",
      roomId: "!owned:example.org",
      accountId: "shape",
      threadRootEventId: "$root",
    };

    expect(enqueueRelayVoiceTranscript(session, "assistant", "The next number is 5.")).toBe(true);
    await session.voiceTranscriptQueue.flush();

    expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ role: "assistant", text: "The next number is 5." }),
    );
    expect(projectionMocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("sends a new threaded message when a later final revises the same utterance", async () => {
    projectionMocks.deliverOutboundPayloads
      .mockResolvedValueOnce([{ channel: "matrix", messageId: "$spoken" }])
      .mockResolvedValueOnce([{ channel: "matrix", messageId: "$revised" }]);
    const { session } = createRelaySession();
    session.matrixRoute = {
      channel: "matrix",
      roomId: "!owned:example.org",
      accountId: "shape",
      threadRootEventId: "$root",
    };

    expect(
      enqueueRelayVoiceTranscript(session, "user", "How long is it", {
        itemId: "item-1",
        textMode: "snapshot",
      }),
    ).toBe(true);
    expect(
      enqueueRelayVoiceTranscript(session, "user", "How long is a typical", {
        itemId: "item-2",
        textMode: "snapshot",
      }),
    ).toBe(true);
    await session.voiceTranscriptQueue.flush();

    expect(projectionMocks.deliverOutboundPayloads).toHaveBeenCalledTimes(2);
    const first = projectionMocks.deliverOutboundPayloads.mock.calls[0]?.[0] as {
      deliveryIntentId?: string;
      payloads: Array<{
        channelData?: { matrix?: { editEventId?: string; supersedeEventId?: string } };
      }>;
    };
    const second = projectionMocks.deliverOutboundPayloads.mock.calls[1]?.[0] as {
      deliveryIntentId?: string;
      payloads: Array<{
        channelData?: { matrix?: { editEventId?: string; supersedeEventId?: string } };
        text?: string;
      }>;
    };
    expect(first.payloads[0]?.channelData?.matrix?.editEventId).toBeUndefined();
    expect(first.payloads[0]?.channelData?.matrix?.supersedeEventId).toBeUndefined();
    expect(first.deliveryIntentId).toBe("voice:relay-voice-bounded:item:item-1");
    expect(second.payloads[0]?.channelData?.matrix?.editEventId).toBeUndefined();
    expect(second.payloads[0]?.channelData?.matrix?.supersedeEventId).toBe("$spoken");
    expect(second.payloads[0]?.text).toBe("How long is a typical");
    expect(second.deliveryIntentId).toBe("voice:relay-voice-bounded:item:item-1:2");
  });

  // Recorded LiteLLM / grok-voice-think-fast-2.0 finals (2026-10-30): the user
  // paused after "And", Grok started a new item and carried "And" into its
  // cumulative transcript. The first bubble must be replaced, not duplicated.
  const carriedPrefixFinals = [
    { itemId: "4574f7a0", text: "And" },
    {
      itemId: "db8361a2",
      text: "And how much is did we invoice Shape Management? No, wait, stop. I meant for the month of September only.",
    },
  ];

  function matrixSession() {
    const { session } = createRelaySession();
    session.matrixRoute = {
      channel: "matrix",
      roomId: "!owned:example.org",
      accountId: "shape",
      threadRootEventId: "$root",
    };
    return session;
  }

  function projectedSupersedes() {
    return projectionMocks.deliverOutboundPayloads.mock.calls.map(
      ([params]) =>
        (
          params as {
            payloads: Array<{ channelData?: { matrix?: { supersedeEventId?: string } } }>;
          }
        ).payloads[0]?.channelData?.matrix?.supersedeEventId,
    );
  }

  it("replaces a saved line when Grok carries it into the next item", async () => {
    projectionMocks.deliverOutboundPayloads
      .mockResolvedValueOnce([{ channel: "matrix", messageId: "$and" }])
      .mockResolvedValueOnce([{ channel: "matrix", messageId: "$full" }]);
    const session = matrixSession();
    for (const final of carriedPrefixFinals) {
      enqueueRelayVoiceTranscript(session, "user", final.text, {
        itemId: final.itemId,
        textMode: "snapshot",
      });
    }
    await session.voiceTranscriptQueue.flush();

    expect(projectedSupersedes()).toEqual([undefined, "$and"]);
    expect(session.voiceUtterance).toMatchObject({
      key: "item:4574f7a0",
      text: carriedPrefixFinals[1]?.text,
      eventId: "$full",
    });
  });

  it("keeps a carried prefix as its own line after the revision window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      projectionMocks.deliverOutboundPayloads
        .mockResolvedValueOnce([{ channel: "matrix", messageId: "$and" }])
        .mockResolvedValueOnce([{ channel: "matrix", messageId: "$later" }]);
      const session = matrixSession();
      const [first, second] = carriedPrefixFinals;
      enqueueRelayVoiceTranscript(session, "user", first!.text, { itemId: first!.itemId });
      await session.voiceTranscriptQueue.flush();
      vi.setSystemTime(Date.now() + 30_001);
      enqueueRelayVoiceTranscript(session, "user", second!.text, { itemId: second!.itemId });
      await session.voiceTranscriptQueue.flush();

      expect(projectedSupersedes()).toEqual([undefined, undefined]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not replace a short line that only shares letters with the next one", async () => {
    projectionMocks.deliverOutboundPayloads
      .mockResolvedValueOnce([{ channel: "matrix", messageId: "$no" }])
      .mockResolvedValueOnce([{ channel: "matrix", messageId: "$now" }]);
    const session = matrixSession();
    enqueueRelayVoiceTranscript(session, "user", "No", { itemId: "a" });
    enqueueRelayVoiceTranscript(session, "user", "Now tell me the September total", {
      itemId: "b",
    });
    await session.voiceTranscriptQueue.flush();

    expect(projectedSupersedes()).toEqual([undefined, undefined]);
  });

  it("bounds stalled finals, drains the accepted prefix, and closes once", async () => {
    const firstAppend = createDeferred();
    voiceSessionMocks.appendRelayVoiceTranscript.mockImplementation(
      async ({ entryId }: { entryId: string }) => {
        if (entryId === "1") {
          await firstAppend.promise;
        }
      },
    );
    const { session, failSession } = createRelaySession();
    let accepted = enqueueRelayVoiceTranscript(session, "user", `  ${"x".repeat(9_000)}  `) ? 1 : 0;

    for (let index = 0; index < 10_000; index += 1) {
      expect(enqueueRelayVoiceTranscript(session, "user", " \t\n ")).toBe(true);
    }

    for (let index = 1; index < 10_000; index += 1) {
      if (
        enqueueRelayVoiceTranscript(
          session,
          index % 2 === 0 ? "user" : "assistant",
          `  ${"x".repeat(9_000)}  `,
        )
      ) {
        accepted += 1;
      }
    }

    expect(accepted).toBe(41);
    expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        agentId: "main",
        sessionKey: "main",
        sessionTarget: {
          sessionKey: "agent:main:work",
          storePath: "/tmp/relay-voice-sessions.sqlite",
        },
      }),
    );
    expect(failSession).toHaveBeenCalledOnce();
    const close = session.voiceSessionClose;
    expect(close).toBeDefined();
    expect(closeRelayVoiceSession(session)).toBe(close);
    expect(voiceSessionMocks.closeRelayVoiceSessionRecord).not.toHaveBeenCalled();

    firstAppend.resolve();
    await close;

    expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledTimes(41);
    expect(
      voiceSessionMocks.appendRelayVoiceTranscript.mock.calls.map(
        ([params]) => (params as { entryId: string }).entryId,
      ),
    ).toEqual(Array.from({ length: 41 }, (_, index) => String(index + 1)));
    expect(
      voiceSessionMocks.appendRelayVoiceTranscript.mock.calls.every(
        ([params]) => (params as { text: string }).text.length === 8_000,
      ),
    ).toBe(true);
    expect(voiceSessionMocks.closeRelayVoiceSessionRecord).toHaveBeenCalledOnce();
    expect(enqueueRelayVoiceTranscript(session, "user", "too late")).toBe(false);
  });

  it("propagates failed accepted final writes instead of certifying a clean close", async () => {
    const { session } = createRelaySession();
    const failure = new Error("final append failed");
    const admitted = session.voiceTranscriptQueue.enqueue(async () => {
      throw failure;
    });
    if (!admitted.accepted) {
      throw new Error("Expected final write acceptance");
    }
    await admitted.completion.catch(() => undefined);
    await expect(closeRelayVoiceSession(session)).rejects.toBe(failure);
    expect(voiceSessionMocks.closeRelayVoiceSessionRecord).not.toHaveBeenCalled();
  });

  it("does not turn failed final record persistence into success", async () => {
    const { session } = createRelaySession();
    const failure = new Error("record close failed");
    voiceSessionMocks.closeRelayVoiceSessionRecord.mockRejectedValueOnce(failure);
    await expect(closeRelayVoiceSession(session)).rejects.toBe(failure);
  });
});
