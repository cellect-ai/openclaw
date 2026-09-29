// Matrix tests cover index plugin behavior.
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import { registerMatrixCliMetadata } from "./cli-metadata.js";
import entry, { registerMatrixFullRuntime } from "./index.js";

const cliMocks = vi.hoisted(() => ({
  registerMatrixCli: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  ensureMatrixCryptoRuntime: vi.fn(async () => {}),
  handleMatrixSubagentDeliveryTarget: vi.fn(() => "delivery-target"),
  handleMatrixSubagentEnded: vi.fn(async () => {}),
  handleMatrixSessionProjectionCreate: vi.fn(async () => {}),
  handleMatrixSessionProjectionInspect: vi.fn(() => {}),
  listReadOnlyMatrixSessionProjections: vi.fn(() => []),
  planMatrixProjectionRoom: vi.fn(async () => ({ actions: [] })),
  handleMatrixSessionProjectionMessageReceived: vi.fn(async () => {}),
  handleMatrixSessionProjectionReplyPayloadSending: vi.fn(async () => {}),
  handleVerificationBootstrap: vi.fn(async () => {}),
  handleVerificationStatus: vi.fn(async () => {}),
  handleVerifyRecoveryKey: vi.fn(async () => {}),
  setMatrixRuntime: vi.fn(),
}));

vi.mock("./src/cli.js", () => {
  return {
    registerMatrixCli: cliMocks.registerMatrixCli,
  };
});

vi.mock("./plugin-entry.handlers.runtime.js", () => runtimeMocks);
vi.mock("./runtime-setter-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-setter-api.js")>()),
  setMatrixRuntime: runtimeMocks.setMatrixRuntime,
}));
vi.mock("./src/matrix/subagent-hooks.js", () => runtimeMocks);
vi.mock("./src/matrix/session-projection.js", () => runtimeMocks);
vi.mock("./src/matrix/session-projection-snapshot.js", () => ({
  planMatrixProjectionRoom: runtimeMocks.planMatrixProjectionRoom,
}));

function requireFirstCliRegistration(mock: ReturnType<typeof vi.fn>) {
  const [call] = mock.mock.calls;
  if (!call || typeof call[0] !== "function") {
    throw new Error("expected Matrix CLI registration");
  }
  return call as [(ctx: unknown) => unknown, unknown];
}

