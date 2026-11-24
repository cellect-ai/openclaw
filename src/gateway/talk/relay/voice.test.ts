import { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import {
  captureClientVoiceSessionSettlement,
  withClientVoiceSessionSettlement,
} from "../../../talk/client-voice-session-lifecycle.js";
import { createClientVoiceTranscriptReadiness } from "../../../talk/client-voice-transcript-readiness.js";
import { VOICE_TRANSCRIPT_QUEUE_POLICY } from "../../../talk/voice-transcript.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { RelaySession } from "./state.js";
import {
  closeRelayVoiceSession as closeVoice,
  drainRelayVoiceTranscriptForClose,
  enqueueRelayVoiceTranscript as enqueue,
  ensureRelayVoiceSession as ensureVoice,
} from "./voice.js";

const voiceSessionMocks = vi.hoisted(() => ({
  appendRelayVoiceTranscript: vi.fn(),
  closeRelayVoiceSessionRecord: vi.fn(),
  createOrResumeClientVoiceSession: vi.fn(),
  captureClientVoiceSessionWriter: vi.fn(),
  captureClientVoiceSessionSource: vi.fn(),
}));
const projectionMocks = vi.hoisted(() => ({
  extractDeliveryInfo: vi.fn(),
  deliverOutboundPayloads: vi.fn(),
}));

// mock-isolation: The queue policy is exercised without durable voice state.
vi.mock("../../../talk/client-voice-session.js", () => voiceSessionMocks);
// mock-isolation: Queue-only cases bypass state admission; the refusal regression restores it.
vi.mock("../../../talk/client-voice-session-lifecycle.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../talk/client-voice-session-lifecycle.js")>();
  return {
    ...actual,
    withClientVoiceSessionSettlement: vi.fn(actual.withClientVoiceSessionSettlement),
  };
});
// mock-isolation: The mocked voice store has no physical database to borrow.
vi.mock("../../../talk/client-voice-session-write.js", () => ({
  captureClientVoiceSessionWriter: voiceSessionMocks.captureClientVoiceSessionWriter,
}));
// mock-isolation: The queue-only fixture has no physical voice database to capture.
vi.mock("../../../talk/client-voice-session-source.js", () => ({
  captureClientVoiceSessionSource: voiceSessionMocks.captureClientVoiceSessionSource,
}));
// mock-isolation: Exercise retry decisions without wall-clock backoff.
vi.mock("../../../utils/sleep.js", () => ({ sleep: async () => {} }));
vi.mock("../../../config/sessions/delivery-info.js", () => ({
  extractDeliveryInfo: projectionMocks.extractDeliveryInfo,
}));
vi.mock("../../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: projectionMocks.deliverOutboundPayloads,
}));

const {
  appendRelayVoiceTranscript: appendTranscript,
  closeRelayVoiceSessionRecord: closeRecord,
  createOrResumeClientVoiceSession: createVoice,
  captureClientVoiceSessionWriter: captureWriter,
  captureClientVoiceSessionSource: captureSource,
} = voiceSessionMocks;

const agent = { agentId: "main", sessionKey: "main" };
const transcriptTarget = {
  sessionKey: "agent:main:work",
  storePath: "/tmp/relay-voice-sessions.sqlite",
};

function createRelaySession(refuseCloseSource = false) {
  const queue = VOICE_TRANSCRIPT_QUEUE_POLICY.createQueue();
  const failSession = vi.fn(() => {
    if (refuseCloseSource) {
      const capture = captureWriter.getMockImplementation()!;
      captureWriter.mockImplementation((...args) => {
        if (queue.isIdle) {
          throw new Error("Voice source was replaced before close");
        }
        return capture(...args);
      });
    }
    void closeVoice(session);
  });
  const session = {
    id: "relay-voice-bounded",
    sessionTarget: {
      ...agent,
      canonicalKey: transcriptTarget.sessionKey,
      storePath: transcriptTarget.storePath,
      assertCurrent: () => {},
    },
    provider: "openai",
    context: {
      getRuntimeConfig: () => ({}),
      logGateway: { warn: vi.fn() },
    },
    transcriptReadiness: createClientVoiceTranscriptReadiness({
      flushTranscript: () => queue.flush(),
    }),
    voiceSessionCreated: false,
    voiceTranscriptSeq: 0,
    voiceTranscriptQueue: queue,
    failSession,
  } as unknown as RelaySession;
  return { session, failSession };
}

