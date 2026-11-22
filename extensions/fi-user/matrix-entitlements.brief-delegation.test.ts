import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTHORIZE_URL,
  fetchMock,
  installDelegationFixtures,
  matrix,
  minted,
  mints,
  plugin,
  TOKEN,
} from "./admin-delegation.test-helpers.js";

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

  it("mints nothing for a brief turn's command, and strips what the model supplied", async () => {
    answer(() => admission(brief));
    const turn = plugin();
    await turn.arrive(matrix.arrive);
    expect(await turn.start(matrix.start)).toBeUndefined();
    const result = await turn.exec(matrix.exec, {
      params: {
        command: "cellect commands list",
        env: { FI_DELEGATED_USER_TOKEN: "forged", FI_ON_BEHALF_OF: "forged", KEEP: "1" },
      },
    });
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

describe("Matrix steering around Fi-judged authorship", () => {
  beforeEach(() => {
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
  });

  it.each([
    ["a brief arriving during the person's run", { authorship: { kind: "person" } }],
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

  it("also with cross-channel custody on", async () => {
    answer(() => admission(brief));
    const turn = plugin({ crossChannelCustody: true });
    await turn.arrive(matrix.arrive);
    await turn.start(matrix.start);
    expect(await turn.steer(steer())).toEqual({ handled: true });
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
