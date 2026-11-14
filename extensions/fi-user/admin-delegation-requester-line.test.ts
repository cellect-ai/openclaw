import { resolveAgentHarnessBeforePromptBuildResult } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createMockPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installDelegationFixtures,
  fetchMock,
  minted,
  mints,
  MINT_URL,
  plugin,
  RESOLVE_URL,
  resolveMock,
  SESSION,
  SLACK_CHANNEL,
  slackThread,
  thread,
  THREAD,
  TOKEN,
} from "./admin-delegation.test-helpers.js";

installDelegationFixtures();
afterEach(() => resetGlobalHookRunner());

type Turn = ReturnType<typeof plugin>;
type PromptResult = { prependContext?: string; appendSystemContext?: string };

const UNCONFIRMED = "Fi requester: not confirmed for this turn.";

/** Every before_prompt_build handler of the plugin, results kept separately. */
async function promptResults(turn: Turn, context: Record<string, unknown>) {
  const results: PromptResult[] = [];
  for (const handler of turn.registrations.hooks.get("before_prompt_build") ?? []) {
    const result = (await handler({ prompt: "x", messages: [] } as never, context as never)) as
      | PromptResult
      | undefined;
    if (result) {
      results.push(result);
    }
  }
  return {
    turnContext: results.map((result) => result.prependContext ?? "").join("\n"),
    systemContext: results.map((result) => result.appendSystemContext ?? "").join("\n"),
  };
}

/**
 * The Codex harness's own prompt build over the plugin's registered hooks:
 * `prompt` is the turn input, `developerInstructions` the thread's persisted
 * generic policy.
 */
async function codexPromptBuild(turn: Turn, context: Record<string, unknown>) {
  initializeGlobalHookRunner(
    createMockPluginRegistry(
      (turn.registrations.hooks.get("before_prompt_build") ?? []).map((handler) => ({
        hookName: "before_prompt_build",
        pluginId: "fi-user",
        handler: handler as (...args: unknown[]) => unknown,
      })),
    ),
  );
  return resolveAgentHarnessBeforePromptBuildResult({
    prompt: "Current message: list rooms for 305 Third",
    developerInstructions: "base generic policy",
    messages: [],
    ctx: context,
  });
}

const run = (
  runId = "run-1",
  senderId = "U0ADMIN001",
  sessionKey = SESSION,
  channel = "slack",
) => ({
  runId,
  agentId: "cellect-fi-admin",
  sessionKey,
  channel,
  senderId,
  trigger: "user",
});

