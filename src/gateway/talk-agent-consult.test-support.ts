import { expect, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../infra/device-identity-async.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { gatewayConnect, gatewayProfile } from "./server/client-fixtures.test-support.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import { useRelayFixtures } from "./talk/relay/fixture.test-support.js";

export const consultSessionKey = "agent:main:matrix:channel:!private:example.test:thread:$root";
export const consultRoute = {
  channel: "matrix" as const,
  roomId: "!private:example.test",
  threadRootEventId: "$root",
  accountId: "main",
};

/** Native persistent target, relay and requester; only a test's selected downstream seam is synthetic. */
export function useTalkConsultFixtures() {
  const createRelay = useRelayFixtures();
  return async (options: { speakerMxid?: string | null } = {}) => {
    await loadOrCreateProcessDeviceIdentityAsync();
    await prepareUserProfileCatalog();
    const profile = ensureProfileForEmail("talk-consult-operator@example.test");
    const cfg = { agents: { entries: { main: {} } }, session: {} };
    setRuntimeConfigSnapshot(cfg);
    await replaceSessionEntry(
      { agentId: "main", sessionKey: consultSessionKey },
      {
        sessionId: "consult-session",
        updatedAt: Date.now(),
        createdActor: { type: "human", source: "profile", id: profile.id },
      },
    );
    const { relay } = await createRelay({
      cfg,
      key: consultSessionKey,
      connId: "browser-owner",
      matrixRoute: { ...consultRoute },
      ...(options.speakerMxid === null
        ? {}
        : { speakerMxid: options.speakerMxid ?? "@member:example.test" }),
    });
    relay.toolCalls.tryAdmit(["provider-call"]);
    const context = relay.context;
    context.getCommittedRuntimeConfig = () => cfg;
    const client: GatewayClient = {
      connId: relay.connId,
      pairedClientId: "openclaw-control-ui",
      authenticatedUserProfile: gatewayProfile(profile.id),
      connect: gatewayConnect(["operator.read", "operator.write", "operator.admin"]),
      allowedAgentIds: ["main"],
    };
    const params = {
      sessionKey: consultSessionKey,
      voiceSessionId: relay.id,
      relaySessionId: relay.id,
      callId: "provider-call",
      name: "openclaw_agent_consult",
      args: { question: "What changed?" },
    };
    async function invoke(overrides: Record<string, unknown> = {}) {
      const selected = { ...params, ...overrides };
      const authorized = await resolveSessionMutationAuthorizationAsync({
        method: "talk.client.toolCall",
        requestParams: selected,
        context,
        client,
      });
      const respond = vi.fn();
      if (authorized.error) {
        respond(false, undefined, authorized.error);
        return respond;
      }
      expect(authorized.authorization?.talkSessionTarget?.canonicalKey).toBe(consultSessionKey);
      try {
        const { talkClientHandlers } = await import("./talk/handlers/client.js");
        await talkClientHandlers["talk.client.toolCall"]!({
          req: { type: "req", id: "consult-request", method: "talk.client.toolCall" },
          params: selected,
          context,
          client,
          respond,
          sessionMutationAuthorization: authorized.authorization,
        } as GatewayRequestHandlerOptions);
      } finally {
        authorized.authorization?.release?.();
      }
      return respond;
    }
    return { relay, context, client, cfg, params, invoke };
  };
}
