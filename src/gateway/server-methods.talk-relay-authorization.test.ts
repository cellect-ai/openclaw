import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { relaySessions, type RelaySession } from "./talk/relay/state.js";
import { prepareTalkSessionTarget } from "./talk/session-target.js";

const METHOD = "talk.client.toolCall";
const SESSION_KEY = "agent:main:matrix:channel:private-room:thread:root";
const RELAY_ID = "bound-matrix-relay";

afterEach(() => relaySessions.clear());

describe("bound Talk relay authorization at gateway dispatch", () => {
  async function dispatch(
    params: Record<string, unknown>,
    scenario = "owned",
    role: Parameters<typeof roleClient>[0] = "write",
  ) {
    return withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = rolePolicyConfig();
      const requestClient = roleClient(role, "voice-browser");
      requestClient.connId = "voice-browser-connection";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: SESSION_KEY },
        { sessionId: "matrix-thread-session", updatedAt: 1, visibility: "shared" },
      );
      if (scenario !== "closed") {
        relaySessions.set(RELAY_ID, {
          id: RELAY_ID,
          connId: scenario === "foreign" ? "other-connection" : requestClient.connId,
          sessionTarget: prepareTalkSessionTarget(cfg, SESSION_KEY),
          expiresAtMs: Date.now() + (scenario === "expired" ? -1_000 : 60_000),
        } as RelaySession);
      }
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) =>
        respond(true, { started: true }),
      );
      const respond = vi.fn();
      await handleGatewayRequest({
        req: { type: "req", id: "bound-relay-consult", method: METHOD, params },
        client: requestClient,
        context: createDirectChatContext({
          getRuntimeConfig: () => cfg,
        }),
        respond,
        isWebchatConnect: () => false,
        extraHandlers: { [METHOD]: handler },
      });
      return { handler, respond };
    });
  }

  it("admits an owned bound relay without disclosing its Matrix key in the RPC", async () => {
    const { handler, respond } = await dispatch({ relaySessionId: RELAY_ID });
    expect(handler).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(true, { started: true });
  });

  it.each(["foreign", "closed", "expired"])(
    "rejects a %s relay before invoking a tool",
    async (scenario) => {
      const { handler, respond } = await dispatch({ relaySessionId: RELAY_ID }, scenario);
      expect(handler).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          details: { code: "SESSION_MUTATION_TARGET_REQUIRED", method: METHOD },
        }),
      );
    },
  );

  it("rejects a key that does not belong to the provided relay", async () => {
    const { handler } = await dispatch({
      relaySessionId: RELAY_ID,
      sessionKey: "agent:main:another-thread",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("preserves participation ceilings for the capability-resolved session", async () => {
    const { handler, respond } = await dispatch({ relaySessionId: RELAY_ID }, "owned", "view");
    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        details: expect.objectContaining({ code: "SESSION_PARTICIPATION_REQUIRED" }),
      }),
    );
  });

  it("preserves non-relay clients with explicit canonical targets", async () => {
    const { handler } = await dispatch({ sessionKey: SESSION_KEY }, "closed");
    expect(handler).toHaveBeenCalledOnce();
  });
});
