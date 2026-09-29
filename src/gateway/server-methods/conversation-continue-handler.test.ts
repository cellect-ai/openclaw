import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyClaim: vi.fn(),
  resolveMatrixBinding: vi.fn(),
  deliver: vi.fn(),
}));
vi.mock("../webchat-completion-delivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../webchat-completion-delivery.js")>()),
  verifyWebchatCompletionDeliveryClaim: mocks.verifyClaim,
}));
vi.mock("../talk-matrix-binding.js", () => ({
  resolveMatrixTalkBinding: mocks.resolveMatrixBinding,
}));
vi.mock("../webchat-completion-delivery-send.js", () => ({
  deliverWebchatCompletionFallback: mocks.deliver,
}));

import { handleConversationContinue } from "./conversation-continue-handler.js";

describe("conversation.continue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENCLAW_WEBCHAT_COMPLETION_DELIVERY_SECRET = "test-secret";
    mocks.verifyClaim.mockReturnValue({ channel: "slack", to: "user:U3", accountId: "fi-admin" });
    mocks.resolveMatrixBinding.mockResolvedValue({
      sessionKey: "agent:cellect-fi-admin:matrix:room:thread",
      agentId: "cellect-fi-admin",
      accountId: "matrix-admin",
    });
    mocks.deliver.mockResolvedValue("handled");
  });

  it("resolves a Matrix thread and continues its exact session in a verified Slack DM", async () => {
    const respond = vi.fn();
    await handleConversationContinue({
      params: {
        source: {
          channel: "matrix",
          roomId: "!room:example",
          threadRootEventId: "$root",
          agentMxid: "@cellect-fi-dev:example.org",
        },
        destinationClaim: "signed-claim",
      },
      respond,
      context: { getRuntimeConfig: () => ({}), logGateway: { warn: vi.fn() } },
    } as never);

    expect(mocks.resolveMatrixBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "!room:example",
        threadRootEventId: "$root",
        agentMxid: "@cellect-fi-dev:example.org",
      }),
    );
    expect(mocks.verifyClaim).toHaveBeenCalledWith(
      expect.objectContaining({ expectedAgentId: "cellect-fi-admin" }),
    );
    expect(mocks.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:cellect-fi-admin:matrix:room:thread",
        continuationMarker: true,
        deliveryIntentId: expect.stringMatching(/^conversation-continue:/),
      }),
    );
    expect(respond).toHaveBeenCalledWith(true, { status: "continued" });
  });

  it("rejects a signed shared-channel destination after canonical Matrix identity resolution", async () => {
    mocks.verifyClaim.mockReturnValue({ channel: "slack", to: "channel:C1" });
    const respond = vi.fn();
    await handleConversationContinue({
      params: {
        source: { channel: "matrix", roomId: "!r:e", threadRootEventId: "$t", agentMxid: "@a:e" },
        destinationClaim: "signed-claim",
      },
      respond,
      context: { getRuntimeConfig: () => ({}), logGateway: { warn: vi.fn() } },
    } as never);
    expect(mocks.resolveMatrixBinding).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
  });
});
