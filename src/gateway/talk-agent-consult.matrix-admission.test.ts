import { beforeEach, describe, expect, it, vi } from "vitest";
import { isWebchatClient } from "../utils/message-channel.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import {
  consultRoute,
  consultSessionKey,
  useTalkConsultFixtures,
} from "./talk-agent-consult.test-support.js";
import { prepareTalkRelayConsultAdmission } from "./talk-relay-consult-admission.js";
import { relaySessions } from "./talk/relay/state.js";

const mocks = vi.hoisted(() => ({ trustedSend: vi.fn() }));
// Native external chat entry remains real; only accepted internal model dispatch is intercepted.
vi.mock("./server-methods/chat-send-handler.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-methods/chat-send-handler.js")>()),
  handleTrustedInternalChatSend: mocks.trustedSend,
}));
import { handleChatSend } from "./server-methods/chat-send-handler.js";

describe("native Matrix Talk browser admission boundary", () => {
  const fixture = useTalkConsultFixtures();
  beforeEach(() => {
    mocks.trustedSend
      .mockReset()
      .mockImplementation(async (request: GatewayRequestHandlerOptions) => {
        request.respond(true, { status: "started", runId: request.params.idempotencyKey });
      });
  });
  it("admits the owned relay while retaining browser requester identity and agent ceiling", async () => {
    const f = await fixture();
    expect((await f.invoke()).mock.lastCall?.[0]).toBe(true);
    expect(mocks.trustedSend.mock.calls[0]?.[0].client).toMatchObject({
      connId: f.relay.connId,
      pairedClientId: "openclaw-control-ui",
      allowedAgentIds: ["main"],
    });
  });
  it("rejects raw browser chat using the known Matrix session key", async () => {
    const f = await fixture();
    const respond = vi.fn();
    await handleChatSend({
      context: f.context,
      client: f.client,
      isWebchatConnect: (connect) => isWebchatClient(connect?.client),
      respond,
      req: { type: "req", id: "raw", method: "chat.send" },
      params: { sessionKey: consultSessionKey, message: "inject", idempotencyKey: "raw" },
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "Matrix conversations require an authorized conversation binding",
      }),
    );
    expect(mocks.trustedSend).not.toHaveBeenCalled();
  });
  it("does not widen the paired device's agent ceiling", async () => {
    const f = await fixture();
    f.client.allowedAgentIds = ["other-agent"];
    expect((await f.invoke()).mock.lastCall?.[0]).toBe(false);
    expect(mocks.trustedSend).not.toHaveBeenCalled();
  });
  it.each([
    "closed",
    "wrong-connection",
    "wrong-route",
    "cancelled",
    "completed",
    "expired",
    "canonical-target-changed",
  ] as const)("rejects %s relay authority before downstream chat", async (failure) => {
    const f = await fixture();
    const input = {
      relaySessionId: f.relay.id,
      connId: f.relay.connId,
      sessionKey: consultSessionKey,
      callId: "provider-call",
      matrixRoute: consultRoute,
    };
    if (failure === "closed") relaySessions.delete(f.relay.id);
    if (failure === "wrong-connection") input.connId = "other-browser";
    if (failure === "wrong-route")
      input.matrixRoute = { ...consultRoute, threadRootEventId: "$other" };
    if (failure === "cancelled") f.relay.toolCalls.markCancelled(["provider-call"], "turn");
    if (failure === "completed") f.relay.toolCalls.markAgentCompleted(["provider-call"]);
    if (failure === "expired") f.relay.expiresAtMs = Date.now() - 1;
    if (failure === "canonical-target-changed")
      f.relay.sessionTarget = {
        ...f.relay.sessionTarget,
        canonicalKey: consultSessionKey + ":other",
      };
    try {
      expect(() => prepareTalkRelayConsultAdmission(input)).toThrow(
        "authority is no longer current",
      );
    } finally {
      relaySessions.set(f.relay.id, f.relay);
    }
    expect(mocks.trustedSend).not.toHaveBeenCalled();
  });
});
