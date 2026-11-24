import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  THREAD,
  AUTHORIZE_URL,
  fetchMock,
  installDelegationFixtures,
  matrix,
  minted,
  mints,
  plugin,
  TOKEN,
} from "./admin-delegation.test-helpers.js";
import { DESK_BRIEF_TOOL_REFUSAL } from "./matrix-entitlements.js";

installDelegationFixtures();

const admission = (extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ ok: true, agentId: "cellect-fi-admin", orgId: "org-a", ...extra }));
const brief = {
  authorship: { kind: "desk_handoff", writtenBy: "agent", deskConversationId: "conv-1" },
};
const answer = (authorize: () => Response) =>
  fetchMock.mockImplementation(async (url: string) =>
    url === AUTHORIZE_URL ? authorize() : minted(),
  );
const steer = (senderId = "@admin:matrix.example", messageId = "$next") => ({
  channel: "matrix",
  senderId,
  sessionKey: matrix.start.sessionKey,
  messageId,
  accountId: "adminprod",
});

describe("a Desk brief and the admin agent's delegated token", () => {
  beforeEach(() => {
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
  });

  it("refuses the admin agent's shell under a brief, and mints nothing", async () => {
    answer(() => admission(brief));
    const turn = plugin();
    await turn.arrive(matrix.arrive);
    expect(await turn.start(matrix.start)).toBeUndefined();
    for (const toolName of ["exec", "sandbox_exec", "process"]) {
      expect(await turn.exec({ ...matrix.exec, toolName }, { toolName })).toEqual({
        block: true,
        blockReason: DESK_BRIEF_TOOL_REFUSAL,
      });
    }
    expect(mints()).toEqual([]);
  });

  it("refuses the shell of whatever agent the runtime configures as its admin", async () => {
    const sessionKey = "agent:ops-admin:matrix:channel:!dm:matrix.example";
    fetchMock.mockImplementation(async (url: string) =>
      url === AUTHORIZE_URL
        ? new Response(JSON.stringify({ ok: true, agentId: "ops-admin", orgId: "org-a", ...brief }))
        : minted(),
    );
    const turn = plugin({ adminAgentId: "ops-admin" });
    await turn.arrive({ ...matrix.arrive, sessionKey });
    await turn.start({ ...matrix.start, sessionKey, agentId: "ops-admin" });
    expect(await turn.exec({ ...matrix.exec, sessionKey, agentId: "ops-admin" })).toMatchObject({
      block: true,
      blockReason: DESK_BRIEF_TOOL_REFUSAL,
    });
  });

  it("lets a non-admin agent's command run under a brief without a token, stripping what the model supplied", async () => {
    const sessionKey = "agent:cellect-fi-user:matrix:channel:!dm:matrix.example";
    fetchMock.mockImplementation(async (url: string) =>
      url === AUTHORIZE_URL
        ? new Response(
            JSON.stringify({ ok: true, agentId: "cellect-fi-user", orgId: "org-a", ...brief }),
          )
        : minted(),
    );
    const turn = plugin();
    await turn.arrive({ ...matrix.arrive, sessionKey });
    expect(
      await turn.start({ ...matrix.start, sessionKey, agentId: "cellect-fi-user" }),
    ).toBeUndefined();
    const result = await turn.exec(
      { ...matrix.exec, sessionKey, agentId: "cellect-fi-user" },
      {
        params: {
          command: "ls",
          env: { FI_DELEGATED_USER_TOKEN: "forged", FI_ON_BEHALF_OF: "forged", KEEP: "1" },
        },
      },
    );
    expect(result?.block).toBeUndefined();
    expect(result?.params.env).toEqual({ KEEP: "1" });
    expect(mints()).toEqual([]);
  });

  it("still mints for the same command on a person's turn", async () => {
    answer(() => admission({ authorship: { kind: "person" } }));
    const turn = plugin();
    await turn.arrive(matrix.arrive);
    await turn.start(matrix.start);
    expect((await turn.exec(matrix.exec))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
  });
});

describe("the turn the admin agent's command token is minted for", () => {
  beforeEach(() => {
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
  });
  const mintBodies = () =>
    mints().map(
      ([, init]) => JSON.parse((init as { body: string }).body) as Record<string, unknown>,
    );

  it("names the admitted Matrix event", async () => {
    answer(() => admission({ authorship: { kind: "person" } }));
    const turn = plugin();
    await turn.arrive(matrix.arrive);
    await turn.start(matrix.start);
    expect((await turn.exec(matrix.exec))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
    expect(mintBodies()).toEqual([
      {
        requesterMatrixUserId: "@admin:matrix.example",
        agentId: "cellect-fi-admin",
        turn: { roomId: "!dm:matrix.example", eventId: "$event" },
      },
    ]);
  });

  it("takes Fi's brief answer on the mint as the turn's authorship", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === AUTHORIZE_URL
        ? admission({ authorship: { kind: "person" } })
        : new Response(
            JSON.stringify({
              ...(await minted().json()),
              turn: { authorship: "desk_handoff" },
            }),
          ),
    );
    const turn = plugin();
    await turn.arrive(matrix.arrive);
    await turn.start(matrix.start);
    // That token carries Fi's brief claims; Fi refuses it on send, sign and deliver routes.
    expect((await turn.exec(matrix.exec))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
    // From now on the gateway holds the turn as a brief as well.
    expect(await turn.exec(matrix.exec)).toEqual({
      block: true,
      blockReason: DESK_BRIEF_TOOL_REFUSAL,
    });
    expect(mints()).toHaveLength(1);
  });

  it("names no turn for a Slack requester", async () => {
    const turn = plugin();
    await turn.arrive();
    await turn.start();
    expect((await turn.exec())?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
    expect(mintBodies()[0]).not.toHaveProperty("turn");
  });
});

describe("Matrix steering around Fi-judged authorship", () => {
  beforeEach(() => {
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
  });

  it.each([
    [
      "a possible brief arriving during the person's run in a Desk task room",
      { authorship: { kind: "person" }, deskTaskRoom: true },
    ],
    ["the person's follow-up arriving during a brief's run", brief],
  ])("queues %s as its own turn", async (_name, authorship) => {
    answer(() => admission(authorship));
    const turn = plugin();
    await turn.arrive(matrix.arrive);
    await turn.start(matrix.start);
    expect(await turn.steer(steer())).toEqual({ handled: true });
    // Another sender too: no message takes another event's authorship.
    expect(await turn.steer(steer("@other:matrix.example", "$other"))).toEqual({ handled: true });
  });

  it.each([
    ["an ordinary room", { authorship: { kind: "person" } }],
    ["an older Fi that says nothing of authorship or task rooms", {}],
    ["a task-room flag that is not exactly true", { deskTaskRoom: "true" }],
  ])("steers a follow-up into the person's run in %s", async (_name, extra) => {
    answer(() => admission(extra));
    for (const config of [{}, { crossChannelCustody: true }]) {
      const turn = plugin(config);
      await turn.arrive(matrix.arrive);
      await turn.start(matrix.start);
      expect(await turn.steer(steer()), JSON.stringify(config)).toBeUndefined();
      await turn.settle();
    }
  });

  it("also with cross-channel custody on", async () => {
    answer(() => admission(brief));
    const turn = plugin({ crossChannelCustody: true });
    await turn.arrive(matrix.arrive);
    await turn.start(matrix.start);
    expect(await turn.steer(steer())).toEqual({ handled: true });
  });

  it("does not claim a Talk consult during a live voice turn, nor queue a message behind one", async () => {
    const root = "$root";
    const voice = {
      channel: "matrix",
      senderId: "@admin:matrix.example",
      sessionKey: THREAD,
      accountId: "adminprod",
      chatId: `!room:matrix.example:thread:${root}`,
      channelContext: {
        sender: { id: "@admin:matrix.example" },
        chat: { id: "!room:matrix.example", talkThreadRootEventId: root },
      },
    };
    for (const config of [{}, { crossChannelCustody: true }]) {
      answer(() => admission(brief));
      const turn = plugin(config);
      await turn.arrive({ ...voice, messageId: "$voice" });
      expect(await turn.start(voice)).toBeUndefined();
      expect(
        await turn.steer({ ...voice, messageId: "$consult" }),
        JSON.stringify(config),
      ).toBeUndefined();
      expect(
        await turn.steer({
          channel: "matrix",
          senderId: voice.senderId,
          sessionKey: THREAD,
          messageId: "$typed",
        }),
      ).toBeUndefined();
    }
  });

  it("leaves steering alone when no gated Matrix turn is live in the session", async () => {
    answer(() => admission(brief));
    const turn = plugin();
    expect(await turn.steer(steer())).toBeUndefined();
    await turn.arrive(matrix.arrive);
    await turn.start(matrix.start);
    await turn.settle();
    expect(await turn.steer(steer())).toBeUndefined();
    // Slack is not this gate's.
    expect(await turn.steer()).toBeUndefined();
  });
});