/** Fi's mint, answering each sender with that sender's own member email. */
function mintPerSender(emails: Record<string, string | undefined>, withRequester = true) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url !== MINT_URL) {
      return new Response(
        JSON.stringify({ ok: true, agentId: "cellect-fi-admin", orgId: "org-a" }),
      );
    }
    const body = JSON.parse(String(init?.body)) as {
      requesterSenderId?: string;
      requesterMatrixUserId?: string;
    };
    const email = emails[body.requesterSenderId ?? body.requesterMatrixUserId ?? ""];
    if (!email) {
      return new Response("not linked", { status: 404 });
    }
    const json = (await minted({}, { email }).json()) as Record<string, unknown>;
    return new Response(
      JSON.stringify(withRequester ? { ...json, requester: { channel: "slack", email } } : json),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

describe("the admin turn's Fi requester line", () => {
  it("states the email Fi resolved for this run's proven sender, as this turn's context", async () => {
    mintPerSender({ U0ADMIN001: "admin@example.com" });
    const turn = plugin();
    await turn.arrive();
    await turn.start();
    const { turnContext, systemContext } = await promptResults(turn, run());
    expect(turnContext).toContain(
      "Fi requester: admin@example.com. This turn acts as that member. Use --actor admin@example.com only when the installed command schema accepts or requires it.",
    );
    expect(systemContext).not.toContain("Fi requester");
    expect(turnContext).not.toContain(TOKEN);
    expect(mints()).toHaveLength(1);
    expect(JSON.parse(String((mints()[0]![1] as RequestInit).body))).toEqual({
      requesterSenderId: "U0ADMIN001",
      agentId: "cellect-fi-admin",
    });
  });

  it.each([
    ["Fi's answer carries no requester email (older Fi)", false, "admin@example.com"],
    ["the mint fails", true, undefined],
  ])("says the requester is not confirmed when %s", async (_label, withRequester, email) => {
    mintPerSender({ U0ADMIN001: email }, withRequester);
    const turn = plugin();
    await turn.arrive();
    await turn.start();
    const { turnContext } = await promptResults(turn, run());
    expect(turnContext).toContain(UNCONFIRMED);
    expect(turnContext).not.toContain("@example.com");
  });

  it("asks Fi nothing for a run whose sender is not proven", async () => {
    mintPerSender({ U0ADMIN001: "admin@example.com" });
    const turn = plugin();
    await turn.arrive();
    await turn.arrive({ senderId: "U0OTHER002" });
    await turn.start();
    expect((await promptResults(turn, run())).turnContext).toContain(UNCONFIRMED);
    expect(mints()).toHaveLength(0);
  });

  it("adds nothing to a non-user run or another agent's turn", async () => {
    mintPerSender({ U0ADMIN001: "admin@example.com" });
    const turn = plugin();
    expect(await promptResults(turn, { ...run(), trigger: "cron" })).toEqual({
      turnContext: "",
      systemContext: "",
    });
    expect(
      (await promptResults(turn, { ...run(), agentId: "cellect-fi-user" })).turnContext,
    ).not.toContain("Fi requester");
    expect(mints()).toHaveLength(0);
  });

  it("refuses an email that is not the delegated member's own", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url !== MINT_URL) {
        return new Response("{}");
      }
      const json = (await minted().json()) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          ...json,
          requester: { channel: "slack", email: "someone-else@example.com" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const turn = plugin();
    await turn.arrive();
    await turn.start();
    const { turnContext } = await promptResults(turn, run());
    expect(turnContext).toContain(UNCONFIRMED);
    expect(turnContext).not.toContain("someone-else@example.com");
  });
});

