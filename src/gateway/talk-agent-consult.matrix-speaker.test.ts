import { describe, expect, it, vi } from "vitest";
import { getCommandSenderAuthority } from "../auto-reply/command-sender-authority.js";
import { getRequesterProfile } from "../auto-reply/requester-profile.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { readSessionInputProfileId } from "../sessions/session-participant-input.js";
import { admitChatSend } from "./server-methods/chat-send-admission.js";
import { normalizeChatSendRequest } from "./server-methods/chat-send-request.js";
import {
  prepareChatSendSession,
  qualifyChatSendSession,
} from "./server-methods/chat-send-session.js";
import { prepareTurn } from "./server-methods/chat-send-user-turn-family.test-support.js";
import {
  consultRoute,
  consultSessionKey,
  useTalkConsultFixtures,
} from "./talk-agent-consult.test-support.js";
import { prepareTalkRelayConsultAdmission } from "./talk-relay-consult-admission.js";

const origin = {
  originatingChannel: "matrix",
  originatingTo: `room:${consultRoute.roomId}`,
  accountId: "main",
  messageThreadId: "$root",
  explicitDeliverRoute: true,
};

describe("native Matrix voice consult requester", () => {
  const fixture = useTalkConsultFixtures();
  it("uses only the app-attested speaker and never the hosting operator's execution identity", async () => {
    const f = await fixture({ speakerMxid: "@member:threads.example" });
    const channelRequester = prepareTalkRelayConsultAdmission({
      relaySessionId: f.relay.id,
      connId: f.relay.connId,
      sessionKey: consultSessionKey,
      callId: "provider-call",
      matrixRoute: consultRoute,
    });
    const turn = prepareTurn({
      client: f.client,
      admission: { originatingRoute: origin, channelRequester },
      request: { inboundMessage: "/status", clientInfo: f.client.connect.client },
      inputText: "/status",
      attachments: { parsedMessage: "/status" },
    });
    expect(turn.ctx).toMatchObject({
      OriginatingChannel: "matrix",
      SenderId: "@member:threads.example",
      Provider: "matrix",
      CommandAuthorized: false,
      CommandInterpretationSuppressed: true,
      GatewayClientScopes: [],
      GatewayClientCaps: [],
    });
    expect(turn.ctx.ApprovalReviewerDeviceId).toBeUndefined();
    expect(turn.ctx.GatewayUiCommandTarget).toBeUndefined();
    expect(getRequesterProfile(turn.ctx)).toBeUndefined();
    expect(readSessionInputProfileId(turn.ctx)).toBeUndefined();
    expect(getCommandSenderAuthority(turn.ctx)?.()).toBeUndefined();
    expect(turn.isInternalTextSlashCommandTurn).toBe(false);
    await turn.prepareSessionCreation();
    expect(turn.ctx.SessionCreation).not.toHaveProperty("skillLibrarySelections");
  });

  it("rejects a relay without an attested speaker before reserving a native chat source", async () => {
    const f = await fixture({ speakerMxid: null });
    const capability = prepareTalkRelayConsultAdmission({
      relaySessionId: f.relay.id,
      connId: f.relay.connId,
      sessionKey: consultSessionKey,
      callId: "provider-call",
      matrixRoute: consultRoute,
    });
    expect(capability.speakerMxid).toBeUndefined();
    const request = await normalizeChatSendRequest({
      client: f.client,
      params: {
        sessionKey: consultSessionKey,
        message: "Read the current status",
        idempotencyKey: "unattested-speaker",
        originatingChannel: "matrix",
        originatingTo: origin.originatingTo,
        originatingAccountId: "main",
        originatingThreadId: "$root",
      },
    });
    if (!request.ok) throw new Error(request.error);
    const target = await prepareChatSendSession({
      client: f.client,
      context: f.context,
      request: request.value,
      talkRelayAdmission: capability,
    });
    if (!target.ok)
      throw new Error(typeof target.error === "string" ? target.error : target.error.message);
    const prepared = {
      client: f.client,
      context: f.context,
      request: request.value,
      prepared: target.value,
      session: await qualifyChatSendSession(target.value),
    };
    const sourcesBefore = rpcSourceTesting.size;
    await expect(
      admitChatSend({ ...prepared, respond: vi.fn(), talkRelayAdmission: capability }),
    ).rejects.toThrow("Matrix Talk consultation requires an attested speaker");
    expect(rpcSourceTesting.size).toBe(sourcesBefore);
  });
});
