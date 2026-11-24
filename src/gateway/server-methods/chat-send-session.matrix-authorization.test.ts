import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../infra/device-identity-async.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import {
  consultRoute,
  consultSessionKey,
  useTalkConsultFixtures,
} from "../talk-agent-consult.test-support.js";
import { prepareTalkRelayConsultAdmission } from "../talk-relay-consult-admission.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { prepareChatSendSession, qualifyChatSendSession } from "./chat-send-session.js";
import { withCurrentChatSendRetry } from "./chat-send-work-admission.js";
import type { GatewayClient } from "./types.js";

const matrixDelivery: SessionEntry["delivery"] = {
  kind: "external",
  route: { channel: "matrix", target: { to: "!secret:example.test" } },
  context: { channel: "matrix", to: "!secret:example.test" },
  origin: { provider: "matrix" },
};
const denied = "Matrix conversations require an authorized conversation binding";

async function withFixture(
  run: (fixture: {
    cfg: OpenClawConfig;
    client: GatewayClient;
    context: ReturnType<typeof createDirectChatContext>;
    seed: (sessionKey: string, overrides?: Partial<SessionEntry>) => SessionEntry;
    prepare: (sessionKey: string) => Promise<{
      request: Extract<Awaited<ReturnType<typeof normalizeChatSendRequest>>, { ok: true }>["value"];
      prepared: Awaited<ReturnType<typeof prepareChatSendSession>>;
    }>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "chat-matrix-browser-admission" }, async () => {
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, "fi-user": {} } },
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    await loadOrCreateProcessDeviceIdentityAsync();
    const client = sharingPolicyClient({ scopes: ["operator.admin"] });
    client.pairedClientId = "openclaw-control-ui";
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    await run({
      cfg,
      client,
      context,
      seed(sessionKey, overrides = {}) {
        const entry = { sessionId: "same-session", updatedAt: 1, ...overrides };
        replaceSessionEntrySync({ agentId: "main", sessionKey }, entry);
        return entry;
      },
      async prepare(sessionKey) {
        const request = await normalizeChatSendRequest({
          client,
          params: { sessionKey, message: "Hello", idempotencyKey: "matrix-browser-attempt" },
        });
        if (!request.ok) throw new Error(request.error);
        return {
          request: request.value,
          prepared: await prepareChatSendSession({ request: request.value, context, client }),
        };
      },
    });
  });
}

describe("chat.send Matrix browser authorization through native worker reads", () => {
  it("rejects the authenticated device ceiling despite a claimed CLI identity", async () => {
    await withFixture(async (f) => {
      const key = "agent:main:dashboard:ceiling";
      f.seed(key);
      f.client.allowedAgentIds = ["fi-user"];
      f.client.connect.client.id = "cli";
      f.client.connect.client.mode = "cli";
      const { prepared } = await f.prepare(key);
      expect(prepared).toEqual({ ok: false, error: denied });
    });
  });

  it.each(["canonical", "row route"] as const)("rejects Matrix selected by %s", async (kind) => {
    await withFixture(async (f) => {
      const key =
        kind === "canonical"
          ? "agent:main:matrix:channel:!secret:example.test:thread:$root"
          : "agent:main:dashboard:opaque-alias";
      f.seed(key, kind === "row route" ? { delivery: matrixDelivery } : {});
      const { prepared } = await f.prepare(key);
      expect(prepared).toEqual({ ok: false, error: denied });
    });
  });

  it.each(["unchanged", "rerouted", "ceiling revoked"] as const)(
    "consumes the current native row before admission (%s)",
    async (change) => {
      await withFixture(async (f) => {
        const key = "agent:main:dashboard:route-race";
        const initial = f.seed(key);
        const { request, prepared } = await f.prepare(key);
        if (!prepared.ok) throw new Error("Expected internal session preparation");
        const session = await qualifyChatSendSession(prepared.value);
        if (change === "rerouted") {
          // Preserve incarnation and physical store: only the authoritative route changes.
          f.seed(key, { ...initial, updatedAt: 2, delivery: matrixDelivery });
        }
        if (change === "ceiling revoked") f.client.allowedAgentIds = ["fi-user"];
        const consume = vi.fn();
        const admission = withCurrentChatSendRetry(
          {
            session,
            request,
            context: f.context,
            client: f.client,
            respond: vi.fn(),
          },
          "pending-attempt",
          consume,
        );
        if (change === "unchanged") {
          await admission;
          expect(consume).toHaveBeenCalledOnce();
        } else {
          await expect(admission).rejects.toThrow(denied);
          expect(consume).not.toHaveBeenCalled();
        }
      });
    },
  );
});

describe("chat.send native Talk binding at current row admission", () => {
  const fixture = useTalkConsultFixtures();
  it.each(["current", "expired"] as const)(
    "requires a %s retained relay capability",
    async (state) => {
      const f = await fixture();
      const origin = {
        originatingChannel: consultRoute.channel,
        originatingTo: `room:${consultRoute.roomId}`,
        messageThreadId: consultRoute.threadRootEventId,
        accountId: consultRoute.accountId,
      };
      const capability = prepareTalkRelayConsultAdmission({
        relaySessionId: f.relay.id,
        connId: f.client.connId!,
        sessionKey: consultSessionKey,
        callId: "provider-call",
        matrixRoute: consultRoute,
      });
      const normalized = await normalizeChatSendRequest({
        client: f.client,
        params: {
          sessionKey: consultSessionKey,
          message: "Hello",
          idempotencyKey: "talk-matrix-attempt",
        },
      });
      if (!normalized.ok) throw new Error(normalized.error);
      const request = { ...normalized.value, explicitOrigin: origin };
      const prepared = await prepareChatSendSession({
        request,
        client: f.client,
        context: f.context,
        talkRelayAdmission: capability,
      });
      if (!prepared.ok) throw new Error("Expected bound Talk preparation");
      const session = await qualifyChatSendSession(prepared.value);
      if (state === "expired") f.relay.expiresAtMs = Date.now() - 1;
      const consume = vi.fn();
      const admission = withCurrentChatSendRetry(
        {
          request,
          session,
          client: f.client,
          context: f.context,
          respond: vi.fn(),
          talkRelayAdmission: capability,
        },
        "pending-talk-attempt",
        consume,
      );
      if (state === "current") {
        await admission;
        expect(consume).toHaveBeenCalledOnce();
      } else {
        await expect(admission).rejects.toThrow(
          "Matrix Talk consultation authority is no longer current",
        );
        expect(consume).not.toHaveBeenCalled();
      }
    },
  );
});