describe("two senders, one shared session, through the Codex harness prompt build", () => {
  it.each([
    ["Slack thread", "Fi mints for the second sender", "other@example.com"],
    ["Slack thread", "the second sender's mint fails", undefined],
  ])("%s: turn 2 never carries turn 1's line when %s", async (_where, _case, secondEmail) => {
    mintPerSender({ U0ADMIN001: "admin@example.com", U0OTHER002: secondEmail });
    const turn = plugin();
    const first = slackThread();
    await turn.arrive(first.arrive);
    await turn.start(first.start);
    const one = await codexPromptBuild(turn, run("run-1", "U0ADMIN001", first.start.sessionKey));
    expect(one.prompt).toContain("Fi requester: admin@example.com.");
    // Per-turn input, never the persisted thread policy.
    expect(one.developerInstructions).not.toContain("Fi requester");

    const senderId = "U0OTHER002";
    await turn.arrive({ ...first.arrive, senderId, messageId: "1792190934.152459" });
    await turn.start({
      ...first.start,
      runId: "run-2",
      senderId,
      channelContext: {
        sender: { id: senderId },
        chat: { id: SLACK_CHANNEL, eventId: "1792190934.152459" },
      },
    });
    const two = await codexPromptBuild(turn, run("run-2", senderId, first.start.sessionKey));
    expect(two.prompt).not.toContain("admin@example.com");
    expect(two.developerInstructions).not.toContain("Fi requester");
    expect(two.prompt).toContain(secondEmail ? `Fi requester: ${secondEmail}.` : UNCONFIRMED);
    // One mint per proven run; nothing reused across senders.
    expect(mints()).toHaveLength(2);
  });

  it.each([
    ["Fi mints for the second sender", "@other:matrix.example"],
    ["the second sender's mint fails", undefined],
  ])("Matrix thread: turn 2 never carries turn 1's line when %s", async (_case, secondKnown) => {
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
    mintPerSender({
      "@admin:matrix.example": "admin@example.com",
      ...(secondKnown ? { [secondKnown]: "other@example.com" } : {}),
    });
    const turn = plugin();
    const first = thread();
    await turn.arrive(first.arrive);
    await turn.start(first.start);
    const one = await codexPromptBuild(turn, {
      ...run("run-1", "@admin:matrix.example", THREAD, "matrix"),
      accountId: "adminprod",
    });
    expect(one.prompt).toContain("Fi requester: admin@example.com.");
    expect(one.developerInstructions).not.toContain("Fi requester");

    const second = thread("@other:matrix.example", "$e2");
    await turn.arrive(second.arrive);
    await turn.start({ ...second.start, runId: "run-2" });
    const two = await codexPromptBuild(turn, {
      ...run("run-2", "@other:matrix.example", THREAD, "matrix"),
      accountId: "adminprod",
    });
    expect(two.prompt).not.toContain("admin@example.com");
    expect(two.developerInstructions).not.toContain("Fi requester");
    expect(two.prompt).toContain(secondKnown ? "Fi requester: other@example.com." : UNCONFIRMED);
  });

  describe("with Fi's resolve-only route", () => {
    const resolved = (email: string, userEmail = email) =>
      new Response(
        JSON.stringify({
          ok: true,
          user: { email: userEmail },
          requester: { channel: "slack", email },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    it("uses it instead of the mint, with the mint's request body, and holds no token", async () => {
      resolveMock.mockImplementation(async () => resolved("admin@example.com"));
      const turn = plugin();
      await turn.arrive();
      await turn.start();
      const { turnContext } = await promptResults(turn, run());
      expect(turnContext).toContain("Fi requester: admin@example.com.");
      expect(mints()).toHaveLength(0);
      expect(resolveMock).toHaveBeenCalledTimes(1);
      expect(resolveMock.mock.calls[0]![0]).toBe(RESOLVE_URL);
      expect(JSON.parse(String((resolveMock.mock.calls[0]![1] as RequestInit).body))).toEqual({
        requesterSenderId: "U0ADMIN001",
        agentId: "cellect-fi-admin",
      });
    });

    it("refuses an email that is not the resolved user's own", async () => {
      resolveMock.mockImplementation(async () =>
        resolved("other@example.com", "admin@example.com"),
      );
      const turn = plugin();
      await turn.arrive();
      await turn.start();
      const { turnContext } = await promptResults(turn, run());
      expect(turnContext).toContain(UNCONFIRMED);
      expect(turnContext).not.toContain("@example.com");
    });

    it("says not confirmed, without falling back, when the route answers its own not-found", async () => {
      resolveMock.mockImplementation(async () => new Response("Not found", { status: 404 }));
      mintPerSender({ U0ADMIN001: "admin@example.com" });
      const turn = plugin();
      await turn.arrive();
      await turn.start();
      expect((await promptResults(turn, run())).turnContext).toContain(UNCONFIRMED);
      expect(mints()).toHaveLength(0);
    });

    it("says not confirmed, without falling back, when the route refuses", async () => {
      resolveMock.mockImplementation(async () => new Response("Forbidden", { status: 403 }));
      mintPerSender({ U0ADMIN001: "admin@example.com" });
      const turn = plugin();
      await turn.arrive();
      await turn.start();
      expect((await promptResults(turn, run())).turnContext).toContain(UNCONFIRMED);
      expect(mints()).toHaveLength(0);
    });

    it("falls back to the mint when Fi has no such route, and stops asking for a while", async () => {
      mintPerSender({ U0ADMIN001: "admin@example.com" });
      const turn = plugin();
      await turn.arrive();
      await turn.start();
      expect((await promptResults(turn, run("run-1"))).turnContext).toContain(
        "Fi requester: admin@example.com.",
      );
      expect(resolveMock).toHaveBeenCalledTimes(1);
      expect(mints()).toHaveLength(1);
      await promptResults(turn, run("run-1"));
      expect(resolveMock).toHaveBeenCalledTimes(1);
      expect(mints()).toHaveLength(2);
    });

    it("drops the answer when the run's sender changed while Fi answered", async () => {
      const turn = plugin();
      await turn.arrive();
      await turn.start();
      resolveMock.mockImplementation(async () => {
        await turn.arrive({ senderId: "U0OTHER002" });
        return resolved("admin@example.com");
      });
      expect((await promptResults(turn, run())).turnContext).toContain(UNCONFIRMED);
    });
  });
});
