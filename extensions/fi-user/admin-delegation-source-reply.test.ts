import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installDelegationFixtures,
  mintBody,
  mints,
  plugin,
  SLACK_THREAD,
  TOKEN,
} from "./admin-delegation.test-helpers.js";

type Decision = {
  sessionKey: string;
  roomId: string;
  senderId: string;
  allowed: boolean;
  authorizedAt: number;
};
const admissions = new Map<string, Decision>();
installDelegationFixtures();

const ROOM = "!projection:matrix.example";
const ADMIN = "@admin:matrix.example";
/** A reply typed in the Matrix projection of a Slack thread the admin agent owns. */
const reply = (senderId = ADMIN, eventId = "$reply", roomId = ROOM) => ({
  arrive: {
    channel: "matrix",
    accountId: "adminprod",
    senderId,
    sessionKey: SLACK_THREAD,
    isGroup: true,
    messageId: eventId,
    get channelContext() {
      return admittedContext(senderId, eventId, roomId);
    },
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
const allow = (overrides: Partial<Decision> = {}) => {
  const decision = {
    sessionKey: SLACK_THREAD,
    roomId: ROOM,
    senderId: ADMIN,
    allowed: true,
    authorizedAt: Date.now(),
    ...overrides,
  };
  admissions.set(decision.senderId, decision);
};
const admittedContext = (senderId: string, eventId: string, roomId = ROOM) => {
  const decision = admissions.get(senderId);
  return {
    sender: { id: senderId },
    chat: {
      id: roomId,
      eventId,
      ...(decision?.allowed
        ? {
            sourceReplyAdmission: {
              version: 1,
              sessionKey: decision.sessionKey,
              roomId: decision.roomId,
              senderId: decision.senderId,
              accountId: "adminprod",
              eventId,
              authorizedAt: decision.authorizedAt,
            },
          }
        : {}),
    },
  };
};

describe("a Matrix reply to a Slack source session", () => {
  beforeEach(() => {
    admissions.clear();
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

  it("carries an ingress admission to a separately registered agent instance", async () => {
    const root = plugin();
    allow();
    const emitted = reply().arrive;
    const scoped = plugin();
    await scoped.arrive(emitted);
    await scoped.start(reply().start);
    expect((await scoped.exec(reply().exec))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
    expect(root.info).not.toHaveBeenCalled();
    expect(mints()).toHaveLength(1);
  });

  it.each([
    ["session", { sessionKey: `${SLACK_THREAD}9` }],
    ["room", { roomId: "!other:matrix.example" }],
    ["event", { eventId: "$other" }],
    ["sender", { senderId: "@other:matrix.example" }],
    ["account", { accountId: "otherprod" }],
    ["version", { version: 2 }],
    ["future admission", { authorizedAt: Date.now() + 60_000 }],
  ])("refuses an admission with a different %s", async (_label, mismatch) => {
    const turn = plugin();
    allow();
    const message = reply();
    const context = admittedContext(ADMIN, "$reply");
    await turn.arrive({
      ...message.arrive,
      channelContext: {
        ...context,
        chat: {
          ...context.chat,
          sourceReplyAdmission: {
            ...context.chat.sourceReplyAdmission,
            ...mismatch,
          },
        },
      },
    });
    await turn.start(message.start);
    expect(JSON.stringify(await turn.exec(message.exec))).not.toContain(TOKEN);
    expect(mints()).toEqual([]);
  });

  it.each([
    ["no source guard answer", () => undefined],
    ["an answer for another person", () => allow({ senderId: "@other:matrix.example" })],
    ["an answer for another session", () => allow({ sessionKey: `${SLACK_THREAD}9` })],
    [
      "a later refusal",
      () => {
        allow();
        allow({ allowed: false });
      },
    ],
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

  it("matches the source session however the admitted key cased it", async () => {
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

/**
 * The host can report the Slack session's channel (and account) for a run its
 * Matrix projection started. The verified Matrix dispatch of that very event
 * still names the person; nothing else may.
 */
describe("a Matrix reply to a Slack source session the host labels as Slack", () => {
  beforeEach(() => {
    admissions.clear();
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
  });
  const asSlack = (message = reply()) => ({
    arrive: {
      ...message.arrive,
      accountId: "adminprod",
      get channelContext() {
        return message.arrive.channelContext;
      },
    },
    start: { ...message.start, channel: "slack", accountId: "fi-admin" },
    exec: {
      ...message.exec,
      requester: {
        channel: "slack",
        senderId: message.exec.requester.senderId,
        accountId: "fi-admin",
      },
    },
  });

  it("mints for the verified Matrix sender when the run and tool report Slack", async () => {
    const turn = plugin();
    const message = asSlack();
    allow();
    await turn.arrive(message.arrive);
    await turn.start(message.start);
    expect((await turn.exec(message.exec))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
    expect(mintBody()).toEqual({ requesterMatrixUserId: ADMIN, agentId: "cellect-fi-admin" });
  });

  it("mints when the dispatch itself is labelled with the Slack session's channel", async () => {
    const turn = plugin();
    const message = asSlack();
    allow();
    await turn.arrive({ ...message.arrive, channel: "slack" });
    await turn.start(message.start);
    expect((await turn.exec(message.exec))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
    expect(mintBody()).toEqual({ requesterMatrixUserId: ADMIN, agentId: "cellect-fi-admin" });
  });

  it("does not mint for a Slack sender starting a run on the Matrix event", async () => {
    const turn = plugin();
    const message = asSlack();
    allow();
    await turn.arrive(message.arrive);
    await turn.start({
      ...message.start,
      senderId: "U0ADMIN001",
      channelContext: { ...message.start.channelContext, sender: { id: "U0ADMIN001" } },
    });
    const result = await turn.exec({
      ...message.exec,
      requester: { channel: "slack", senderId: "U0ADMIN001" },
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(mints()).toEqual([]);
  });

  it("does not mint for a Matrix sender the source guard did not allow", async () => {
    const turn = plugin();
    const message = asSlack(reply("@other:matrix.example"));
    allow();
    await turn.arrive({ ...message.arrive, channel: "slack" });
    await turn.start(message.start);
    expect(JSON.stringify(await turn.exec(message.exec))).not.toContain(TOKEN);
    expect(mints()).toEqual([]);
  });

  it("does not mint for an asserted (unverified) Matrix sender", async () => {
    const turn = plugin();
    const message = asSlack();
    allow();
    await turn.arrive({ ...message.arrive, senderAuthentication: "asserted" });
    await turn.start(message.start);
    expect(JSON.stringify(await turn.exec(message.exec))).not.toContain(TOKEN);
    expect(mints()).toEqual([]);
  });

  it("does not mint for a tool call naming another person than the admitted sender", async () => {
    const turn = plugin();
    const message = asSlack();
    allow();
    await turn.arrive(message.arrive);
    await turn.start(message.start);
    const result = await turn.exec({
      ...message.exec,
      requester: { channel: "slack", senderId: "@other:matrix.example", accountId: "fi-admin" },
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(mints()).toEqual([]);
  });

  it("does not mint once another sender writes into the session mid-run", async () => {
    const turn = plugin();
    const message = asSlack();
    allow();
    await turn.arrive(message.arrive);
    await turn.start(message.start);
    await turn.inject({ channel: "slack", senderId: "U0OTHER002", sessionKey: SLACK_THREAD });
    expect(JSON.stringify(await turn.exec(message.exec))).not.toContain(TOKEN);
    expect(mints()).toEqual([]);
  });

  it("does not let the admitted reply prove the next run", async () => {
    const turn = plugin();
    const message = asSlack();
    allow();
    await turn.arrive(message.arrive);
    await turn.start(message.start);
    expect((await turn.exec(message.exec))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
    await turn.settle();
    await turn.start({ ...message.start, runId: "run-2" });
    expect(JSON.stringify(await turn.exec({ ...message.exec, runId: "run-2" }))).not.toContain(
      TOKEN,
    );
  });
});
