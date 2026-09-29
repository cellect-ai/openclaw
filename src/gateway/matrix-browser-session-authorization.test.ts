import { beforeEach, describe, expect, it, vi } from "vitest";

const extractDeliveryInfo = vi.hoisted(() => vi.fn());
vi.mock("../config/sessions/delivery-info.js", () => ({ extractDeliveryInfo }));

import { isUnauthorizedRawMatrixBrowserSession } from "./matrix-browser-session-authorization.js";

const cfg = {} as never;
const webchat = {
  id: "openclaw-control-ui",
  version: "test",
  platform: "web",
  mode: "webchat",
} as const;

describe("raw Matrix browser session authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    extractDeliveryInfo.mockReturnValue({
      deliveryContext: { channel: "matrix", to: "room:!secret" },
    });
  });

  it("rejects a browser-provided key for a persisted Matrix conversation", () => {
    expect(
      isUnauthorizedRawMatrixBrowserSession({
        cfg,
        clientInfo: webchat,
        sessionKey: "agent:admin:matrix:channel:!secret:thread:$root",
        authorizedByBinding: false,
      }),
    ).toBe(true);
  });

  it("allows the same route only after its owning binding was redeemed", () => {
    expect(
      isUnauthorizedRawMatrixBrowserSession({
        cfg,
        clientInfo: webchat,
        sessionKey: "matrix-key",
        authorizedByBinding: true,
      }),
    ).toBe(false);
  });

  it("uses the approved device client id instead of a spoofed reconnect label", () => {
    expect(
      isUnauthorizedRawMatrixBrowserSession({
        cfg,
        clientInfo: { id: "cli", version: "test", platform: "linux", mode: "cli" },
        pairedClientId: "openclaw-control-ui",
        sessionKey: "agent:admin:matrix:channel:!secret:example.org:thread:$root",
        authorizedByBinding: false,
      }),
    ).toBe(true);
  });

  it("retains Matrix ownership when mutable latest delivery points to Slack", () => {
    extractDeliveryInfo.mockReturnValue({ deliveryContext: { channel: "slack", to: "user:U123" } });
    expect(
      isUnauthorizedRawMatrixBrowserSession({
        cfg,
        clientInfo: webchat,
        sessionKey: "agent:admin:matrix:channel:!secret:example.org:thread:$root",
        authorizedByBinding: false,
      }),
    ).toBe(true);
  });

  it("preserves non-Matrix browser sessions and internal callers", () => {
    extractDeliveryInfo.mockReturnValueOnce({
      deliveryContext: { channel: "webchat", to: "device:one" },
    });
    expect(
      isUnauthorizedRawMatrixBrowserSession({
        cfg,
        clientInfo: webchat,
        sessionKey: "agent:admin:device:one",
        authorizedByBinding: false,
      }),
    ).toBe(false);
    expect(
      isUnauthorizedRawMatrixBrowserSession({
        cfg,
        clientInfo: { id: "gateway-client", version: "test", platform: "server", mode: "backend" },
        sessionKey: "matrix-key",
        authorizedByBinding: false,
      }),
    ).toBe(false);
  });
});
