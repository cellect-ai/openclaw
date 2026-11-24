import { beforeEach, describe, expect, it, vi } from "vitest";

const extractDeliveryInfo = vi.hoisted(() => vi.fn());
vi.mock("../config/sessions/delivery-info.js", () => ({ extractDeliveryInfo }));

import {
  isUnauthorizedRawMatrixBrowserSession,
  prepareRawMatrixBrowserSessionAuthorization,
} from "./matrix-browser-session-authorization.js";

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
    // The native row supplies the channel; no delivery lookup is consumed here.
    expect(
      isUnauthorizedRawMatrixBrowserSession({
        cfg,
        clientInfo: webchat,
        sessionKey: "agent:admin:device:one",
        deliveryChannel: "webchat",
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

it("awaits native route recovery and refuses absent route proof", async () => {
  const params = { cfg, clientInfo: webchat, sessionKey: "opaque", authorizedByBinding: false };
  const pending = Promise.withResolvers<{ deliveryContext: { channel: string } }>();
  extractDeliveryInfo.mockReturnValueOnce(pending.promise);
  let settled = false;
  const result = prepareRawMatrixBrowserSessionAuthorization(params).then((value) => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  pending.resolve({ deliveryContext: { channel: "matrix" } });
  await expect(result).resolves.toBe(true);
  extractDeliveryInfo.mockResolvedValueOnce({ deliveryContext: undefined });
  await expect(prepareRawMatrixBrowserSessionAuthorization(params)).resolves.toBe(true);
  extractDeliveryInfo.mockResolvedValueOnce({ deliveryContext: { channel: "webchat" } });
  await expect(prepareRawMatrixBrowserSessionAuthorization(params)).resolves.toBe(false);
});

it("allows native proven absence and channel-less main while refusing opaque existing routes", () => {
  const common = { cfg, clientInfo: webchat, authorizedByBinding: false };
  expect(
    isUnauthorizedRawMatrixBrowserSession({
      ...common,
      sessionKey: "agent:main:main",
      sessionEntry: null,
    }),
  ).toBe(false);
  expect(
    isUnauthorizedRawMatrixBrowserSession({
      ...common,
      sessionKey: "agent:main:main",
      sessionEntry: { sessionId: "main", updatedAt: 1 },
    }),
  ).toBe(false);
  for (const sentinel of ["global", "unknown"]) {
    expect(
      isUnauthorizedRawMatrixBrowserSession({
        ...common,
        sessionKey: sentinel,
        sessionEntry: { sessionId: sentinel, updatedAt: 1 },
      }),
    ).toBe(false);
  }
  expect(
    isUnauthorizedRawMatrixBrowserSession({
      ...common,
      sessionKey: "global",
      sessionEntry: {
        sessionId: "global",
        updatedAt: 1,
        delivery: {
          kind: "external",
          route: { channel: "matrix", target: { to: "!secret" } },
          context: { channel: "matrix", to: "!secret" },
          origin: { provider: "matrix" },
        },
      },
    }),
  ).toBe(true);
  expect(
    isUnauthorizedRawMatrixBrowserSession({
      ...common,
      sessionKey: "opaque",
      sessionEntry: { sessionId: "existing", updatedAt: 1 },
    }),
  ).toBe(true);
  expect(
    isUnauthorizedRawMatrixBrowserSession({
      ...common,
      sessionKey: "agent:main:matrix:channel:!secret",
      sessionEntry: null,
    }),
  ).toBe(true);
});

it("rejects an alias backed by the current Matrix row even when latest request labels differ", async () => {
  await expect(
    prepareRawMatrixBrowserSessionAuthorization({
      cfg,
      clientInfo: webchat,
      sessionKey: "legacy-alias",
      authorizedByBinding: false,
      sessionEntry: {
        sessionId: "matrix",
        updatedAt: 1,
        delivery: {
          kind: "external",
          route: { channel: "matrix", target: { to: "!secret" } },
          context: { channel: "matrix", to: "!secret" },
          origin: { provider: "matrix" },
        },
      },
    }),
  ).resolves.toBe(true);
});