function blockFirstAppend() {
  const entered = createDeferred();
  const resume = createDeferred();
  appendTranscript.mockImplementation(async ({ entryId }: { entryId: string }) => {
    if (entryId === "1") {
      entered.resolve();
      await resume.promise;
    }
  });
  return { entered: entered.promise, resume: resume.resolve };
}

function expectWarning(session: RelaySession, message: string) {
  expect(session.context.logGateway.warn).toHaveBeenCalledWith(expect.stringContaining(message));
}

beforeEach(() => {
  vi.mocked(withClientVoiceSessionSettlement).mockImplementation((run) => run());
  projectionMocks.extractDeliveryInfo
    .mockReset()
    .mockResolvedValue({ deliveryContext: undefined, threadId: undefined });
  projectionMocks.deliverOutboundPayloads.mockReset().mockResolvedValue([]);
  appendTranscript.mockReset();
  closeRecord.mockReset().mockResolvedValue(undefined);
  createVoice.mockReset().mockResolvedValue("voice");
  const source = { assertCurrent: () => {} };
  captureSource.mockReset().mockReturnValue(source);
  captureWriter
    .mockReset()
    .mockImplementation(() => ({ source, assertCurrent: () => {}, release: async () => {} }));
});

it.each([
  ["transient append", 2, 0],
  ["persistent append", 3, 0],
  ["voice close", 1, 0],
  ["later succeeds", 3, 1],
  ["later fails", 3, 3],
] as const)("settles detached answer recovery (%s)", async (_kind, firstCalls, laterCalls) => {
  const { session } = createRelaySession();
  session.voiceSessionCreated = true;
  const hasLater = laterCalls > 0;
  const failure = new Error(hasLater ? "First answer failed" : "Answer append failed");
  const laterError = new Error("Later answer failed");
  const first = vi.fn().mockRejectedValue(failure);
  const later =
    laterCalls === 3 ? vi.fn().mockRejectedValue(laterError) : vi.fn().mockResolvedValue(undefined);
  const release = vi.fn(async () => {});
  captureWriter.mockReturnValue({
    source: { assertCurrent() {} },
    release,
  });
  session.unspokenAnswers = new Map([["first", first]]);
  if (hasLater) {
    session.unspokenAnswers.set("later", later);
  }
  if (firstCalls === 2) {
    first.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
  }
  if (firstCalls === 1) {
    first.mockResolvedValue(undefined);
    closeRecord.mockRejectedValue(failure);
  }
  const closing = closeVoice(session, "detach");
  if (firstCalls === 2) {
    await expect(closing).resolves.toBeUndefined();
    expect(session.context.logGateway.warn).not.toHaveBeenCalled();
  } else if (laterCalls === 3) {
    await expect(closing).rejects.toMatchObject({ errors: [failure, laterError] });
  } else {
    await expect(closing).rejects.toBe(failure);
  }
  if (!hasLater && firstCalls !== 2) {
    expect(session.context.logGateway.warn).toHaveBeenCalledWith(
      "realtime relay voice session close failed: Answer append failed",
    );
  }
  expect([first, later, closeRecord, release].map((mock) => mock.mock.calls.length)).toEqual([
    firstCalls,
    laterCalls,
    1,
    1,
  ]);
});

it("joins its accepted prefix after close settlement admission is lost", async () => {
  const lifecycle = await vi.importActual<
    typeof import("../../../talk/client-voice-session-lifecycle.js")
  >("../../../talk/client-voice-session-lifecycle.js");
  vi.mocked(withClientVoiceSessionSettlement).mockImplementation(
    lifecycle.withClientVoiceSessionSettlement,
  );
  await withOpenClawTestState({ scenario: "minimal", label: "relay-close-refusal" }, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const blocked = blockFirstAppend();
    const { session } = createRelaySession();
    const entryError = new Error("relay queue entry refused");
    const enqueueSpy = vi
      .spyOn(session.voiceTranscriptQueue, "enqueue")
      .mockImplementationOnce(() => {
        throw entryError;
      });
    try {
      expect(enqueue(session, "user", "not accepted")).toBe(false);
      await vi.advanceTimersByTimeAsync(0);
      expectWarning(session, entryError.message);
    } finally {
      enqueueSpy.mockRestore();
    }
    expect(session.voiceTranscriptSeq).toBe(0);
    expect(enqueue(session, "user", "accepted")).toBe(true);
    const accepted = captureClientVoiceSessionSettlement();
    const close = accepted.run(() => AsyncLocalStorage.bind(() => closeVoice(session)));
    accepted.release();
    const closing = close();
    let settled = false;
    const observed = closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await blocked.entered;
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(closeRecord).not.toHaveBeenCalled();
      blocked.resume();
      // Cellect's close reports the lost settlement owner instead of a clean close.
      await expect(closing).rejects.toThrow("Voice session persistence lost its accepted owner");
      expect(session.voiceTranscriptQueue.isIdle).toBe(true);
      expect(closeRecord).not.toHaveBeenCalled();
    } finally {
      blocked.resume();
      await observed;
      vi.useRealTimers();
    }
  });
});

