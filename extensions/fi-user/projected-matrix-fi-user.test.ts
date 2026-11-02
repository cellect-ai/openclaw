import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installDelegationFixtures, plugin } from "./admin-delegation.test-helpers.js";
import { isFiUserTurn, requesterIdentity } from "./fi-delegation.js";

type Decision = { sessionKey: string; roomId: string; senderId: string; allowed: boolean };
const guard = vi.hoisted(() => ({ decided: undefined as undefined | ((d: Decision) => void) }));
// Fi's source guard is exercised in its own tests; here only its answer matters.
vi.mock("./source-reply-authorization.js", () => ({
  registerSourceReplyAuthorization: (
    _api: unknown,
    _connection: unknown,
    onDecision?: (decision: Decision) => void,
  ) => {
    guard.decided = onDecision;
  },
}));

installDelegationFixtures();

const SESSION = "agent:cellect-fi-user:slack:channel:c0channel1:thread:1792189039.487369";
const ROOM = "!projection:matrix.example";
const MEMBER = "@member:matrix.example";
const allow = (overrides: Partial<Decision> = {}) =>
  guard.decided?.({ sessionKey: SESSION, roomId: ROOM, senderId: MEMBER, allowed: true, ...overrides });
/** A Fi-user reply in a Slack thread's projection; the host reports the Slack session's channel. */
const reply = (senderId = MEMBER, eventId = "$reply") => ({
  arrive: {
    channel: "slack",
    senderId,
    sessionKey: SESSION,
    accountId: "userprod",
    isGroup: true,
    messageId: eventId,
  },
  start: {
    runId: "run-1",
    agentId: "cellect-fi-user",
    sessionKey: SESSION,
    channel: "slack",
    accountId: "fi-user",
    senderId,
    channelContext: { sender: { id: senderId }, chat: { id: ROOM, eventId } },
  },
});
const tool = (overrides: Record<string, unknown> = {}) =>
  ({
    agentId: "cellect-fi-user",
    runId: "run-1",
    sessionKey: SESSION,
    messageChannel: "slack",
    agentAccountId: "fi-user",
    requesterSenderId: MEMBER,
    deliveryContext: { channel: "slack", to: "channel:C0CHANNEL1", accountId: "fi-user" },
    ...overrides,
  }) as unknown as OpenClawPluginToolContext;

describe("a projected Matrix reply in a Slack-keyed Fi-user session", () => {
  beforeEach(() => {
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ userprod: "prod" }));
  });

  it("takes the requester from the verified Matrix sender although the run reports Slack", async () => {
    const turn = plugin();
    allow();
    await turn.arrive(reply().arrive);
    await turn.start(reply().start);
    expect(requesterIdentity(tool())).toEqual({ channel: "matrix", requesterMatrixUserId: MEMBER });
    expect(isFiUserTurn(tool())).toBe(true);
    await turn.settle();
    expect(requesterIdentity(tool())).toBeNull();
  });

  it("keeps a Slack sender a Slack requester", async () => {
    const turn = plugin();
    allow();
    await turn.arrive(reply().arrive);
    await turn.start(reply().start);
    expect(requesterIdentity(tool({ requesterSenderId: "U12345678" }))).toEqual({
      channel: "slack",
      requesterSenderId: "U12345678",
    });
  });

  it.each([
    ["no source guard answer", () => undefined, {}],
    ["an answer for another person", () => allow({ senderId: "@other:matrix.example" }), {}],
    ["an unverified dispatch", () => allow(), { senderAuthentication: "asserted" }],
  ])("refuses with %s", async (_name, answer, arrival) => {
    const turn = plugin();
    answer();
    await turn.arrive({ ...reply().arrive, ...arrival });
    await turn.start(reply().start);
    expect(requesterIdentity(tool())).toBeNull();
  });

  it("refuses a run started on another event, in another room, or by a bot", async () => {
    for (const start of [
      { channelContext: { sender: { id: MEMBER }, chat: { id: ROOM, eventId: "$other" } } },
      { channelContext: { sender: { id: MEMBER }, chat: { id: "!elsewhere:matrix.example", eventId: "$reply" } } },
      { channelContext: { sender: { id: MEMBER, isBot: true }, chat: { id: ROOM, eventId: "$reply" } } },
    ]) {
      const turn = plugin();
      allow();
      await turn.arrive(reply().arrive);
      await turn.start({ ...reply().start, ...start, runId: "run-x" });
      expect(requesterIdentity(tool({ runId: "run-x" }))).toBeNull();
    }
  });

  it("refuses another run, another session and another named sender", async () => {
    const turn = plugin();
    allow();
    await turn.arrive(reply().arrive);
    await turn.start(reply().start);
    expect(requesterIdentity(tool({ runId: "run-2" }))).toBeNull();
    expect(requesterIdentity(tool({ sessionKey: `${SESSION}9` }))).toBeNull();
    expect(requesterIdentity(tool({ requesterSenderId: "@other:matrix.example" }))).toBeNull();
  });

  it("refuses once another sender writes into the session mid-run", async () => {
    const turn = plugin();
    allow();
    await turn.arrive(reply().arrive);
    await turn.start(reply().start);
    await turn.inject({ channel: "slack", senderId: "U0OTHER002", sessionKey: SESSION });
    expect(requesterIdentity(tool())).toBeNull();
  });

  it("does not let one verified reply prove the next run", async () => {
    const turn = plugin();
    allow();
    await turn.arrive(reply().arrive);
    await turn.start(reply().start);
    await turn.start({ ...reply().start, runId: "run-2" });
    expect(requesterIdentity(tool({ runId: "run-2" }))).toBeNull();
  });
});
