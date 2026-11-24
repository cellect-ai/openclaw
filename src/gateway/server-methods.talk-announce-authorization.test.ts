import { describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";

const METHOD = "talk.session.announce";

describe("talk.session.announce at gateway dispatch", () => {
  async function dispatch(scopes: string[]) {
    return withOpenClawTestState({ scenario: "minimal" }, async () => {
      const client = sharingPolicyClient({ scopes });
      client.connId = "voice-browser-connection";
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));
      const respond = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "announce",
          method: METHOD,
          params: { sessionId: "talk-1", text: "answer" },
        },
        client,
        context: createDirectChatContext({ getRuntimeConfig: () => ({}) }),
        respond,
        isWebchatConnect: () => false,
        extraHandlers: { [METHOD]: handler },
      });
      return { handler, respond };
    });
  }

  // An unclassified method falls back to admin scope, which a browser session lacks.
  it.each([["operator.talk"], ["operator.write"]])(
    "reaches the handler from a browser session holding %s",
    async (scope) => {
      const { handler, respond } = await dispatch([scope]);
      expect(handler).toHaveBeenCalledOnce();
      expect(respond).toHaveBeenCalledWith(true, { ok: true });
    },
  );

  it("asks a read-only session for talk scope, not admin", async () => {
    const { handler, respond } = await dispatch(["operator.read"]);
    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "missing scope: operator.talk" }),
    );
  });
});
