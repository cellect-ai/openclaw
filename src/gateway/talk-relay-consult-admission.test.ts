import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import {
  beginSessionWorkAdmission,
  isSessionWorkAdmissionActive,
} from "../sessions/session-lifecycle-admission.js";
import { prepareTalkRelayConsultAdmission } from "./talk-relay-consult-admission.js";
import { closeRelaySession } from "./talk/relay/operations.js";
import { relaySessions, type RelaySession } from "./talk/relay/state.js";
import { RelayToolCallLedger } from "./talk/relay/tool-call-ledger.js";

// Persistence is outside this admission/ownership test; relay close and lease
// ownership remain real, including the default Matrix detach decision.
vi.mock("./talk/relay/voice.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./talk/relay/voice.js")>()),
  closeRelayVoiceSession: async () => {},
}));

const relayId = "matrix-admission-lifecycle-test";
const sessionKey = "agent:assistant:matrix:channel:!room:example.test:thread:$root";
const connId = "owned-browser";
const callId = "provider-call";
const route = {
  channel: "matrix" as const,
  roomId: "!room:example.test",
  threadRootEventId: "$root",
  accountId: "assistant",
};
const origin = {
  originatingChannel: route.channel,
  originatingTo: `room:${route.roomId}`,
  messageThreadId: route.threadRootEventId,
  accountId: route.accountId,
};

function fixture() {
  const controller = new AbortController();
  const toolCalls = new RelayToolCallLedger({
    onOverflow: () => {
      throw new Error("overflow");
    },
  });
  toolCalls.tryAdmit([callId]);
  const relay = {
    id: relayId,
    connId,
    sessionTarget: { agentId: "assistant", sessionKey, canonicalKey: sessionKey, storePath: "" },
    speakerMxid: "@speaker:example.test",
    matrixRoute: { ...route },
    expiresAtMs: Date.now() + 60_000,
    toolCalls,
    context: {
      broadcastToConnIds: vi.fn(),
      chatAbortControllers: new Map([["accepted-run", { controller, sessionKey }]]),
    },
    harness: { close: vi.fn(), talk: { emit: vi.fn((event) => event) } },
    confirmationReadiness: { close: vi.fn() },
    outputOwnership: {},
    activeAgentRuns: new Map([["accepted-run", sessionKey]]),
    activeAgentToolCalls: new Map([[callId, "accepted-run"]]),
    bridge: { close: vi.fn() },
  } as unknown as RelaySession;
  relaySessions.set(relayId, relay);
  const capability = prepareTalkRelayConsultAdmission({
    relaySessionId: relayId,
    connId,
    sessionKey,
    callId,
    matrixRoute: route,
  });
  const assertAllowed = () => capability.assertCurrent(sessionKey, connId, origin);
  return { relay, controller, assertAllowed, capability };
}

afterEach(() => {
  relaySessions.delete(relayId);
});

describe("Matrix consult authority transfers only while its relay is live", () => {
  it("carries the attested speaker and bound thread in host hook context", () => {
    const { capability } = fixture();
    expect(capability.channelContext).toEqual({
      sender: { id: "@speaker:example.test" },
      chat: { id: route.roomId, talkThreadRootEventId: route.threadRootEventId },
    });
    expect(Object.isFrozen(capability.channelContext)).toBe(true);
    expect(Object.isFrozen(capability.channelContext?.chat)).toBe(true);
  });
  it.each(["expired", "replaced", "cancelled", "completed", "detached"] as const)(
    "rejects %s authority after mint while admission waits on the real writer barrier",
    async (failure) => {
      const { relay, assertAllowed } = fixture();
      const scope = `matrix-consult-admission-${failure}`;
      const writerStarted = createDeferred();
      const releaseWriter = createDeferred();
      const firstValidation = createDeferred();
      const writer = runExclusiveSessionStoreWrite(scope, async () => {
        writerStarted.resolve();
        await releaseWriter.promise;
      });
      await writerStarted.promise;
      const admission = beginSessionWorkAdmission({
        scope,
        identities: [sessionKey],
        assertAllowed: () => {
          assertAllowed();
          firstValidation.resolve();
        },
        revalidateAllowed: assertAllowed,
      });
      // Observe rejection immediately, including cleanup on an unexpected pass.
      const outcome = admission.then(
        (lease) => {
          lease.release();
          return undefined;
        },
        (error: unknown) => error,
      );
      try {
        await firstValidation.promise;
        if (failure === "expired") {
          relay.expiresAtMs = Date.now() - 1;
        }
        if (failure === "replaced") {
          relaySessions.set(relayId, { ...relay });
        }
        if (failure === "cancelled") {
          relay.toolCalls.markCancelled([callId], "turn");
        }
        if (failure === "completed") {
          relay.toolCalls.markAgentCompleted([callId]);
        }
        if (failure === "detached") {
          await closeRelaySession(relay, "completed");
        }
        releaseWriter.resolve();
        expect(await outcome).toEqual(
          expect.objectContaining({
            message: "Matrix Talk consultation authority is no longer current",
          }),
        );
        expect(isSessionWorkAdmissionActive(scope, [sessionKey])).toBe(false);
      } finally {
        releaseWriter.resolve();
        await writer;
        await outcome;
      }
    },
  );

  it("keeps accepted work live after real Matrix relay detach but denies another admission", async () => {
    const { relay, controller, assertAllowed } = fixture();
    const scope = "matrix-consult-accepted-detach";
    const lease = await beginSessionWorkAdmission({
      scope,
      identities: [sessionKey],
      assertAllowed,
    });
    try {
      await closeRelaySession(relay, "completed");
      expect(relay.closeDisposition).toBe("detach");
      expect(controller.signal.aborted).toBe(false);
      expect(isSessionWorkAdmissionActive(scope, [sessionKey])).toBe(true);
      await expect(lease.run(async () => "accepted work completed")).resolves.toBe(
        "accepted work completed",
      );
      const another = beginSessionWorkAdmission({ scope, identities: [sessionKey], assertAllowed });
      // Release an unexpected admission rather than leaking shared lifecycle state.
      await expect(
        another.then((unexpected) => {
          unexpected.release();
        }),
      ).rejects.toThrow("Matrix Talk consultation authority is no longer current");
    } finally {
      lease.release();
    }
    expect(isSessionWorkAdmissionActive(scope, [sessionKey])).toBe(false);
  });
});