describe("matrix plugin", () => {
  it("registers matrix CLI through a descriptor-backed lazy registrar", async () => {
    const registerCli = vi.fn();
    const registerGatewayMethod = vi.fn();
    const api = createTestPluginApi({
      id: "matrix",
      name: "Matrix",
      source: "test",
      config: {},
      runtime: {} as never,
      registrationMode: "cli-metadata",
      registerCli,
      registerGatewayMethod,
    });

    registerMatrixCliMetadata(api);

    expect(registerCli).toHaveBeenCalledTimes(1);
    const [registrar, options] = requireFirstCliRegistration(registerCli);
    expect(typeof registrar).toBe("function");
    expect(options).toEqual({
      descriptors: [
        {
          name: "matrix",
          description: "Manage Matrix accounts, verification, devices, and profile state",
          hasSubcommands: true,
        },
      ],
    });
    expect(cliMocks.registerMatrixCli).not.toHaveBeenCalled();

    const program = { command: vi.fn() };
    const result = registrar({ program } as never);

    await result;
    expect(cliMocks.registerMatrixCli).toHaveBeenCalledWith({ program });
    expect(registerGatewayMethod).not.toHaveBeenCalled();
  });

  it("keeps runtime bootstrap and CLI metadata out of setup-only registration", () => {
    if (!entry.setChannelRuntime) {
      throw new Error("expected Matrix runtime setter");
    }
    entry.setChannelRuntime({ marker: "runtime" } as never);
    expect(runtimeMocks.setMatrixRuntime).not.toHaveBeenCalled();
  });

  it("wires CLI metadata through the bundled entry", () => {
    const registerCli = vi.fn();
    const registerGatewayMethod = vi.fn();
    const api = createTestPluginApi({
      id: "matrix",
      name: "Matrix",
      source: "test",
      config: {},
      runtime: {} as never,
      registrationMode: "cli-metadata",
      registerCli,
      registerGatewayMethod,
    });

    entry.register(api);

    expect(registerCli).toHaveBeenCalledTimes(1);
    const [registrar, options] = requireFirstCliRegistration(registerCli);
    expect(typeof registrar).toBe("function");
    expect(options).toEqual({
      descriptors: [
        {
          name: "matrix",
          description: "Manage Matrix accounts, verification, devices, and profile state",
          hasSubcommands: true,
        },
      ],
    });
    expect(registerGatewayMethod).not.toHaveBeenCalled();
  });

  it("registers lifecycle and session projection hooks during full runtime registration", async () => {
    const on = vi.fn();
    const registerGatewayMethod = vi.fn();
    const api = createTestPluginApi({
      id: "matrix",
      name: "Matrix",
      source: "test",
      config: {},
      runtime: { channel: { runtimeContexts: { register: vi.fn() } } } as never,
      registrationMode: "full",
      on,
      registerGatewayMethod,
    });

    registerMatrixFullRuntime(api);

    expect(runtimeMocks.ensureMatrixCryptoRuntime).not.toHaveBeenCalled();
    expect(on.mock.calls.map(([hookName]) => hookName)).toEqual([
      "subagent_ended",
      "subagent_delivery_target",
      "message_received",
      "reply_payload_sending",
    ]);
    const handlers = Object.fromEntries(on.mock.calls);
    await expect(handlers.subagent_ended({ id: "ended" })).resolves.toBeUndefined();
    await expect(handlers.subagent_delivery_target({ id: "target" })).resolves.toBe(
      "delivery-target",
    );
    expect(runtimeMocks.handleMatrixSubagentEnded).toHaveBeenCalledWith({ id: "ended" });
    expect(runtimeMocks.handleMatrixSubagentDeliveryTarget).toHaveBeenCalledWith({ id: "target" });
    await expect(
      handlers.message_received({ id: "received" }, { channelId: "slack" }),
    ).resolves.toBeUndefined();
    await expect(
      handlers.reply_payload_sending({ id: "reply" }, { channelId: "slack" }),
    ).resolves.toBeUndefined();
    expect(runtimeMocks.handleMatrixSessionProjectionMessageReceived).toHaveBeenCalledWith(
      { id: "received" },
      { channelId: "slack" },
      {},
    );
    expect(runtimeMocks.handleMatrixSessionProjectionReplyPayloadSending).toHaveBeenCalledWith(
      { id: "reply" },
      { channelId: "slack" },
      {},
    );

    const projectionRegistration = registerGatewayMethod.mock.calls.find(
      ([method]) => method === "matrix.sessionProjection.create",
    );
    expect(
      registerGatewayMethod.mock.calls.find(
        ([method]) => method === "matrix.sessionProjection.bootstrap",
      )?.[2],
    ).toEqual({ scope: "operator.admin" });
    expect(projectionRegistration?.[2]).toEqual({ scope: "operator.admin" });
    await projectionRegistration?.[1]({ params: { roomId: "!room" } });
    expect(runtimeMocks.handleMatrixSessionProjectionCreate).toHaveBeenCalledWith(
      { params: { roomId: "!room" } },
      api.runtime.channel,
    );
    const inspectionRegistration = registerGatewayMethod.mock.calls.find(
      ([method]) => method === "matrix.sessionProjection.inspect",
    );
    expect(inspectionRegistration?.[2]).toEqual({ scope: "operator.admin" });
    await inspectionRegistration?.[1]({ params: { roomId: "!room" } });
    expect(runtimeMocks.handleMatrixSessionProjectionInspect).toHaveBeenCalledWith({
      params: { roomId: "!room" },
    });
    const planRegistration = registerGatewayMethod.mock.calls.find(
      ([method]) => method === "matrix.sessionProjection.plan",
    );
    expect(planRegistration?.[2]).toEqual({ scope: "operator.admin" });
    const respond = vi.fn();
    await planRegistration?.[1]({ params: { roomId: "!room", accountId: "ops" }, respond });
    expect(runtimeMocks.planMatrixProjectionRoom).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: "!room", accountId: "ops", sourceSnapshot: undefined }),
    );
    expect(respond).toHaveBeenCalledWith(true, { actions: [] });
  });

  it("does not delay source delivery while a Matrix projection is pending", async () => {
    const on = vi.fn();
    const api = createTestPluginApi({
      id: "matrix",
      name: "Matrix",
      source: "test",
      config: {},
      runtime: { channel: { runtimeContexts: { register: vi.fn() } } } as never,
      registrationMode: "full",
      on,
      registerGatewayMethod: vi.fn(),
    });
    registerMatrixFullRuntime(api);
    const handlers = Object.fromEntries(on.mock.calls);
    runtimeMocks.handleMatrixSessionProjectionReplyPayloadSending.mockImplementationOnce(
      () => new Promise<void>(() => {}),
    );

    await expect(
      handlers.reply_payload_sending({ id: "reply" }, { channelId: "slack" }),
    ).resolves.toBeUndefined();
  });
});
