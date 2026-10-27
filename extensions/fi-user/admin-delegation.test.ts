import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerAdminDelegation } from "./admin-delegation.js";
import {
  installDelegationFixtures,
  BROKER,
  TOKEN,
  AUTHORIZE_URL,
  matrix,
  THREAD,
  thread,
  MINT_URL,
  SLACK_CHANNEL,
  SLACK_THREAD,
  slackThread,
  HELD,
  SANDBOXED,
  plugin,
  fetchMock,
  minted,
  mints,
  mintBody,
} from "./admin-delegation.test-helpers.js";
import type { Rewrite } from "./admin-delegation.test-helpers.js";
import { configFromRuntime } from "./fi-delegation.js";

installDelegationFixtures();

describe("the admin agent's delegated user token", () => {
  describe("native process custody release", () => {
    const cli = {
      params: { command: "/usr/local/bin/cellect platform documents show --tenant fixture" },
    };
    const immutable = {
      ...SANDBOXED,
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            docker: {
              binds: [
                "/fixture/cli:/usr/local/bin/cellect:ro",
                "/fixture/runtime:/repos/fi-runtime:ro",
              ],
            },
          },
        },
      },
    };
    async function reserved() {
      const turn = plugin({}, immutable);
      await turn.arrive();
      await turn.start();
      const result = await turn.exec({ toolCallId: "command-1" }, cli);
      expect(result?.params).toMatchObject({ closeProcessTree: true });
      return turn;
    }
    const unproven = { runId: "other-run" };

    it("releases before token expiry only after exact native cleanup", async () => {
      const turn = await reserved();
      expect(await turn.exec(unproven)).toMatchObject({ block: true });
      await turn.cleanup();
      expect((await turn.exec(unproven))?.block).not.toBe(true);
    });

    it.each([
      { phase: "completed" },
      { phase: "cleanup-failed" },
      { toolCallId: "other-call" },
      { sessionKey: "agent:cellect-fi-admin:other" },
      { agentId: "cellect-main" },
    ])("keeps custody without matching cleanup: %j", async (fields) => {
      const turn = await reserved();
      await turn.cleanup(fields);
      expect(await turn.exec(unproven)).toMatchObject({ block: true });
    });

    it("turn settlement cannot release an unfinished or uncertain command", async () => {
      const turn = await reserved();
      await turn.settle();
      expect(await turn.exec(unproven)).toMatchObject({ block: true });
      await turn.cleanup();
      expect((await turn.exec(unproven))?.block).not.toBe(true);
    });

    it("one cleanup cannot release sibling commands or replay a release", async () => {
      const turn = await reserved();
      await turn.exec({ toolCallId: "command-2" }, cli);
      await turn.cleanup();
      await turn.cleanup();
      expect(await turn.exec(unproven)).toMatchObject({ block: true });
      await turn.cleanup({ toolCallId: "command-2" });
      expect((await turn.exec(unproven))?.block).not.toBe(true);
    });

    it("retains conservative expiry for calls without unique identity", async () => {
      const turn = await reserved();
      await turn.exec();
      await turn.cleanup();
      expect(await turn.exec(unproven)).toMatchObject({ block: true });
    });

    it.each([
      { command: "bash -lc '/usr/local/bin/cellect --help'" },
      { command: "/usr/local/bin/cellect --help; env > /workspace/saved" },
      { command: "/usr/local/bin/cellect $(echo --help)" },
      { command: "/usr/local/bin/cellect --help", env: { NODE_OPTIONS: "--require fixture" } },
      { command: "/usr/local/bin/cellect --help", env: { FI_CLI_NODE: "/workspace/node" } },
    ])("retains expiry custody outside the immutable direct CLI contract: %j", async (params) => {
      const turn = plugin({}, immutable);
      await turn.arrive();
      await turn.start();
      await turn.exec({ toolCallId: "command-1" }, { params });
      await turn.cleanup();
      expect(await turn.exec(unproven)).toMatchObject({ block: true });
    });

    it("does not assume that an unproven runtime mount is immutable", async () => {
      const turn = plugin();
      await turn.arrive();
      await turn.start();
      await turn.exec({ toolCallId: "command-1" }, cli);
      await turn.cleanup();
      expect(await turn.exec(unproven)).toMatchObject({ block: true });
    });

    it("pins a normal bare CLI invocation without depending on PATH", async () => {
      const turn = plugin({}, immutable);
      await turn.arrive();
      await turn.start();
      expect(
        (
          await turn.exec(
            { toolCallId: "command-1" },
            {
              params: { command: "cellect platform documents show --tenant fixture" },
            },
          )
        )?.params,
      ).toMatchObject({ command: cli.params.command, closeProcessTree: true });
      await turn.cleanup();
      expect((await turn.exec(unproven))?.block).not.toBe(true);
    });
  });
  describe("Superadmin requester handoff", () => {
    const main = () => {
      const original = thread();
      const sessionKey = THREAD.replace("agent:cellect-fi-admin:", "agent:cellect-main:");
      return {
        arrive: { ...original.arrive, sessionKey },
        start: {
          ...original.start,
          agentId: "cellect-main",
          sessionKey,
          accountId: "superadminprod",
        },
        exec: {
          ...original.exec,
          agentId: "cellect-main",
          sessionKey,
          requester: { ...original.exec.requester, accountId: "superadminprod" },
        },
      };
    };
    beforeEach(() => {
      vi.stubEnv(
        "FI_THREADS_ENV_BY_ACCOUNT",
        JSON.stringify({ adminprod: "prod", superadminprod: "prod" }),
      );
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url !== AUTHORIZE_URL) {
          return minted();
        }
        if (typeof init?.body !== "string") {
          throw new Error("Expected serialized authorization request");
        }
        const body = JSON.parse(init.body) as { agentId: string };
        return new Response(JSON.stringify({ ok: true, agentId: body.agentId, orgId: "org-a" }));
      });
    });

    it("hands the proven Superadmin requester the same bounded command-class token", async () => {
      const turn = plugin(),
        message = main();
      await turn.arrive(message.arrive);
      await turn.start(message.start);
      expect((await turn.exec(message.exec))?.params).toMatchObject({
        host: "sandbox",
        elevated: false,
        env: { FI_DELEGATED_USER_TOKEN: TOKEN },
      });
      expect(mintBody()).toMatchObject({
        agentId: "cellect-fi-admin",
        requesterMatrixUserId: "@admin:matrix.example",
      });
    });

    it("does not mint for an unproven Superadmin resume", async () => {
      const turn = plugin(),
        message = main();
      await turn.start(message.start);
      expect((await turn.exec(message.exec))?.params.env?.FI_DELEGATED_USER_TOKEN).toBeUndefined();
      expect(mints()).toEqual([]);
    });

    it("does not borrow another agent's admitted session", async () => {
      const turn = plugin(),
        message = thread();
      await turn.arrive(message.arrive);
      await turn.start({ ...message.start, agentId: "cellect-main" });
      expect(
        (await turn.exec({ ...message.exec, agentId: "cellect-main" }))?.params.env
          ?.FI_DELEGATED_USER_TOKEN,
      ).toBeUndefined();
      expect(mints()).toEqual([]);
    });

    it("uses Superadmin's own sandbox posture rather than Fi Admin's", async () => {
      const turn = plugin(
        {},
        {
          ...SANDBOXED,
          agents: {
            ...SANDBOXED.agents,
            entries: { "cellect-main": { sandbox: { mode: "off" } } },
          },
        },
      );
      const message = main();
      await turn.arrive(message.arrive);
      await turn.start(message.start);
      expect((await turn.exec(message.exec))?.params.env?.FI_DELEGATED_USER_TOKEN).toBeUndefined();
      expect(mints()).toEqual([]);
    });

    it("does not share token custody between the two agents", async () => {
      const turn = plugin(),
        first = thread(),
        second = main();
      await turn.arrive(first.arrive);
      await turn.start({ ...first.start, runId: "admin-run" });
      expect(
        (await turn.exec({ ...first.exec, runId: "admin-run" }))?.params.env
          ?.FI_DELEGATED_USER_TOKEN,
      ).toBe(TOKEN);
      const other = "@other:matrix.example";
      await turn.arrive({ ...second.arrive, senderId: other });
      await turn.start({
        ...second.start,
        runId: "main-run",
        senderId: other,
        channelContext: { ...second.start.channelContext, sender: { id: other } },
      });
      const result = await turn.exec({
        ...second.exec,
        runId: "main-run",
        requester: { ...second.exec.requester, senderId: other },
      });
      expect(result?.block).not.toBe(true);
      expect(result?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
    });

    it("does not inject a Superadmin token after the admitted run settles during mint", async () => {
      const turn = plugin(),
        message = main();
      await turn.arrive(message.arrive);
      await turn.start(message.start);
      const original = fetchMock.getMockImplementation();
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === MINT_URL) {
          await turn.settle();
          return minted();
        }
        return await original?.(url, init);
      });
      expect((await turn.exec(message.exec))?.params.env?.FI_DELEGATED_USER_TOKEN).toBeUndefined();
    });
  });

  it("keeps simultaneous Matrix and Slack requester custody independent with session sandboxes", async () => {
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
    const turn = plugin(
      {},
      {
        ...SANDBOXED,
        agents: { defaults: { sandbox: { mode: "all", scope: "session" } } },
      },
    );
    const first = thread();
    await turn.arrive(first.arrive);
    await turn.start(first.start);
    expect((await turn.exec(first.exec))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
    const second = slackThread();
    await turn.arrive(second.arrive);
    await turn.start({ ...second.start, runId: "run-2" });
    expect(
      (await turn.exec({ ...second.exec, runId: "run-2" }))?.params.env?.FI_DELEGATED_USER_TOKEN,
    ).toBe(TOKEN);
    // Neither concurrent dispatch retires or changes the first run's identity.
    expect((await turn.exec(first.exec))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
    await turn.settle("run-2");
    const stale = await turn.exec({ ...second.exec, runId: "run-2" });
    expect(stale?.block).toBe(true);
    expect(stale).toMatchObject({
      blockReason: expect.stringContaining("no verified requester proof"),
    });
  });

  describe("verified Slack channel requests", () => {
    it.each([SLACK_THREAD, "agent:cellect-fi-admin:slack:channel:c0channel1"])(
      "mints only for the dispatched sender and event in %s",
      async (sessionKey) => {
        const turn = plugin(),
          message = slackThread(sessionKey);
        await turn.arrive(message.arrive);
        await turn.start(message.start);
        const result = await turn.exec(message.exec);
        expect(result?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
        expect(result?.params).toMatchObject({ host: "sandbox", elevated: false });
        expect(mintBody()).toMatchObject({ requesterSenderId: "U0ADMIN001" });
      },
    );
    it.each([
      ["unverified sender", { senderAuthentication: "asserted" }, {}],
      ["missing native event", { messageId: undefined }, {}],
      ["non-Slack event", { messageId: "$forged" }, {}],
      ["unclassified group", { isGroup: undefined }, {}],
      ["another channel", {}, { chat: { id: "C0OTHER001", eventId: "1792190933.152459" } }],
      ["another event", {}, { chat: { id: SLACK_CHANNEL, eventId: "1792190932.152459" } }],
      ["another sender", {}, { sender: { id: "U0OTHER002" } }],
      ["bot sender", {}, { sender: { id: "U0ADMIN001", isBot: true } }],
    ])("does not mint for %s", async (_name, arrival, origin) => {
      const turn = plugin(),
        message = slackThread();
      await turn.arrive({ ...message.arrive, ...arrival });
      await turn.start({
        ...message.start,
        channelContext: { ...message.start.channelContext, ...origin },
      });
      expect(JSON.stringify(await turn.exec(message.exec))).not.toContain(TOKEN);
      expect(mints()).toEqual([]);
    });
    it("does not authorize a synthetic resume from stored sender/event context", async () => {
      const turn = plugin(),
        message = slackThread();
      await turn.start(message.start);
      expect(JSON.stringify(await turn.exec(message.exec))).not.toContain(TOKEN);
      await turn.inject(message.arrive);
      await turn.settle();
      await turn.start({ ...message.start, runId: "run-2" });
      expect(JSON.stringify(await turn.exec({ ...message.exec, runId: "run-2" }))).not.toContain(
        TOKEN,
      );
      expect(mints()).toEqual([]);
    });
    it("revokes the running sender proof when another user steers the thread", async () => {
      const turn = plugin(),
        message = slackThread();
      await turn.arrive(message.arrive);
      await turn.start(message.start);
      await turn.inject({ ...message.arrive, senderId: "U0OTHER002" });
      expect(JSON.stringify(await turn.exec(message.exec))).not.toContain(TOKEN);
      expect(mints()).toEqual([]);
    });
    it("never carries a token into a subsequent run without a new dispatched message", async () => {
      const turn = plugin(),
        message = slackThread();
      await turn.arrive(message.arrive);
      await turn.start(message.start);
      expect((await turn.exec(message.exec))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
      await turn.settle();
      await turn.start({ ...message.start, runId: "run-2" });
      expect(JSON.stringify(await turn.exec({ ...message.exec, runId: "run-2" }))).not.toContain(
        TOKEN,
      );
      expect(mints()).toHaveLength(1);
    });
  });
  it("gives a verified requester's exec their own token", async () => {
    const turn = plugin();
    await turn.arrive();
    await turn.start();
    const result = await turn.exec(
      {},
      {
        params: {
          command: "npm run fi:audit --as U0SOMEONE9",
          env: { KEEP: "1", fi_delegated_user_token: "forged", REQUESTER: "U0SOMEONE9" },
        },
      },
    );
    // The host is told where to run it, whatever its configured default or elevated level.
    expect(result?.params).toMatchObject({ host: "sandbox", elevated: false });
    // The issued credential replaces the sandbox's inherited Fi origin as one pair.
    expect(result?.params.env).toEqual({
      KEEP: "1",
      REQUESTER: "U0SOMEONE9",
      FI_ON_BEHALF_OF: expect.any(String),
      FI_DELEGATED_USER_TOKEN: TOKEN,
      FI_APP_URL: "https://fi.example.test/fi",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      MINT_URL,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: `Bearer ${BROKER}` }),
      }),
    );
    // The host's sender, never the tool input; exactly one requester form.
    expect(mintBody()).toEqual({ requesterSenderId: "U0ADMIN001", agentId: "cellect-fi-admin" });
  });

  it("mints a shared-mail wake as the Slack member the hook named", async () => {
    const turn = plugin();
    const sessionKey = "agent:cellect-fi-admin:hook:fi-mail:abc";
    await turn.start({ sessionKey, channel: "last", trigger: "cron", senderId: "U0ADMIN001" });
    const result = await turn.exec({
      sessionKey,
      requester: { channel: "last", senderId: "U0ADMIN001" },
    });
    expect(result?.params.env).toMatchObject({ FI_DELEGATED_USER_TOKEN: TOKEN });
    expect(mintBody()).toEqual({ requesterSenderId: "U0ADMIN001", agentId: "cellect-fi-admin" });
  });

  it("mints a shared-mail wake as the member mailbox when no Slack id is bound", async () => {
    const turn = plugin();
    const sessionKey = "agent:cellect-fi-admin:hook:fi-mail:abc";
    await turn.start({
      sessionKey,
      channel: "last",
      trigger: "cron",
      senderId: "alex@cellect.ai",
    });
    const result = await turn.exec({
      sessionKey,
      requester: { channel: "last", senderId: "alex@cellect.ai" },
    });
    expect(mintBody()).toEqual({ requesterEmail: "alex@cellect.ai", agentId: "cellect-fi-admin" });
    expect(result?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
  });

  it("does not mint an ordinary cron turn that carries an email sender", async () => {
    const turn = plugin();
    const sessionKey = "agent:cellect-fi-admin:cron:job";
    await turn.start({
      sessionKey,
      channel: "last",
      trigger: "cron",
      senderId: "alex@cellect.ai",
    });
    const result = await turn.exec({
      sessionKey,
      requester: { channel: "last", senderId: "alex@cellect.ai" },
    });
    expect(mints()).toHaveLength(0);
    expect(result?.params.env?.FI_DELEGATED_USER_TOKEN).toBeUndefined();
  });

  it("withholds the token from a call that names another Fi, and leaves its env alone", async () => {
    const turn = plugin();
    await turn.arrive();
    await turn.start();
    const same = await turn.exec(
      {},
      { params: { command: "x", env: { Fi_App_Url: "https://fi.example.test/fi//" } } },
    );
    expect(same?.params.env).toEqual({
      FI_APP_URL: "https://fi.example.test/fi",
      FI_ON_BEHALF_OF: expect.any(String),
      FI_DELEGATED_USER_TOKEN: TOKEN,
    });
    fetchMock.mockClear();
    for (const url of ["https://evil.test", "https://fi.example.test", 7]) {
      const other = await turn.exec(
        {},
        { params: { command: "x", env: { FI_APP_URL: url, FI_DELEGATED_USER_TOKEN: "forged" } } },
      );
      expect(other?.params.env).toEqual({ FI_APP_URL: url, FI_ON_BEHALF_OF: expect.any(String) });
      expect(other?.params).not.toHaveProperty("host");
      expect(other?.params).not.toHaveProperty("elevated");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("covers sandbox_exec and asks Fi afresh for every call", async () => {
    const turn = plugin();
    await turn.arrive();
    await turn.start();
    fetchMock.mockImplementationOnce(async () => minted({ token: "first.fixture.token" }));
    const first = await turn.exec({ toolName: "sandbox_exec" }, { toolName: "sandbox_exec" });
    const second = await turn.exec({}, { params: { command: "x", host: "sandbox" } });
    expect(first?.params.env?.FI_DELEGATED_USER_TOKEN).toBe("first.fixture.token");
    expect(second?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses this runtime's own admin agent id with Fi's protocol name", async () => {
    const session = "agent:tenant-admin:slack:direct:u0admin001";
    const turn = plugin({ adminAgentId: "tenant-admin" });
    await turn.arrive({ sessionKey: session });
    await turn.start({ agentId: "tenant-admin", sessionKey: session });
    // The host and the config may spell the agent id in different case.
    const result = await turn.exec({
      agentId: "Tenant-Admin",
      sessionKey: "agent:Tenant-Admin:slack:direct:U0ADMIN001",
    });
    // No legacy assertion for an agent Fi's on-behalf-of does not know; the token alone.
    expect(result?.params.env).toEqual({
      FI_DELEGATED_USER_TOKEN: TOKEN,
      FI_APP_URL: "https://fi.example.test/fi",
    });
    expect(mintBody().agentId).toBe("cellect-fi-admin");
    // The default admin agent is no longer this runtime's admin tier.
    fetchMock.mockClear();
    await turn.arrive();
    await turn.start();
    expect((await turn.exec())?.params.env).not.toHaveProperty("FI_DELEGATED_USER_TOKEN");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mints for a verified Matrix direct message, at the account's own Fi", async () => {
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
    const turn = plugin();
    await turn.arrive(matrix.arrive);
    await turn.start(matrix.start);
    const result = await turn.exec(matrix.exec);
    expect(result?.params).toMatchObject({
      host: "sandbox",
      elevated: false,
      env: { FI_DELEGATED_USER_TOKEN: TOKEN },
    });
    expect(mintBody()).toEqual({
      requesterMatrixUserId: "@admin:matrix.example",
      agentId: "cellect-fi-admin",
    });
  });

  describe("a Matrix room or thread, one message at a time", () => {
    const OTHER = "@other:matrix.example";
    const token = (result: Rewrite) => result?.params?.env?.FI_DELEGATED_USER_TOKEN;
    /** Fi answers for the person asked about: only the admin is one. */
    const fiKnowsOnlyTheAdmin = () =>
      fetchMock.mockImplementation(async (url: string, init: { body: string }) => {
        if (url === AUTHORIZE_URL) {
          return new Response(
            JSON.stringify({ ok: true, agentId: "cellect-fi-admin", orgId: "org-a" }),
          );
        }
        const asked = JSON.parse(init.body) as { requesterMatrixUserId?: string };
        return asked.requesterMatrixUserId === "@admin:matrix.example"
          ? minted()
          : new Response("Not found", { status: 404 });
      });
    beforeEach(() => {
      vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
    });

    it.each(["!room:matrix.example", "!room:matrix.example:thread:$root"])(
      "mints for a verified admin thread with host chat id %s, pinned to the sandbox",
      async (chatId) => {
        const turn = plugin();
        const message = thread();
        await turn.arrive(message.arrive);
        expect(await turn.start({ ...message.start, chatId })).toBeUndefined();
        const result = await turn.exec(message.exec);
        expect(result?.params).toMatchObject({
          host: "sandbox",
          elevated: false,
          env: { FI_DELEGATED_USER_TOKEN: TOKEN },
        });
        expect(mintBody()).toEqual({
          requesterMatrixUserId: "@admin:matrix.example",
          agentId: "cellect-fi-admin",
        });
      },
    );

    it.each(["Matrix", "Slack"])(
      "keeps queued same-sender %s events bound to their own runs",
      async (channel) => {
        vi.useFakeTimers();
        try {
          const turn = plugin();
          const first = channel === "Matrix" ? thread() : slackThread();
          const eventId = channel === "Matrix" ? "$e2" : "1792190934.152459";
          const second = {
            arrive: { ...first.arrive, messageId: eventId },
            start: {
              ...first.start,
              channelContext: {
                ...first.start.channelContext,
                chat: { ...first.start.channelContext.chat, eventId },
              },
            },
            exec: first.exec,
          };
          await turn.arrive(first.arrive);
          await turn.arrive(second.arrive);
          await turn.start(first.start);
          expect(token(await turn.exec(first.exec))).toBe(TOKEN);
          await turn.settle("run-1");
          await turn.start({ ...second.start, runId: "heartbeat", trigger: "heartbeat" });
          expect(token(await turn.exec({ ...second.exec, runId: "heartbeat" }))).toBeUndefined();
          expect(mints()).toHaveLength(1);
          await turn.start({ ...second.start, runId: "run-2" });
          expect(token(await turn.exec({ ...second.exec, runId: "run-2" }))).toBe(TOKEN);
          await turn.settle("run-2");
          // Expire command custody so refusal proves event consumption, not a held sandbox.
          vi.advanceTimersByTime(10 * 60 * 1000 + 1);
          await turn.start({ ...first.start, runId: "replayed-event" });
          expect(
            token(await turn.exec({ ...first.exec, runId: "replayed-event" })),
          ).toBeUndefined();
          expect(mints()).toHaveLength(2);
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it.each([undefined, OTHER])(
      "refuses retained queued proof after an input from %s",
      async (senderId) => {
        const turn = plugin();
        const first = thread();
        const second = thread("@admin:matrix.example", "$e2");
        await turn.arrive(first.arrive);
        await turn.arrive(second.arrive);
        await turn.start(first.start);
        await turn.inject({ channel: "matrix", sessionKey: THREAD, senderId });
        await turn.start({ ...second.start, runId: "run-2" });
        expect(token(await turn.exec({ ...second.exec, runId: "run-2" }))).toBeUndefined();
        expect(mints()).toEqual([]);
      },
    );

    it("does not preserve ambiguous queued native senders", async () => {
      const turn = plugin();
      const first = thread();
      const second = thread(OTHER, "$e2");
      await turn.arrive(first.arrive);
      await turn.arrive(second.arrive);
      await turn.start(first.start);
      expect(token(await turn.exec(first.exec))).toBeUndefined();
      await turn.start({ ...second.start, runId: "run-2" });
      expect(token(await turn.exec({ ...second.exec, runId: "run-2" }))).toBeUndefined();
      expect(mints()).toEqual([]);
    });

    it("gives the next run in the thread nothing of the first", async () => {
      vi.useFakeTimers();
      try {
        fiKnowsOnlyTheAdmin();
        const turn = plugin();
        const first = thread();
        await turn.arrive(first.arrive);
        await turn.start(first.start);
        expect(token(await turn.exec(first.exec))).toBe(TOKEN);
        await turn.settle();

        // Someone else, equally verified by the homeserver, writes next. The
        // sandbox still holds the admin's token, so their commands wait.
        const second = thread(OTHER, "$e2");
        await turn.arrive(second.arrive);
        await turn.start({ ...second.start, runId: "run-2" });
        fetchMock.mockClear();
        expect(await turn.exec({ ...second.exec, runId: "run-2" })).toEqual({
          block: true,
          blockReason: HELD,
        });
        // Neither the admin's name on their run nor the admin's settled run gets further.
        for (const stale of [
          { ...first.exec, runId: "run-2" },
          { ...first.exec, runId: "run-1" },
          { ...second.exec, runId: "run-1" },
        ]) {
          const result = await turn.exec(stale);
          expect(result?.block).toBe(true);
          expect(JSON.stringify(result)).not.toContain(TOKEN);
        }
        expect(mints()).toEqual([]);

        // Once the admin's token has expired they are asked about on their own, and refused.
        vi.advanceTimersByTime(10 * 60 * 1000 + 1);
        const theirs = await turn.exec({ ...second.exec, runId: "run-2" });
        expect(theirs?.params.env).toEqual({ FI_ON_BEHALF_OF: expect.any(String) });
        expect(theirs?.params).not.toHaveProperty("host");
        expect(mints()).toHaveLength(1);
        expect(mintBody().requesterMatrixUserId).toBe(OTHER);

        // The admin's own next message is a new run with a new token.
        await turn.settle("run-2");
        const third = thread("@admin:matrix.example", "$e3");
        await turn.arrive(third.arrive);
        await turn.start({ ...third.start, runId: "run-3" });
        expect(token(await turn.exec({ ...third.exec, runId: "run-3" }))).toBe(TOKEN);
      } finally {
        vi.useRealTimers();
      }
    });

    it("requires the run's own sender to be the one the message proved", async () => {
      // The Matrix admission gate refuses such a run first; this is the token rule alone.
      const admit = async (runSender: string) => {
        let onRun!: (event: unknown, context: unknown) => unknown;
        const api = createTestPluginApi({
          config: {
            ...SANDBOXED,
            plugins: {
              entries: {
                "fi-user": {
                  config: {
                    baseUrl: "https://fi.example.test/fi/",
                    brokerTokenEnv: "FIXTURE_BROKER",
                    tenantOrgId: "org-a",
                  },
                },
              },
            },
          },
          on: (_name, handler) => (onRun = handler as typeof onRun),
        });
        const delegation = registerAdminDelegation(api);
        const message = thread();
        delegation.dispatched({ ...message.arrive, senderAuthentication: "verified" as const });
        await onRun(
          {},
          {
            ...message.start,
            runId: "run-1",
            agentId: "cellect-fi-admin",
            trigger: "user",
            channelContext: {
              sender: { id: runSender },
              chat: { id: "!room:matrix.example", eventId: "$e1" },
            },
          },
        );
        return delegation.mint(
          configFromRuntime(api),
          { toolName: "exec", params: { command: "npm run fi:audit" } },
          { ...message.exec, runId: "run-1", agentId: "cellect-fi-admin", toolName: "exec" },
          Date.now(),
        );
      };
      expect(await admit(OTHER)).toBeUndefined();
      expect(mints()).toEqual([]);
      expect(await admit("@admin:matrix.example")).toEqual({
        token: TOKEN,
        baseUrl: "https://fi.example.test/fi",
      });
    });

    it("ends the admin's run when someone else writes into the thread", async () => {
      const turn = plugin();
      const message = thread();
      await turn.arrive(message.arrive);
      await turn.start(message.start);
      await turn.arrive(thread(OTHER, "$e2").arrive);
      expect(token(await turn.exec(message.exec))).toBeUndefined();
      expect(mints()).toEqual([]);
    });

    it.each([
      ["nobody verified", { senderAuthentication: undefined }],
      ["another party named", { senderAuthentication: "asserted" }],
    ])("gives nothing for a sender %s", async (_name, arrival) => {
      const turn = plugin();
      const message = thread();
      await turn.arrive({ ...message.arrive, ...arrival });
      await turn.start(message.start);
      expect(token(await turn.exec(message.exec))).toBeUndefined();
      expect(mints()).toEqual([]);
    });

    const origin = (sender: Record<string, unknown>, eventId: string) => ({
      channelContext: {
        sender: { id: "@admin:matrix.example", ...sender },
        chat: { id: "!room:matrix.example", eventId },
      },
    });
    it.each([
      ["a cron run", { trigger: "cron" }],
      ["a heartbeat", { trigger: "heartbeat" }],
      ["a system event", { trigger: "system" }],
      ["a run the host started for another event", origin({}, "$e0")],
      ["a run a configured bot account started", origin({ isBot: true }, "$e1")],
    ])("gives nothing to %s, even after the admin's message", async (_name, run) => {
      const turn = plugin();
      const message = thread();
      await turn.arrive(message.arrive);
      await turn.start({ ...message.start, ...run });
      expect(token(await turn.exec(message.exec))).toBeUndefined();
      expect(mints()).toEqual([]);
    });

    it("gives nothing to a run no message started: resumed, tool-injected, agent-to-agent", async () => {
      const turn = plugin();
      const message = thread();
      // The host stamps a stored sender and event on such a run; nothing arrived for it.
      await turn.start(message.start);
      expect(token(await turn.exec(message.exec))).toBeUndefined();
      // Nor does input injected without a dispatch prove anyone.
      await turn.settle();
      await turn.inject(message.arrive);
      await turn.start({ ...message.start, runId: "run-2" });
      expect(token(await turn.exec({ ...message.exec, runId: "run-2" }))).toBeUndefined();
      expect(mints()).toEqual([]);
    });

    it.each([403, 404])(
      "treats Fi's refusal (%i) as no token and says only that",
      async (status) => {
        fetchMock.mockImplementation(async (url: string) =>
          url === AUTHORIZE_URL
            ? new Response(
                JSON.stringify({ ok: true, agentId: "cellect-fi-admin", orgId: "org-a" }),
              )
            : new Response(`@admin:matrix.example is not an admin of org-a`, { status }),
        );
        const turn = plugin();
        const message = thread();
        await turn.arrive(message.arrive);
        await turn.start(message.start);
        const result = await turn.exec(message.exec);
        // The command still runs, with the attribution it always had.
        expect(result?.params.env).toEqual({ FI_ON_BEHALF_OF: expect.any(String) });
        expect(result?.params).not.toHaveProperty("host");
        expect(mints()).toHaveLength(1);
        // "Not a member" is an ordinary answer; any other refusal is logged by status alone.
        expect(turn.warn.mock.calls).toEqual(
          status === 404 ? [] : [[`fi-user: admin delegation not issued (status ${status})`]],
        );
      },
    );

    it("gives nothing in a room Fi places in another organization", async () => {
      fetchMock.mockImplementation(async (url: string) =>
        url === AUTHORIZE_URL
          ? new Response(JSON.stringify({ ok: true, agentId: "cellect-fi-admin", orgId: "org-b" }))
          : minted(),
      );
      const turn = plugin();
      const message = thread();
      await turn.arrive(message.arrive);
      await turn.start(message.start);
      const result = await turn.exec(message.exec);
      expect(result).toMatchObject({ block: true });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(mints()).toEqual([]);
    });

    it.each([
      ["a Slack channel", "slack", "agent:cellect-fi-admin:slack:channel:c1", "U0ADMIN001"],
      [
        "a Slack thread",
        "slack",
        "agent:cellect-fi-admin:slack:channel:c1:thread:1.2",
        "U0ADMIN001",
      ],
      ["a Discord channel", "discord", "agent:cellect-fi-admin:discord:channel:1", "1234567890"],
    ])("does not extend to %s", async (_name, channel, sessionKey, senderId) => {
      const turn = plugin();
      await turn.arrive({ channel, sessionKey, senderId, isGroup: true, messageId: "$e1" });
      await turn.start({
        channel,
        sessionKey,
        senderId,
        channelContext: { sender: { id: senderId }, chat: { eventId: "$e1" } },
      });
      const result = await turn.exec({ sessionKey, requester: { channel, senderId } });
      expect(JSON.stringify(result ?? {})).not.toContain(TOKEN);
      expect(mints()).toEqual([]);
    });
  });
});
