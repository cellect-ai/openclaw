import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import {
  captureSessionControllerSettlement,
  captureSessionTarget,
} from "../sessions/session-controller.lifecycle.js";
import { registerChatAbortController } from "./chat-abort.js";
import {
  consultRoute,
  consultSessionKey,
  useTalkConsultFixtures,
} from "./talk-agent-consult.test-support.js";
import { prepareTalkRelayConsultAdmission } from "./talk-relay-consult-admission.js";
import { closeRelaySession, registerTalkRealtimeRelayAgentRun } from "./talk/relay/operations.js";
import { relaySessions } from "./talk/relay/state.js";

const origin = {
  originatingChannel: consultRoute.channel,
  originatingTo: `room:${consultRoute.roomId}`,
  messageThreadId: consultRoute.threadRootEventId,
  accountId: consultRoute.accountId,
};

describe("Matrix consult authority at native controller admission", () => {
  const fixture = useTalkConsultFixtures();
  async function setup() {
    const f = await fixture();
    const capability = prepareTalkRelayConsultAdmission({
      relaySessionId: f.relay.id,
      connId: f.relay.connId,
      sessionKey: consultSessionKey,
      callId: "provider-call",
      matrixRoute: consultRoute,
    });
    const assertAllowed = () =>
      capability.assertCurrent(consultSessionKey, f.client.connId, origin);
    const turn = {
      agentId: "main",
      sessionKey: consultSessionKey,
      sessionId: "consult-session",
      storePath: f.relay.sessionTarget.storePath,
    };
    return { ...f, capability, assertAllowed, turn };
  }
  it("captures immutable attested speaker and bound thread hook context", async () => {
    const { capability } = await setup();
    expect(capability.channelContext).toEqual({
      sender: { id: "@member:example.test" },
      chat: { id: consultRoute.roomId, talkThreadRootEventId: "$root" },
    });
    expect(Object.isFrozen(capability.channelContext)).toBe(true);
    expect(Object.isFrozen(capability.channelContext?.chat)).toBe(true);
  });
  it.each(["expired", "replaced", "cancelled", "completed", "detached"] as const)(
    "rejects %s authority after waiting on the native session controller",
    async (failure) => {
      const f = await setup();
      const entered = createDeferred();
      const release = createDeferred();
      const committed = vi.fn();
      const blocker = withSessionTurn(f.turn, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      f.assertAllowed();
      const waiting = withSessionTurn(f.turn, async () => {
        f.assertAllowed();
        committed();
      });
      const outcome = waiting.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        expect(committed).not.toHaveBeenCalled();
        if (failure === "expired") f.relay.expiresAtMs = Date.now() - 1;
        if (failure === "replaced") relaySessions.set(f.relay.id, { ...f.relay });
        if (failure === "cancelled") f.relay.toolCalls.markCancelled(["provider-call"], "turn");
        if (failure === "completed") f.relay.toolCalls.markAgentCompleted(["provider-call"]);
        if (failure === "detached") await closeRelaySession(f.relay, "completed");
        release.resolve();
        expect(await outcome).toEqual(
          expect.objectContaining({
            message: "Matrix Talk consultation authority is no longer current",
          }),
        );
        expect(committed).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await Promise.allSettled([blocker, waiting]);
        if (failure === "replaced") relaySessions.set(f.relay.id, f.relay);
      }
      await captureSessionControllerSettlement({
        scope: f.turn.storePath,
        identities: [consultSessionKey, "consult-session"],
      });
      expect(
        captureSessionControllerSettlement({
          scope: f.turn.storePath,
          identities: [consultSessionKey, "consult-session"],
        }),
      ).toBeUndefined();
    },
  );
  it("keeps accepted native source work live across Matrix detach and denies another consult", async () => {
    const f = await setup();
    const source = withPluginRuntimeGatewayContextResolver(f.context.resolveGatewayContext, () =>
      registerChatAbortController({
        runId: "accepted-native-consult",
        sessionId: "consult-session",
        sessionKey: consultSessionKey,
        agentId: "main",
        ownerConnId: f.client.connId,
        timeoutMs: 60_000,
        kind: "chat-send",
        target: captureSessionTarget({
          storeScope: f.turn.storePath,
          sessionKey: consultSessionKey,
          agentId: "main",
          incarnation: "consult-session",
        }),
      }),
    );
    if (!source.registered) throw new Error("Expected native source registration");
    const entered = createDeferred();
    const release = createDeferred();
    const run = withSessionTurn(
      { ...f.turn, controllerInput: source.entry.input },
      async (_operation, signal) => {
        f.assertAllowed();
        entered.resolve();
        await release.promise;
        signal.throwIfAborted();
        return "accepted work completed";
      },
    );
    let registration: Awaited<ReturnType<typeof registerTalkRealtimeRelayAgentRun>> | undefined;
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        run,
        "Native consult ended before source execution",
      );
      registration = await registerTalkRealtimeRelayAgentRun({
        relaySessionId: f.relay.id,
        connId: f.relay.connId,
        sessionKey: consultSessionKey,
        runId: "accepted-native-consult",
        callId: "provider-call",
      });
      await closeRelaySession(f.relay, "completed");
      expect(f.relay.closeDisposition).toBe("detach");
      expect(source.controller.signal.aborted).toBe(false);
      expect(
        captureSessionControllerSettlement({
          scope: f.turn.storePath,
          identities: [consultSessionKey, "consult-session"],
        }),
      ).toBeDefined();
      await expect(
        Promise.resolve().then(() => {
          f.assertAllowed();
          return withSessionTurn(f.turn, async () => "wrong");
        }),
      ).rejects.toThrow("Matrix Talk consultation authority is no longer current");
      release.resolve();
      await expect(run).resolves.toBe("accepted work completed");
    } finally {
      release.resolve();
      await Promise.allSettled([run]);
      registration?.release();
      source.cleanup();
    }
  });
});
