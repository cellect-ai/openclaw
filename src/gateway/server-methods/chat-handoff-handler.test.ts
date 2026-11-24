import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { registerRpcSource } from "../../sessions/session-controller.rpc-sources.js";
import { createRpcSourceForTest } from "../test-helpers.rpc-source.js";
import { handleChatHandoffArm, handleChatHandoffSeen } from "./chat-handoff-handler.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";
const seen = vi.hoisted(() => vi.fn());
vi.mock("../webchat-completion-delivery-send.js", () => ({ markWebchatCompletionSeen: seen }));

function fixture() {
  const sessionKey = "agent:main:browser";
  const context = {
    getRuntimeConfig: () => ({}),
    resolveGatewayContext: () => context,
  } as GatewayRequestContext;
  const state = {
    route: { channel: "slack", to: "user:owner" },
    armedAtMs: undefined as number | undefined,
  };
  const source = createRpcSourceForTest(
    {
      kind: "chat-send",
      requester: { connectionId: "old-connection", deviceId: "owner-device" },
      webchatCompletionDelivery: state,
    },
    { sessionKey, agentId: "main", runId: "handoff-run" },
  );
  bindGatewayContextResolver(source.input, context.resolveGatewayContext);
  registerRpcSource("handoff-run", source);
  const client = {
    connId: "new-connection",
    allowedAgentIds: ["main"],
    connect: {
      client: { id: "openclaw-control-ui", mode: "webchat", platform: "web", version: "test" },
      device: { id: "owner-device" },
      scopes: ["operator.admin"],
    },
  };
  const options = {
    context,
    client,
    params: { runId: "handoff-run", sessionKey },
    respond: vi.fn(),
  } as unknown as GatewayRequestHandlerOptions;
  return { options, client, state };
}

describe("native Webchat handoff source ownership", () => {
  beforeEach(() => {
    seen.mockReset();
    seen.mockResolvedValue("not-found");
  });
  it("allows the original device after reconnect through the exact gateway source", async () => {
    const { options, state } = fixture();
    await handleChatHandoffArm(options);
    expect(state.armedAtMs).toEqual(expect.any(Number));
    expect(options.respond).toHaveBeenCalledWith(true, { ok: true, armed: true });
  });
  it("does not treat admin scope as the original viewer", async () => {
    const { options, client, state } = fixture();
    client.connect.device.id = "other-device";
    await handleChatHandoffArm(options);
    expect(state.armedAtMs).toBeUndefined();
    expect(options.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "unauthorized" }),
    );
  });
  it("denies a removed agent ceiling and does not arm the source", async () => {
    const { options, client, state } = fixture();
    client.allowedAgentIds = [];
    await expect(handleChatHandoffArm(options)).rejects.toThrow("authority");
    expect(state.armedAtMs).toBeUndefined();
  });
  it("rechecks viewer authority after asynchronous persisted receipt lookup", async () => {
    const { options, client } = fixture();
    seen.mockImplementationOnce(async ({ assertCurrent }) => {
      client.allowedAgentIds = [];
      assertCurrent();
      return "seen";
    });
    await expect(handleChatHandoffSeen(options)).rejects.toThrow("authority");
    expect(options.respond).not.toHaveBeenCalled();
  });
  it("does not select a run registered in another gateway", async () => {
    const { options, state } = fixture();
    options.context = {
      ...options.context,
      resolveGatewayContext: () => ({}) as GatewayRequestContext,
    };
    await handleChatHandoffArm(options);
    expect(state.armedAtMs).toBeUndefined();
    expect(options.respond).toHaveBeenCalledWith(true, { ok: true, armed: false });
  });
});
