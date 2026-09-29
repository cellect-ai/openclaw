import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleTrustedInternalChatSend: vi.fn(),
  resolveAuthority: vi.fn<() => { senderIsOwner: boolean; toolsAllow?: string[] }>(() => ({
    senderIsOwner: false,
    toolsAllow: ["read"],
  })),
  prepareRelayRun: vi.fn(),
  registerRelayRun: vi.fn<(runId: string) => "registered" | "detached">(() => "registered"),
  abortChatRunById: vi.fn(),
  relayAdmission: { assertCurrent: vi.fn() },
}));

vi.mock("./talk-relay-consult-admission.js", () => ({
  prepareTalkRelayConsultAdmission: () => mocks.relayAdmission,
}));

vi.mock("./server-methods/chat-send-handler.js", () => ({
  handleTrustedInternalChatSend: mocks.handleTrustedInternalChatSend,
}));
vi.mock("./talk/client-gateway-control.js", () => ({
  resolveTalkAgentConsultAuthority: mocks.resolveAuthority,
}));
vi.mock("./talk/relay/index.js", () => ({
  prepareTalkRealtimeRelayAgentRunRegistration: mocks.prepareRelayRun,
}));
vi.mock("./chat-abort.js", () => ({ abortChatRunById: mocks.abortChatRunById }));

import { startTalkRealtimeAgentConsult } from "./talk/agent-consult.js";

function createParams() {
  return {
    request: {
      context: {
        getRuntimeConfig: () => ({}),
        logGateway: { info: vi.fn(), warn: vi.fn() },
      },
      client: { connect: { scopes: ["operator.write"] } },
      req: { id: "request-1" },
    } as never,
    params: {
      sessionTarget: {
        canonicalKey: "agent:fi-admin:matrix:room:thread",
        agentId: "fi-admin",
      },
      callId: "call-1",
      args: { question: "What changed?" },
      relaySessionId: "voice-1",
      connId: "browser-1",
      matrixRoute: {
        channel: "matrix" as const,
        roomId: "!private:example.test",
        threadRootEventId: "$root",
        accountId: "fi-admin",
      },
    },
  };
}

describe("Talk Matrix consult delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepareRelayRun.mockReturnValue(mocks.registerRelayRun);
    mocks.handleTrustedInternalChatSend.mockImplementation(
      async (options: { params: { idempotencyKey: string }; respond: Function }) => {
        options.respond(true, { status: "started", runId: options.params.idempotencyKey });
      },
    );
  });

  it("keeps an accepted Matrix consult alive when its delayed ACK follows relay detach", async () => {
    let acknowledge!: () => void;
    mocks.handleTrustedInternalChatSend.mockImplementationOnce(
      async (options: { params: { idempotencyKey: string }; respond: Function }) => {
        await new Promise<void>((resolve) => {
          acknowledge = () => {
            options.respond(true, { status: "started", runId: options.params.idempotencyKey });
            resolve();
          };
        });
      },
    );
    mocks.registerRelayRun.mockReturnValueOnce("detached");

    const { request, params } = createParams();
    const pending = startTalkRealtimeAgentConsult(request, params);
    await vi.waitFor(() => expect(acknowledge).toBeTypeOf("function"));
    acknowledge();

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(mocks.abortChatRunById).not.toHaveBeenCalled();
  });

  it("pins the authorized Matrix thread on the canonical durable chat final path", async () => {
    const { request, params } = createParams();
    const result = await startTalkRealtimeAgentConsult(request, params);

    expect(result.ok).toBe(true);
    expect(mocks.handleTrustedInternalChatSend).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          deliver: true,
          originatingChannel: "matrix",
          originatingTo: "room:!private:example.test",
          originatingAccountId: "fi-admin",
          originatingThreadId: "$root",
        }),
      }),
      undefined,
      expect.objectContaining({
        toolsAllow: ["read"],
        talkRelayAdmission: mocks.relayAdmission,
        inboundEventKind: "user_request",
        sourceReplyDeliveryMode: "automatic",
      }),
    );
  });

  it("uses the directed turn policy when the owner retains the full tool profile", async () => {
    mocks.resolveAuthority.mockReturnValueOnce({ senderIsOwner: true, toolsAllow: undefined });
    const { request, params } = createParams();
    await startTalkRealtimeAgentConsult(request, params);
    expect(mocks.handleTrustedInternalChatSend).toHaveBeenCalledWith(
      expect.any(Object),
      undefined,
      expect.objectContaining({
        inboundEventKind: "user_request",
        sourceReplyDeliveryMode: "automatic",
      }),
    );
  });

  it("reuses one run idempotency key for the same delayed provider call retry", async () => {
    const firstParams = createParams();
    const secondParams = createParams();
    const first = await startTalkRealtimeAgentConsult(firstParams.request, firstParams.params);
    const second = await startTalkRealtimeAgentConsult(secondParams.request, secondParams.params);

    expect(first).toEqual(second);
    const calls = mocks.handleTrustedInternalChatSend.mock.calls;
    expect(calls[0]?.[0].params.idempotencyKey).toBe(calls[1]?.[0].params.idempotencyKey);
  });
});
