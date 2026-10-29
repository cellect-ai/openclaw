import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installDelegationFixtures,
  mintBody,
  mints,
  plugin,
  SLACK_THREAD,
  TOKEN,
} from "./admin-delegation.test-helpers.js";

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

const ROOM = "!projection:matrix.example";
const ADMIN = "@admin:matrix.example";
/** A reply typed in the Matrix projection of a Slack thread the admin agent owns. */
const reply = (senderId = ADMIN, eventId = "$reply", roomId = ROOM) => ({
  arrive: {
    channel: "matrix",
    senderId,
    sessionKey: SLACK_THREAD,
    isGroup: true,
    messageId: eventId,
  },
  start: {
    channel: "matrix",
    senderId,
    sessionKey: SLACK_THREAD,
    accountId: "adminprod",
    chatId: roomId,
    channelContext: { sender: { id: senderId }, chat: { id: roomId, eventId } },
  },
  exec: {
    sessionKey: SLACK_THREAD,
    requester: { channel: "matrix", senderId, accountId: "adminprod" },
  },
});
const allow = (overrides: Partial<Decision> = {}) =>
  guard.decided?.({
    sessionKey: SLACK_THREAD,
    roomId: ROOM,
    senderId: ADMIN,
    allowed: true,
    ...overrides,
  });

describe("a Matrix reply to a Slack source session", () => {
  beforeEach(() => {
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
  });

  it("mints for the sender Fi's source guard allowed from that projection room", async () => {
    const turn = plugin();
    const message = reply();
    allow();
    await turn.arrive(message.arrive);
    await turn.start(message.start);
    const result = await turn.exec(message.exec);
    expect(result?.params).toMatchObject({
      host: "sandbox",
      elevated: false,
      env: { FI_DELEGATED_USER_TOKEN: TOKEN },
    });
    expect(mintBody()).toEqual({ requesterMatrixUserId: ADMIN, agentId: "cellect-fi-admin" });
  });

  it.each([
    ["no source guard answer", () => undefined],
    ["an answer for another person", () => allow({ senderId: "@other:matrix.example" })],
    ["an answer for another session", () => allow({ sessionKey: `${SLACK_THREAD}9` })],
    ["a later refusal", () => (allow(), allow({ allowed: false }))],
  ])("does not mint with %s", async (_name, answer) => {
    const turn = plugin();
    const message = reply();
    answer();
    await turn.arrive(message.arrive);
    await turn.start(message.start);
    expect(JSON.stringify(await turn.exec(message.exec))).not.toContain(TOKEN);
    expect(mints()).toEqual([]);
  });

  it.each([
    ["an asserted sender", { senderAuthentication: "asserted" }, {}],
    ["a bot sender", {}, { sender: { id: ADMIN, isBot: true } }],
  ])("does not mint for %s", async (_name, arrival, origin) => {
    const turn = plugin();
    const message = reply();
    allow();
    await turn.arrive({ ...message.arrive, ...arrival });
    await turn.start({
      ...message.start,
      channelContext: { ...message.start.channelContext, ...origin },
    });
    expect(JSON.stringify(await turn.exec(message.exec))).not.toContain(TOKEN);
    expect(mints()).toEqual([]);
  });

  it("matches the session however the guard cased it", async () => {
    const turn = plugin();
    const message = reply();
    allow({ sessionKey: SLACK_THREAD.replace("c0channel1", "C0CHANNEL1") });
    await turn.arrive(message.arrive);
    await turn.start(message.start);
    expect((await turn.exec(message.exec))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
  });

  it("does not mint in a Slack DM's projection", async () => {
    const turn = plugin();
    const dm = "agent:cellect-fi-admin:slack:direct:u0admin001";
    const message = reply();
    allow({ sessionKey: dm });
    await turn.arrive({ ...message.arrive, sessionKey: dm });
    await turn.start({ ...message.start, sessionKey: dm });
    expect(JSON.stringify(await turn.exec({ ...message.exec, sessionKey: dm }))).not.toContain(
      TOKEN,
    );
    expect(mints()).toEqual([]);
  });

  it("does not mint when another person writes before the run starts", async () => {
    const turn = plugin();
    const message = reply();
    allow();
    await turn.arrive(message.arrive);
    await turn.arrive({
      channel: "slack",
      senderId: "U0OTHER002",
      sessionKey: SLACK_THREAD,
      isGroup: true,
      messageId: "1792190999.000001",
    });
    await turn.start(message.start);
    expect(JSON.stringify(await turn.exec(message.exec))).not.toContain(TOKEN);
    expect(mints()).toEqual([]);
  });

  it("does not mint for a run whose event came from another room", async () => {
    const turn = plugin();
    const message = reply();
    allow();
    await turn.arrive(message.arrive);
    await turn.start(reply(ADMIN, "$reply", "!elsewhere:matrix.example").start);
    expect(JSON.stringify(await turn.exec(message.exec))).not.toContain(TOKEN);
    expect(mints()).toEqual([]);
  });

  it("does not mint once the source guard's answer is stale", async () => {
    vi.useFakeTimers();
    try {
      const turn = plugin();
      const message = reply();
      allow();
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      await turn.arrive(message.arrive);
      await turn.start(message.start);
      expect(JSON.stringify(await turn.exec(message.exec))).not.toContain(TOKEN);
      expect(mints()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let one allowed reply prove the next run", async () => {
    const turn = plugin();
    const message = reply();
    allow();
    await turn.arrive(message.arrive);
    await turn.start(message.start);
    expect((await turn.exec(message.exec))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
    await turn.settle();
    await turn.start({ ...message.start, runId: "run-2" });
    const next = await turn.exec({ ...message.exec, runId: "run-2" });
    expect(JSON.stringify(next)).not.toContain(TOKEN);
  });
});