it("propagates failed accepted Matrix final writes instead of certifying a clean close", async () => {
  const { session } = createRelaySession();
  session.matrixRoute = {
    channel: "matrix",
    roomId: "!owned:synthetic",
    accountId: "primary",
    threadRootEventId: "$root",
  };
  const failure = new Error("final append failed");
  const admitted = session.voiceTranscriptQueue.enqueue(async () => {
    throw failure;
  });
  if (!admitted.accepted) {
    throw new Error("Expected final write acceptance");
  }
  await admitted.completion.catch(() => undefined);
  await expect(closeVoice(session)).rejects.toBe(failure);
  expect(voiceSessionMocks.closeRelayVoiceSessionRecord).not.toHaveBeenCalled();
});

it("does not turn failed final record persistence into success", async () => {
  const { session } = createRelaySession();
  const failure = new Error("record close failed");
  voiceSessionMocks.closeRelayVoiceSessionRecord.mockRejectedValueOnce(failure);
  await expect(closeVoice(session)).rejects.toBe(failure);
});

it.each([false, true])("retries only a known failed creation (unknown=%s)", async (unknown) => {
  const failure = unknown
    ? new SqliteWorkerError("Creation settlement is unknown", "outcome-unknown")
    : new Error("Creation was refused");
  createVoice.mockRejectedValueOnce(failure);
  const { session } = createRelaySession();
  expect(await ensureVoice(session)).toBe(false);
  expect(await ensureVoice(session)).toBe(!unknown);
  expect(createVoice).toHaveBeenCalledTimes(unknown ? 1 : 2);
});

it("does not replay an append after an unknown worker outcome", async () => {
  appendTranscript.mockRejectedValue(
    new SqliteWorkerError("Transcript settlement is unknown", "outcome-unknown"),
  );
  const { session } = createRelaySession();
  expect(enqueue(session, "user", "Keep this accepted utterance")).toBe(true);
  await session.voiceTranscriptQueue.flush();
  await closeVoice(session);
  expect(appendTranscript).toHaveBeenCalledOnce();
  expectWarning(session, "Transcript settlement is unknown");
});

it.each(["bound projection", "resolved projection", "bound append"] as const)(
  "retains required %s failure through close after later work succeeds",
  async (mode) => {
    const { session } = createRelaySession();
    const failure = new Error("Required Matrix transcript debt remains unsettled");
    const route = {
      channel: "matrix" as const,
      roomId: "!owned:synthetic",
      accountId: "primary",
      threadRootEventId: "$root",
    };
    if (mode === "resolved projection") {
      projectionMocks.extractDeliveryInfo.mockResolvedValue({
        deliveryContext: {
          channel: "matrix",
          to: `room:${route.roomId}`,
          accountId: route.accountId,
          threadId: route.threadRootEventId,
        },
      });
    } else {
      session.matrixRoute = route;
    }
    if (mode === "bound append") {
      appendTranscript.mockImplementation(async ({ entryId }: { entryId: string }) => {
        if (entryId === "1") throw failure;
      });
    } else {
      projectionMocks.deliverOutboundPayloads
        .mockRejectedValueOnce(failure)
        .mockResolvedValue([{ channel: "matrix", messageId: "$second" }]);
    }
    expect(enqueue(session, "user", "First accepted speech", { itemId: "first" })).toBe(true);
    expect(enqueue(session, "user", "Unrelated later speech", { itemId: "second" })).toBe(true);
    const close = closeVoice(session);
    await expect(close).rejects.toBe(failure);
    expect(session.voiceTranscriptQueue.isIdle).toBe(true);
    expect(appendTranscript.mock.calls.some(([input]) => input.entryId === "2")).toBe(true);
    expect(closeRecord).not.toHaveBeenCalled();
    // A repeated close cannot erase the debt or manufacture another external send.
    const sends = projectionMocks.deliverOutboundPayloads.mock.calls.length;
    await expect(closeVoice(session)).rejects.toBe(failure);
    expect(projectionMocks.deliverOutboundPayloads).toHaveBeenCalledTimes(sends);
  },
);

