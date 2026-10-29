import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installDelegationFixtures,
  mintBody,
  mints,
  plugin,
  SLACK_THREAD,
  TOKEN,
} from "./admin-delegation.test-helpers.js";

type Allowed = { sessionKey: string; roomId: string; senderId: string };
const guard = vi.hoisted(() => ({ allowed: undefined as undefined | ((a: Allowed) => void) }));
// Fi's source guard is exercised in its own tests; here only its answer matters.
vi.mock("./source-reply-authorization.js", () => ({
  registerSourceReplyAuthorization: (
    _api: unknown,
    _connection: unknown,
    onAllowed?: (allowed: Allowed) => void,
  ) => {
    guard.allowed = onAllowed;
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
const allow = (overrides: Partial<Allowed> = {}) =>
  guard.allowed?.({ sessionKey: SLACK_THREAD, roomId: ROOM, senderId: ADMIN, ...overrides });

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
  ])("does not mint with %s", async (_name, answer) => {
    const turn = plugin();
    const message = reply();
    answer();
    await turn.arrive(message.arrive);
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
