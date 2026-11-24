import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, onTestFinished, vi, type Mock } from "vitest";
import { ErrorCodes } from "../../../../packages/gateway-protocol/src/index.js";
import { resolveCommandAuthorization } from "../../../auto-reply/command-auth.js";
import { prepareUserProfileCatalog } from "../../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { resolveChatSendCallerContext } from "../../server-methods/gateway-client-identity.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "../../server-methods/types.js";
import { gatewayProfile } from "../../server/client-fixtures.test-support.js";
import { relaySessions } from "../relay/state.js";
import { forgetLegacyVoiceBinding } from "./client-legacy-voice-bindings.js";
import type { createTalkHandlerCaller } from "./handler-invocation.test-support.js";

/** Runs under the handler suite's actual preparation and mock dispatch setup. */
export function registerTalkHandlerAuthorityTests({
  chatSend,
  callTalkHandler,
}: {
  chatSend: Mock;
  callTalkHandler: ReturnType<typeof createTalkHandlerCaller>;
}) {
  it("retains the original human authority through the Talk chat client copy", async () => {
    const connId = "conn-command-authority";
    const profile = ensureProfileForEmail("ada@example.test");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    onTestFinished(() => forgetLegacyVoiceBinding(connId, "main", "voice-test"));
    const client: GatewayClient = {
      connId,
      authenticatedUserId: "ada@example.test",
      authenticatedUserProfile: gatewayProfile(profile.id, "Ada"),
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
        scopes: ["operator.write"],
        caps: ["tool-events", "task-suggestions"],
      },
    };
    let forwardedClient: GatewayClient | null | undefined;
    chatSend.mockImplementationOnce(async (request: GatewayRequestHandlerOptions) => {
      forwardedClient = request.client;
      request.respond(true, { runId: "run-voice-1" }, undefined);
    });
    await callTalkHandler("talk.client.toolCall", {
      params: {
        sessionKey: "main",
        callId: "call-owned",
        name: "openclaw_agent_consult",
        args: { question: "Check status" },
      },
      client,
      respond: vi.fn(),
      context: { getRuntimeConfig: () => ({}) },
    });
    const copiedClient = expectDefined(forwardedClient, "Talk consult must dispatch its client");
    expect(copiedClient).not.toBe(client);
    const ctx = resolveChatSendCallerContext(copiedClient);
    const authorize = () =>
      resolveCommandAuthorization({
        ctx,
        cfg: { commands: { ownerAllowFrom: [profile.id], allowFrom: { "*": [profile.id] } } },
        commandAuthorized: false,
      });
    expect(authorize().senderIsOwner).toBe(true);
    client.invalidated = true;
    expect(authorize().senderIsOwner).toBe(false);
    expect(copiedClient.connect.caps).toEqual(["tool-events"]);
  });

  it("carries the live relay fence to the chat user-turn commit owner", async () => {
    const respond = vi.fn();
    chatSend.mockImplementationOnce(async (request: GatewayRequestHandlerOptions) => {
      const authority = expectDefined(
        request.sessionMutationAuthorization,
        "retained Talk source authority",
      );
      expect(() => authority.assertCurrent()).not.toThrow();
      relaySessions.delete("relay-1");
      expect(() => authority.assertCurrent()).toThrow("retry the request");
      request.respond(false, undefined, { code: ErrorCodes.UNAVAILABLE, message: "relay closed" });
    });
    await callTalkHandler("talk.client.toolCall", {
      params: {
        relaySessionId: "relay-1",
        callId: "call-relay-commit-fence",
        name: "openclaw_agent_consult",
        args: { question: "Continue" },
      },
      respond,
      // The refused relay settles after acknowledgement; the handler logs that failure.
      context: { getRuntimeConfig: () => ({}), logGateway: { warn: vi.fn() } },
    });
    expect(chatSend).toHaveBeenCalledOnce();
  });
}
