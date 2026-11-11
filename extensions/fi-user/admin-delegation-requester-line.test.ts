import { describe, expect, it } from "vitest";
import {
  installDelegationFixtures,
  fetchMock,
  minted,
  mints,
  MINT_URL,
  plugin,
  SESSION,
  SLACK_CHANNEL,
  slackThread,
  TOKEN,
} from "./admin-delegation.test-helpers.js";

installDelegationFixtures();

type Turn = ReturnType<typeof plugin>;

/** Every before_prompt_build handler, as the host composes them: appended system context. */
async function systemContext(turn: Turn, context: Record<string, unknown>): Promise<string> {
  const parts: string[] = [];
  for (const handler of turn.registrations.hooks.get("before_prompt_build") ?? []) {
    const result = (await handler({ prompt: "x", messages: [] } as never, context as never)) as
      | { appendSystemContext?: string }
      | undefined;
    if (result?.appendSystemContext) {
      parts.push(result.appendSystemContext);
    }
  }
  return parts.join("\n");
}

const slackRun = (runId = "run-1", senderId = "U0ADMIN001", sessionKey = SESSION) => ({
  runId,
  agentId: "cellect-fi-admin",
  sessionKey,
  channel: "slack",
  senderId,
  trigger: "user",
});

/** Fi's mint, answering each sender with that sender's own member email. */
function mintPerSender(emails: Record<string, string | undefined>, withRequester = true) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url !== MINT_URL) {
      return new Response("{}");
    }
    const body = JSON.parse(String(init?.body)) as { requesterSenderId?: string };
    const email = emails[body.requesterSenderId ?? ""];
    if (!email) {
      return new Response("not linked", { status: 404 });
    }
    const response = minted({}, { email });
    if (!withRequester) {
      return response;
    }
    const json = (await response.json()) as Record<string, unknown>;
    return new Response(JSON.stringify({ ...json, requester: { channel: "slack", email } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("the admin turn's Fi requester line", () => {
  it("states the email Fi resolved for this run's proven sender, in system context", async () => {
    mintPerSender({ U0ADMIN001: "admin@example.com" });
    const turn = plugin();
    await turn.arrive();
    await turn.start();
    const context = await systemContext(turn, slackRun());
    expect(context).toContain(
      "Fi requester: admin@example.com. This turn acts as that member. Pass --actor admin@example.com on every Fi command.",
    );
    expect(context).not.toContain(TOKEN);
    expect(mints()).toHaveLength(1);
    expect(JSON.parse(String((mints()[0]![1] as RequestInit).body))).toEqual({
      requesterSenderId: "U0ADMIN001",
      agentId: "cellect-fi-admin",
    });
  });

  it("adds no line when Fi's answer carries no requester email (older Fi)", async () => {
    mintPerSender({ U0ADMIN001: "admin@example.com" }, false);
    const turn = plugin();
    await turn.arrive();
    await turn.start();
    expect(await systemContext(turn, slackRun())).not.toContain("Fi requester:");
  });

  it("adds no line when the mint fails", async () => {
    mintPerSender({});
    const turn = plugin();
    await turn.arrive();
    await turn.start();
    expect(await systemContext(turn, slackRun())).not.toContain("Fi requester:");
  });

  it("asks Fi nothing for a run whose sender is not proven", async () => {
    mintPerSender({ U0ADMIN001: "admin@example.com" });
    const turn = plugin();
    await turn.arrive();
    await turn.arrive({ senderId: "U0OTHER002" });
    await turn.start();
    expect(await systemContext(turn, slackRun())).not.toContain("Fi requester:");
    expect(mints()).toHaveLength(0);
  });

  it("never lets one sender's email reach another sender's turn in a shared thread", async () => {
    mintPerSender({ U0ADMIN001: "admin@example.com", U0OTHER002: "other@example.com" });
    const turn = plugin();
    const first = slackThread();
    await turn.arrive(first.arrive);
    await turn.start(first.start);
    const firstContext = await systemContext(
      turn,
      slackRun("run-1", "U0ADMIN001", first.start.sessionKey),
    );
    expect(firstContext).toContain("Fi requester: admin@example.com.");

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
    const second = await systemContext(turn, slackRun("run-2", senderId, first.start.sessionKey));
    expect(second).toContain("Fi requester: other@example.com.");
    expect(second).not.toContain("admin@example.com");
    // The first run is no longer proven once someone else wrote: it gets no line again.
    expect(
      await systemContext(turn, slackRun("run-1", "U0ADMIN001", first.start.sessionKey)),
    ).not.toContain("Fi requester:");
    // One mint per proven run; nothing reused across senders.
    expect(mints()).toHaveLength(2);
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
    expect(await systemContext(turn, slackRun())).not.toContain("Fi requester:");
  });
});
