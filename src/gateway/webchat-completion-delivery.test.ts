import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { registerRpcSource } from "../sessions/session-controller.rpc-sources.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createRpcSourceForTest } from "./test-helpers.rpc-source.js";
import {
  armWebchatCompletionDeliveriesForConnection,
  armWebchatCompletionDelivery,
  resolveWebchatCompletionDeliveryReason,
  verifyWebchatCompletionDeliveryClaim,
  WEBCHAT_COMPLETION_DELIVERY_SLOW_MS,
  type WebchatCompletionDeliveryState,
} from "./webchat-completion-delivery.js";

const secret = "test-completion-delivery-secret-32-bytes";
const context = "openclaw:webchat-completion-delivery:v1";

function claim(overrides: Record<string, unknown> = {}): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      aud: "openclaw-webchat-completion-delivery",
      exp: 2_000,
      agentId: "cellect-fi-admin",
      route: { channel: "slack", to: "user:U123", accountId: "fi-admin" },
      ...overrides,
    }),
    "utf8",
  ).toString("base64url");
  const signed = createHmac("sha256", secret)
    .update(context)
    .update("\0")
    .update(payload)
    .digest("base64url");
  return `${payload}.${signed}`;
}

describe("webchat completion delivery", () => {
  it("accepts a valid agent-bound route", () => {
    expect(
      verifyWebchatCompletionDeliveryClaim({
        claim: claim(),
        secret,
        expectedAgentId: "cellect-fi-admin",
        nowMs: 1_000_000,
      }),
    ).toEqual({ channel: "slack", to: "user:U123", accountId: "fi-admin" });
  });

  it("rejects tampering, expiry, and cross-agent replay", () => {
    const valid = claim();
    expect(
      verifyWebchatCompletionDeliveryClaim({
        claim: `${valid}x`,
        secret,
        expectedAgentId: "cellect-fi-admin",
        nowMs: 1_000_000,
      }),
    ).toBeUndefined();
    expect(
      verifyWebchatCompletionDeliveryClaim({
        claim: valid,
        secret,
        expectedAgentId: "cellect-main",
        nowMs: 1_000_000,
      }),
    ).toBeUndefined();
    expect(
      verifyWebchatCompletionDeliveryClaim({
        claim: claim({ exp: 100 }),
        secret,
        expectedAgentId: "cellect-fi-admin",
        nowMs: 1_000_000,
      }),
    ).toBeUndefined();
  });

  it("arms matching runs once and resolves client-left before the slow threshold", () => {
    const first: WebchatCompletionDeliveryState = {
      route: { channel: "slack", to: "user:U1" },
    };
    const second: WebchatCompletionDeliveryState = {
      route: { channel: "slack", to: "user:U2" },
    };
    const gateway = () => ({}) as GatewayRequestContext;
    const otherGateway = () => ({}) as GatewayRequestContext;
    for (const [state, owner, connectionId] of [
      [first, gateway, "conn-1"],
      [second, otherGateway, "conn-1"],
    ] as const) {
      const source = createRpcSourceForTest(
        { kind: "chat-send", requester: { connectionId }, webchatCompletionDelivery: state },
        { runId: "same-protocol-run" },
      );
      bindGatewayContextResolver(source.input, owner);
      registerRpcSource("same-protocol-run", source);
    }
    const count = armWebchatCompletionDeliveriesForConnection({
      resolveGatewayContext: gateway,
      connId: "conn-1",
      nowMs: 5_000,
    });

    expect(count).toBe(1);
    expect(first.armedAtMs).toBe(5_000);
    expect(second.armedAtMs).toBeUndefined();
    expect(
      resolveWebchatCompletionDeliveryReason({ state: first, startedAtMs: 4_900, nowMs: 5_000 }),
    ).toBe("client-left");
    expect(armWebchatCompletionDelivery(first, 6_000)).toBe(false);
    expect(first.armedAtMs).toBe(5_000);
  });

  it("resolves unread before the slow threshold and suppresses seen or attempted delivery", () => {
    const state: WebchatCompletionDeliveryState = {
      route: { channel: "slack", to: "user:U1" },
    };
    expect(
      resolveWebchatCompletionDeliveryReason({
        state,
        startedAtMs: 10,
        nowMs: 10 + WEBCHAT_COMPLETION_DELIVERY_SLOW_MS - 1,
      }),
    ).toBe("unread");
    expect(
      resolveWebchatCompletionDeliveryReason({
        state,
        startedAtMs: 10,
        nowMs: 10 + WEBCHAT_COMPLETION_DELIVERY_SLOW_MS,
      }),
    ).toBe("slow");
    state.seenAtMs = 80_000;
    expect(
      resolveWebchatCompletionDeliveryReason({ state, startedAtMs: 10, nowMs: 90_000 }),
    ).toBeUndefined();
    state.seenAtMs = undefined;
    state.attemptedAtMs = 90_000;
    expect(
      resolveWebchatCompletionDeliveryReason({ state, startedAtMs: 10, nowMs: 100_000 }),
    ).toBeUndefined();
  });
});