it("the admission-refused close drain joins and propagates accepted Matrix projection failure", async () => {
  const { session } = createRelaySession();
  session.matrixRoute = {
    channel: "matrix",
    roomId: "!owned:synthetic",
    accountId: "primary",
    threadRootEventId: "$root",
  };
  const projected = createDeferred();
  const entered = createDeferred();
  const failure = new Error("Projection did not commit");
  projectionMocks.deliverOutboundPayloads.mockImplementation(async () => {
    entered.resolve();
    await projected.promise;
    throw failure;
  });
  expect(enqueue(session, "user", "Accepted before close lost admission")).toBe(true);
  await entered.promise;
  let completed = false;
  const closing = drainRelayVoiceTranscriptForClose(session);
  void closing.then(
    () => {
      completed = true;
    },
    () => {
      completed = true;
    },
  );
  await Promise.resolve();
  expect(completed).toBe(false);
  expect(enqueue(session, "user", "Late input")).toBe(false);
  projected.resolve();
  await expect(closing).rejects.toBe(failure);
  expect(closeRecord).not.toHaveBeenCalled();
});

it("closes a voice created by a later accepted transcript after the first creation fails", async () => {
  const firstCreation = createDeferred<string>();
  createVoice.mockReturnValueOnce(firstCreation.promise);
  const { session } = createRelaySession();
  expect(enqueue(session, "user", "First accepted utterance")).toBe(true);
  expect(enqueue(session, "user", "Later accepted utterance")).toBe(true);
  const closing = closeVoice(session);
  firstCreation.reject(new Error("First creation was refused"));
  await closing;
  expect(createVoice).toHaveBeenCalledTimes(2);
  expect(appendTranscript.mock.calls[0]?.[0]).toMatchObject({
    entryId: "2",
    text: "Later accepted utterance",
  });
  expect(session.voiceTranscriptQueue.isIdle).toBe(true);
  expect(closeRecord).toHaveBeenCalledOnce();
});

it("drains bounded finals even when the closing source is refused", async () => {
  const blocked = blockFirstAppend();
  const { session, failSession } = createRelaySession(true);
  const text = `  ${"x".repeat(9_000)}  `;
  let accepted = enqueue(session, "user", text) ? 1 : 0;

  expect(enqueue(session, "user", " \t\n ")).toBe(true);

  for (let index = 1; index < 10_000; index += 1) {
    if (enqueue(session, index % 2 === 0 ? "user" : "assistant", text)) {
      accepted += 1;
    }
  }

  expect(accepted).toBe(41);
  await blocked.entered;
  expect(failSession).toHaveBeenCalledOnce();
  const close = session.voiceSessionClose;
  expect(close).toBeDefined();
  expect(closeVoice(session)).toBe(close);
  expect(closeRecord).not.toHaveBeenCalled();

  blocked.resume();
  // Cellect's close propagates the refused source after draining the accepted prefix.
  await expect(close).rejects.toThrow("Voice source was replaced before close");

  expect(appendTranscript.mock.calls.map(([params]) => params)).toMatchObject(
    Array.from({ length: 41 }, (_, index) => ({
      entryId: String(index + 1),
      text: "x".repeat(8_000),
    })),
  );
  expect(closeRecord).not.toHaveBeenCalled();
  expectWarning(session, "Voice source was replaced before close");
  expect(enqueue(session, "user", "too late")).toBe(false);
});

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
    expect(enqueue(session, "user", "Run the report")).toBe(true);
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

    expect(enqueue(session, "assistant", "The next number is 5.")).toBe(true);
    await session.voiceTranscriptQueue.flush();

    // 11.7 appends through the captured session writer (second argument).
    expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ role: "assistant", text: "The next number is 5." }),
      expect.anything(),
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
      enqueue(session, "user", "How long is it", {
        itemId: "item-1",
        textMode: "snapshot",
      }),
    ).toBe(true);
    expect(
      enqueue(session, "user", "How long is a typical", {
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
      enqueue(session, "user", final.text, {
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
      enqueue(session, "user", first!.text, { itemId: first!.itemId });
      await session.voiceTranscriptQueue.flush();
      vi.setSystemTime(Date.now() + 30_001);
      enqueue(session, "user", second!.text, { itemId: second!.itemId });
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
    enqueue(session, "user", "No", { itemId: "a" });
    enqueue(session, "user", "Now tell me the September total", {
      itemId: "b",
    });
    await session.voiceTranscriptQueue.flush();

    expect(projectedSupersedes()).toEqual([undefined, undefined]);
  });
});
