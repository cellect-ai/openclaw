import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { registerChatAbortController } from "./chat-abort.js";
import type { ChatSendInternalOptions } from "./server-methods/chat-send-options.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import {
  consultRoute,
  consultSessionKey,
  useTalkConsultFixtures,
} from "./talk-agent-consult.test-support.js";
import { closeRelaySession } from "./talk/relay/operations.js";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
// Model dispatch is synthetic; the Talk handler, target admission, voice storage and relay are real.
vi.mock("./server-methods/chat-send-handler.js", () => ({
  handleTrustedInternalChatSend: mocks.send,
}));

describe("native Talk Matrix consult delivery", () => {
  const fixture = useTalkConsultFixtures();
  beforeEach(() => {
    mocks.send.mockReset().mockImplementation(async (request: GatewayRequestHandlerOptions) => {
      request.respond(true, { status: "started", runId: request.params.idempotencyKey });
    });
  });

  it("pins its Matrix thread and private admission on canonical chat delivery", async () => {
    const f = await fixture();
    expect((await f.invoke()).mock.lastCall?.[0]).toBe(true);
    const [request, , options] = mocks.send.mock.calls[0] as [
      GatewayRequestHandlerOptions,
      unknown,
      ChatSendInternalOptions,
    ];
    expect(request.params).toMatchObject({
      deliver: true,
      originatingChannel: "matrix",
      originatingTo: `room:${consultRoute.roomId}`,
      originatingAccountId: "main",
      originatingThreadId: "$root",
    });
    expect(request.client).toMatchObject({
      connId: "browser-owner",
      pairedClientId: "openclaw-control-ui",
      allowedAgentIds: ["main"],
    });
    expect(options).toMatchObject({
      inboundEventKind: "user_request",
      sourceReplyDeliveryMode: "automatic",
    });
    expect(options.talkRelayAdmission?.speakerMxid).toBe("@member:example.test");
    expect(() =>
      options.talkRelayAdmission?.assertCurrent(consultSessionKey, "browser-owner", {
        originatingChannel: "matrix",
        originatingTo: `room:${consultRoute.roomId}`,
        accountId: "main",
        messageThreadId: "$root",
      }),
    ).not.toThrow();
  });

  it("retains the current native source when Matrix audio detaches before its delayed ACK", async () => {
    const f = await fixture();
    const registered = createDeferred();
    const acknowledge = createDeferred();
    let source: ReturnType<typeof registerChatAbortController> | undefined;
    let release: void | (() => void) = undefined;
    mocks.send.mockImplementationOnce(
      async (
        request: GatewayRequestHandlerOptions,
        _unused: unknown,
        options: ChatSendInternalOptions,
      ) => {
        const runId = String(request.params.idempotencyKey);
        source = withPluginRuntimeGatewayContextResolver(
          request.context.resolveGatewayContext,
          () =>
            registerChatAbortController({
              runId,
              sessionId: "consult-session",
              sessionKey: consultSessionKey,
              agentId: "main",
              ownerConnId: f.client.connId,
              target: captureSessionTarget({
                storeScope: f.relay.sessionTarget.storePath,
                sessionKey: consultSessionKey,
                agentId: "main",
                incarnation: "consult-session",
              }),
              timeoutMs: 60_000,
              kind: "chat-send",
            }),
        );
        expect(source.registered).toBe(true);
        const assertCurrent = () => source!.controller.signal.throwIfAborted();
        release = await options.beforeDispatch?.({
          runId,
          assertCurrent,
          assertWorkAdmissionCurrent: assertCurrent,
        });
        registered.resolve();
        await acknowledge.promise;
        request.respond(true, { status: "started", runId });
      },
    );
    const pending = f.invoke();
    try {
      await awaitGateBeforeSettlement(
        registered.promise,
        pending,
        "Talk consult ended before native source registration",
      );
      await closeRelaySession(f.relay, "completed");
      expect(f.relay.closeDisposition).toBe("detach");
      expect(source?.controller.signal.aborted).toBe(false);
      acknowledge.resolve();
      expect((await pending).mock.lastCall?.[0]).toBe(true);
      expect(source?.controller.signal.aborted).toBe(false);
    } finally {
      acknowledge.resolve();
      await pending;
      release?.();
      source?.cleanup();
    }
  });

  it("reuses one native idempotency key for a delayed provider call retry", async () => {
    const f = await fixture();
    const first = await f.invoke();
    const second = await f.invoke();
    expect(first.mock.lastCall?.[0]).toBe(true);
    expect(second.mock.lastCall?.[0]).toBe(true);
    expect(mocks.send.mock.calls[0]?.[0].params.idempotencyKey).toBe(
      mocks.send.mock.calls[1]?.[0].params.idempotencyKey,
    );
  });
});
