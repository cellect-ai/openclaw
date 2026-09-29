import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { ErrorCodes } from "openclaw/plugin-sdk/gateway-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSlackChannelProjection } from "./channel-projection-registration.js";

const projection = vi.hoisted(() => ({
  project: vi.fn(),
  retryChannelProjection: vi.fn(),
  recoverDirect: vi.fn(),
}));

vi.mock("./channel-projection.js", () => ({
  projectSlackChannelThread: projection.project,
  registerSlackProjectionReconciler: () => ({
    retryChannelProjection: projection.retryChannelProjection,
    wake: vi.fn(),
    noteActivity: vi.fn(),
    channelProjectionSucceeded: vi.fn(),
  }),
}));

vi.mock("./direct-projection.js", () => ({
  isSlackDirectSessionKey: (sessionKey: string) =>
    /^agent:[^:]+:slack:direct:[uw][a-z0-9]+$/i.test(sessionKey),
  recoverSlackDirectProjection: projection.recoverDirect,
}));

describe("Slack projection sync retry handoff", () => {
  beforeEach(() => {
    projection.project.mockReset();
    projection.retryChannelProjection.mockReset();
    projection.recoverDirect.mockReset();
  });

  function register() {
    let syncHandler:
      | ((input: {
          params?: Record<string, unknown>;
          respond: (...args: unknown[]) => void;
        }) => Promise<void>)
      | undefined;
    const api = {
      config: {},
      logger: { warn: vi.fn(), info: vi.fn() },
      registerGatewayMethod: vi.fn((_method: string, handler: unknown) => {
        syncHandler = handler as typeof syncHandler;
      }),
      on: vi.fn(),
    } as unknown as OpenClawPluginApi;
    registerSlackChannelProjection(api, () => ({ baseUrl: "https://fi.example", token: "test" }));
    if (!syncHandler) {
      throw new Error("Slack projection sync handler was not registered");
    }
    return syncHandler;
  }

  it("queues a bounded retry after a valid immediate channel snapshot fails", async () => {
    const sessionKey = "agent:cellect-fi-admin:slack:channel:c123:thread:1700000000.000001";
    projection.project.mockRejectedValueOnce(new Error("Fi projection unavailable"));
    const respond = vi.fn();

    await register()({
      params: { sessionKey, accountId: "fi-admin", requesterSenderId: "U111" },
      respond,
    });

    expect(projection.retryChannelProjection).toHaveBeenCalledWith(sessionKey);
    expect(respond).toHaveBeenCalledWith(
      false,
      { error: "Fi projection unavailable" },
      expect.objectContaining({ code: ErrorCodes.UNAVAILABLE }),
    );
  });

  it("does not queue a channel retry when request validation fails before projection", async () => {
    const respond = vi.fn();

    await register()({
      params: {
        sessionKey: "agent:cellect-fi-admin:slack:channel:c123:thread:1700000000.000001",
        accountId: "fi-admin",
      },
      respond,
    });

    expect(projection.project).not.toHaveBeenCalled();
    expect(projection.retryChannelProjection).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      { error: "Missing Slack projection parameters" },
      expect.any(Object),
    );
  });

  it("does not queue a channel retry for a DM after projection rejects the unsupported session", async () => {
    const sessionKey = "agent:cellect-fi-admin:slack:direct:U111";
    projection.project.mockResolvedValueOnce(false);
    const respond = vi.fn();

    await register()({
      params: { sessionKey, accountId: "fi-admin", requesterSenderId: "U222" },
      respond,
    });

    expect(projection.project).toHaveBeenCalledTimes(1);
    expect(projection.retryChannelProjection).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      { error: "Unsupported Slack channel session" },
      expect.any(Object),
    );
  });
});
