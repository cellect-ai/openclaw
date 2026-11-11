import { readFileSync } from "node:fs";
import { sanitizeToolArgs } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminActionSessions } from "./admin-action.js";
import { INJECTED_NOTICE } from "./admin-delegation.js";
import {
  installDelegationFixtures,
  TOKEN,
  AUTHORIZE_URL,
  matrix,
  THREAD,
  thread,
  MINT_URL,
  HELD,
  UNPROVEN_HOLD,
  SANDBOXED,
  SLACK_CHANNEL,
  SLACK_THREAD,
  slackThread,
  plugin,
  fetchMock,
  minted,
  mints,
  mintBody,
  sendText,
} from "./admin-delegation.test-helpers.js";

installDelegationFixtures();

describe("the admin agent's delegated user token", () => {
  describe("a verified Matrix-bound voice consult", () => {
    const voice = () => ({
      ...thread().start,
      channelContext: {
        sender: { id: "@admin:matrix.example" },
        chat: { id: "!room:matrix.example", talkThreadRootEventId: "$root" },
      },
    });
    /**
     * The consult's own dispatch, as the Gateway makes it: a trusted internal
     * chat.send into the thread session that fires message_received and
     * before_dispatch with the attested speaker, no channel authentication and
     * no room event, and the host-owned Talk channel context.
     */
    const consultDispatch = (speaker = "@admin:matrix.example") => ({
      channel: "matrix",
      sessionKey: THREAD,
      senderId: speaker,
      senderAuthentication: undefined,
      isGroup: undefined,
      messageId: undefined,
      channelContext: {
        sender: { id: speaker },
        chat: { id: "!room:matrix.example", talkThreadRootEventId: "$root" },
      },
    });
    beforeEach(() => {
      vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
    });

    it("mints for the admitted speaker from its own dispatch, then admits that speaker's later text", async () => {
      const turn = plugin();
      await turn.arrive(consultDispatch());
      expect(await turn.start(voice())).toBeUndefined();
      expect((await turn.exec(thread().exec))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
      expect(mintBody()).toMatchObject({ requesterMatrixUserId: "@admin:matrix.example" });
      await turn.settle();
      // The voice token still holds the sandbox: a typed run that was not
      // admitted would be refused here, not merely run without a token.
      const text = thread("@admin:matrix.example", "$later");
      await turn.arrive(text.arrive);
      await turn.start({ ...text.start, runId: "text-after-voice" });
      expect(
        (await turn.exec({ ...text.exec, runId: "text-after-voice" }))?.params.env
          ?.FI_DELEGATED_USER_TOKEN,
      ).toBe(TOKEN);
    });

    it("still counts another speaker's consult against a typed turn", async () => {
      const turn = plugin();
      await turn.arrive(consultDispatch("@other:matrix.example"));
      await turn.start({
        ...voice(),
        senderId: "@other:matrix.example",
        channelContext: {
          sender: { id: "@other:matrix.example" },
          chat: { id: "!room:matrix.example", talkThreadRootEventId: "$root" },
        },
      });
      await turn.settle();
      const text = thread("@admin:matrix.example", "$later");
      await turn.arrive(text.arrive);
      await turn.start({ ...text.start, runId: "text-after-voice" });
      expect(
        JSON.stringify(await turn.exec({ ...text.exec, runId: "text-after-voice" })),
      ).not.toContain(TOKEN);
    });

    it.each([
      ["no Talk context", { channelContext: undefined }],
      [
        "a speaker other than the sender",
        {
          channelContext: {
            sender: { id: "@other:matrix.example" },
            chat: { id: "!room:matrix.example", talkThreadRootEventId: "$root" },
          },
        },
      ],
      [
        "another thread",
        {
          channelContext: {
            sender: { id: "@admin:matrix.example" },
            chat: { id: "!room:matrix.example", talkThreadRootEventId: "$other" },
          },
        },
      ],
    ])("counts an unverified dispatch with %s as someone unknown", async (_name, overrides) => {
      const turn = plugin();
      await turn.arrive({ ...consultDispatch(), ...overrides });
      const text = thread("@admin:matrix.example", "$later");
      await turn.arrive(text.arrive);
      await turn.start({ ...text.start, runId: "text-after-dispatch" });
      expect(
        JSON.stringify(await turn.exec({ ...text.exec, runId: "text-after-dispatch" })),
      ).not.toContain(TOKEN);
      expect(mints()).toHaveLength(0);
    });

    it.each([
      [
        "sender",
        {
          requester: {
            channel: "matrix",
            senderId: "@other:matrix.example",
            accountId: "adminprod",
          },
        },
      ],
      [
        "account",
        {
          requester: {
            channel: "matrix",
            senderId: "@admin:matrix.example",
            accountId: "admindev",
          },
        },
      ],
      ["run", { runId: "different-run" }],
      ["session", { sessionKey: THREAD + ":other" }],
      ["aborted call", { abortSignal: AbortSignal.abort() }],
    ])("does not reuse voice proof for another %s", async (_name, overrides) => {
      const turn = plugin();
      await turn.start(voice());
      const result = await turn.exec({ ...thread().exec, ...overrides });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(mints()).toHaveLength(0);
    });

    it.each([
      [
        "text event mixed with voice",
        { chat: { id: "!room:matrix.example", eventId: "$event", talkThreadRootEventId: "$root" } },
      ],
      ["another thread", { chat: { id: "!room:matrix.example", talkThreadRootEventId: "$other" } }],
      [
        "another speaker",
        {
          sender: { id: "@other:matrix.example" },
          chat: { id: "!room:matrix.example", talkThreadRootEventId: "$root" },
        },
      ],
    ])("does not mint with %s", async (_name, channelContext) => {
      const turn = plugin();
      await turn.start({ ...voice(), channelContext });
      expect(JSON.stringify(await turn.exec(thread().exec))).not.toContain(TOKEN);
      expect(mints()).toHaveLength(0);
    });

    it("requires current Fi grants even after successful voice admission", async () => {
      const turn = plugin();
      await turn.start(voice());
      fetchMock.mockResolvedValue(new Response("Forbidden", { status: 403 }));
      expect((await turn.exec(thread().exec))?.block).toBe(true);
      expect(mints()).toHaveLength(0);
    });

    it("does not delegate from pending or denied initial voice authorization", async () => {
      let answer!: (response: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        answer = resolve;
      });
      fetchMock.mockImplementationOnce(() => pending);
      const turn = plugin();
      const start = turn.start(voice());
      expect(JSON.stringify(await turn.exec(thread().exec))).not.toContain(TOKEN);
      expect(mints()).toHaveLength(0);
      answer(new Response("Forbidden", { status: 403 }));
      expect(await start).toMatchObject({ handled: true });
      expect(JSON.stringify(await turn.exec(thread().exec))).not.toContain(TOKEN);
      expect(mints()).toHaveLength(0);
    });

    it("drops a pending mint when another speaker starts a voice run", async () => {
      const turn = plugin();
      await turn.start(voice());
      fetchMock.mockImplementation(async (url: string) => {
        if (url === MINT_URL) {
          await turn.start({
            ...voice(),
            runId: "other-voice",
            senderId: "@other:matrix.example",
            channelContext: {
              sender: { id: "@other:matrix.example" },
              chat: { id: "!room:matrix.example", talkThreadRootEventId: "$root" },
            },
          });
        }
        return url === AUTHORIZE_URL
          ? new Response(JSON.stringify({ ok: true, agentId: "cellect-fi-admin", orgId: "org-a" }))
          : minted();
      });
      expect(JSON.stringify(await turn.exec(thread().exec))).not.toContain(TOKEN);
      expect(mints()).toHaveLength(1);
    });

    it("drops the voice proof if its run settles while the token is being minted", async () => {
      const turn = plugin();
      await turn.start(voice());
      fetchMock.mockImplementation(async (url: string) => {
        if (url === MINT_URL) {
          await turn.settle();
        }
        return url === AUTHORIZE_URL
          ? new Response(JSON.stringify({ ok: true, agentId: "cellect-fi-admin", orgId: "org-a" }))
          : minted();
      });
      expect(JSON.stringify(await turn.exec(thread().exec))).not.toContain(TOKEN);
      expect(mints()).toHaveLength(1);
    });

    it("does not consume queued text proof", async () => {
      const turn = plugin();
      const text = thread("@admin:matrix.example", "$queued");
      await turn.arrive(text.arrive);
      await turn.start(voice());
      await turn.settle();
      await turn.start({ ...text.start, runId: "queued-text" });
      expect(
        (await turn.exec({ ...text.exec, runId: "queued-text" }))?.params.env
          ?.FI_DELEGATED_USER_TOKEN,
      ).toBe(TOKEN);
    });

    it("invalidates voice after foreign steering", async () => {
      const turn = plugin();
      const text = thread("@admin:matrix.example", "$queued");
      await turn.arrive(text.arrive);
      await turn.start(voice());
      await turn.inject({ ...thread("@other:matrix.example").arrive });
      expect(JSON.stringify(await turn.exec(thread().exec))).not.toContain(TOKEN);
      await turn.settle();
      // Fresh text must stand on its own event, not on the prior voice identity.
      await turn.arrive(text.arrive);
      await turn.start({ ...text.start, runId: "text-2" });
      expect(JSON.stringify(await turn.exec({ ...text.exec, runId: "text-2" }))).not.toContain(
        TOKEN,
      );
    });
  });

  it("admits a Matrix direct message only for the run of that very event", async () => {
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
    const turn = plugin();
    await turn.arrive(matrix.arrive);
    await turn.start({
      ...matrix.start,
      channelContext: {
        sender: { id: "@admin:matrix.example" },
        chat: { id: "!dm:matrix.example", eventId: "$another" },
      },
    });
    expect((await turn.exec(matrix.exec))?.params.env).not.toHaveProperty(
      "FI_DELEGATED_USER_TOKEN",
    );
    expect(mints()).toEqual([]);
  });

  describe("a runtime where the sandbox pin would change how commands run", () => {
    const admin = (entry: Record<string, unknown>) => ({
      ...SANDBOXED,
      agents: { ...SANDBOXED.agents, entries: { "cellect-fi-admin": { ...entry } } },
    });
    it.each([
      ["no sandbox configured", { tools: SANDBOXED.tools }],
      [
        "only non-main sessions sandboxed",
        { ...SANDBOXED, agents: { defaults: { sandbox: { mode: "non-main" } } } },
      ],
      ["the admin agent's own sandbox off", admin({ sandbox: { mode: "off" } })],
      [
        "commands on the Gateway",
        { ...SANDBOXED, tools: { ...SANDBOXED.tools, exec: { host: "gateway" } } },
      ],
      ["the admin agent's commands on a node", admin({ tools: { exec: { host: "node" } } })],
      ["elevation left at its default", { agents: SANDBOXED.agents }],
      ["elevation switched on", { ...SANDBOXED, tools: { elevated: { enabled: true } } }],
      ["Talk owned by the admin agent", { ...SANDBOXED, talk: { agentId: "Cellect-Fi-Admin" } }],
      [
        "one sandbox shared by every agent",
        { ...SANDBOXED, agents: { defaults: { sandbox: { mode: "all", scope: "shared" } } } },
      ],
    ])("issues nothing and pins nothing with %s", async (_name, host) => {
      const turn = plugin({}, host);
      await turn.arrive();
      await turn.start();
      const result = await turn.exec({}, { params: { command: "npm run fi:audit" } });
      // Exactly what the command got before there was a token.
      expect(result?.params).toEqual({
        command: "npm run fi:audit",
        env: { FI_ON_BEHALF_OF: expect.any(String) },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      [
        "the sandbox named as the exec host",
        { ...SANDBOXED, tools: { ...SANDBOXED.tools, exec: { host: "sandbox" } } },
      ],
      [
        "the admin agent's own settings over looser defaults",
        {
          agents: {
            defaults: { sandbox: { mode: "off" } },
            entries: {
              "cellect-fi-admin": {
                sandbox: { ...SANDBOXED.agents.defaults.sandbox, scope: "session" },
                tools: { exec: { host: "auto" }, elevated: { enabled: false } },
              },
            },
          },
          tools: { exec: { host: "gateway" } },
          talk: { agentId: "cellect-main" },
        },
      ],
    ])("issues with %s", async (_name, host) => {
      const turn = plugin({}, host);
      await turn.arrive();
      await turn.start();
      expect((await turn.exec())?.params).toMatchObject({
        host: "sandbox",
        elevated: false,
        env: { FI_DELEGATED_USER_TOKEN: TOKEN },
      });
    });
  });

  describe("the time Fi is given to answer", () => {
    /** A Matrix turn whose grant check takes `ms` of the hook's deadline before Fi is asked. */
    const afterGrantCheck = async (ms: number) => {
      vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
      const timeout = vi.spyOn(AbortSignal, "timeout");
      const turn = plugin();
      await turn.arrive(matrix.arrive);
      await turn.start(matrix.start);
      fetchMock.mockImplementation(async (url: string) => {
        if (url !== AUTHORIZE_URL) {
          return minted();
        }
        vi.advanceTimersByTime(ms);
        return new Response(
          JSON.stringify({ ok: true, agentId: "cellect-fi-admin", orgId: "org-a" }),
        );
      });
      timeout.mockClear();
      const result = await turn.exec(matrix.exec);
      return { result, budgets: timeout.mock.calls.map(([budget]) => budget) };
    };
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("is at most eight seconds", async () => {
      const { result, budgets } = await afterGrantCheck(0);
      expect(result?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
      expect(budgets).toEqual([12_000, 8_000]);
    });

    it("is what the grant check left of thirteen seconds", async () => {
      const { result, budgets } = await afterGrantCheck(9_000);
      expect(result?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
      expect(budgets).toEqual([12_000, 4_000]);
    });

    it("is not spent when under half a second is left: the command runs without a token", async () => {
      const { result, budgets } = await afterGrantCheck(12_501);
      expect(result?.block).toBeUndefined();
      expect(result?.params.env).not.toHaveProperty("FI_DELEGATED_USER_TOKEN");
      expect(result?.params).not.toHaveProperty("host");
      expect(budgets).toEqual([12_000]);
      expect(mints()).toEqual([]);
    });
  });

  describe("a sandbox that holds someone's token", () => {
    const OTHER_SESSION = "agent:cellect-fi-admin:slack:direct:u0other002";
    const other = { sessionKey: OTHER_SESSION, senderId: "U0OTHER002" };
    const otherExec = {
      runId: "run-2",
      sessionKey: OTHER_SESSION,
      requester: { channel: "slack", senderId: "U0OTHER002" },
    };
    /** The admin's command has run with a token; someone else's verified turn then starts. */
    const afterAdminsCommand = async (host: Record<string, unknown> = SANDBOXED) => {
      const turn = plugin({}, host);
      await turn.arrive();
      await turn.start();
      expect((await turn.exec())?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
      await turn.arrive(other);
      await turn.start({ ...other, runId: "run-2" });
      fetchMock.mockClear();
      return turn;
    };
    afterEach(() => {
      vi.useRealTimers();
    });

    it.each([
      "exec",
      "sandbox_exec",
      "process",
      "sandbox_process",
      "read",
      "ls",
      "write",
      "edit",
      "apply_patch",
      "view_image",
    ])(
      "keeps another person's %s out of the agent's shared sandbox until the token expires",
      async (toolName) => {
        vi.useFakeTimers();
        const turn = await afterAdminsCommand();
        const call = () =>
          turn.exec({ ...otherExec, toolName }, { toolName, params: { command: "ls", path: "." } });
        expect(await call()).toEqual({ block: true, blockReason: HELD });
        expect(fetchMock).not.toHaveBeenCalled();
        vi.advanceTimersByTime(10 * 60 * 1000 + 1);
        expect((await call())?.block).toBeUndefined();
      },
    );

    it("keeps out a run nobody proved, and the owner's own run once someone else wrote into it", async () => {
      const turn = await afterAdminsCommand();
      await turn.start({ runId: "cron-1", trigger: "cron", senderId: undefined });
      expect(await turn.exec({ runId: "cron-1", requester: undefined })).toEqual({
        block: true,
        blockReason: UNPROVEN_HOLD,
      });
      // The admin's first run is still theirs.
      expect((await turn.exec())?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
      await turn.arrive({ senderId: "U0OTHER002" });
      expect(await turn.exec()).toEqual({ block: true, blockReason: UNPROVEN_HOLD });
    });

    it("leaves the owner's later runs and tools that do not reach the sandbox alone", async () => {
      const turn = await afterAdminsCommand();
      const message = await turn.exec(
        { ...otherExec, toolName: "message" },
        { toolName: "message", params: {} },
      );
      expect(message?.block).toBeUndefined();
      await turn.settle();
      await turn.arrive();
      await turn.start({ runId: "run-3" });
      expect((await turn.exec({ runId: "run-3" }))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(
        TOKEN,
      );
      const read = await turn.exec(
        { runId: "run-3", toolName: "read" },
        { toolName: "read", params: {} },
      );
      expect(read?.block).toBeUndefined();
    });

    it("holds only the session's own sandbox when sandboxes are per session", async () => {
      const turn = await afterAdminsCommand({
        ...SANDBOXED,
        agents: {
          defaults: { sandbox: { ...SANDBOXED.agents.defaults.sandbox, scope: "session" } },
        },
      });
      // Another session is another sandbox: Fi is asked about its own sender.
      expect((await turn.exec(otherExec))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
      // The admin's session stays theirs for a run nobody proved.
      await turn.start({ runId: "cron-1", trigger: "cron", senderId: undefined });
      expect(await turn.exec({ runId: "cron-1", requester: undefined })).toEqual({
        block: true,
        blockReason: UNPROVEN_HOLD,
      });
    });

    it.each([
      ["Fi refused", async () => new Response("Not found", { status: 404 })],
      [
        "claims to live longer than fifteen minutes",
        async () => minted({ expiresAt: Math.floor(Date.now() / 1000) + 15 * 60 + 5 }),
      ],
    ])("does not hold a sandbox for a token that %s", async (_name, answer) => {
      fetchMock.mockImplementation(answer);
      const turn = plugin();
      await turn.arrive();
      await turn.start();
      const result = await turn.exec();
      expect(result?.params.env).not.toHaveProperty("FI_DELEGATED_USER_TOKEN");
      expect(result?.params).not.toHaveProperty("host");
      await turn.arrive(other);
      await turn.start({ ...other, runId: "run-2" });
      expect(
        (await turn.exec({ ...otherExec, toolName: "read" }, { toolName: "read", params: {} }))
          ?.block,
      ).toBeUndefined();
      expect(
        (
          await turn.exec(
            { runId: "run-2", toolName: "process" },
            { toolName: "process", params: {} },
          )
        )?.block,
      ).toBeUndefined();
    });

    it("does not hold a sandbox for a token dropped because its run was joined meanwhile", async () => {
      const turn = plugin();
      await turn.arrive();
      await turn.start();
      let answer!: (response: Response) => void;
      fetchMock.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      );
      const pending = turn.exec();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      await turn.arrive(other);
      await turn.start({ ...other, runId: "run-2" });
      await turn.arrive({ senderId: "U0OTHER002" });
      answer(minted());
      expect((await pending)?.params.env).not.toHaveProperty("FI_DELEGATED_USER_TOKEN");
      const read = await turn.exec(
        { ...otherExec, toolName: "read" },
        { toolName: "read", params: {} },
      );
      expect(read?.block).toBeUndefined();
    });

    it("lets one of two people asking at once have the sandbox, and makes the other wait", async () => {
      const turn = plugin();
      await turn.arrive();
      await turn.start();
      await turn.arrive(other);
      await turn.start({ ...other, runId: "run-2" });
      const answers: Array<(response: Response) => void> = [];
      fetchMock.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            answers.push(resolve);
          }),
      );
      // Neither sandbox is held yet, so Fi is asked about both.
      const admins = turn.exec();
      const theirs = turn.exec(otherExec);
      await vi.waitFor(() => expect(answers).toHaveLength(2));
      answers[1]!(minted({ token: "their.fixture.token" }));
      expect((await theirs)?.params.env?.FI_DELEGATED_USER_TOKEN).toBe("their.fixture.token");
      answers[0]!(minted());
      // The admin's command must not run beside the other person's token, with or without its own.
      expect(await admins).toEqual({ block: true, blockReason: HELD });
      // And the hold is still the first person's alone.
      fetchMock.mockImplementation(async () => minted());
      expect((await turn.exec(otherExec))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
      expect(await turn.exec()).toEqual({ block: true, blockReason: HELD });
    });
  });

  it("is masked by the host wherever it records the rewritten call's arguments", async () => {
    const turn = plugin();
    await turn.arrive();
    await turn.start();
    const rewritten = await turn.exec();
    expect(rewritten?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
    // Tool-start events, the trajectory, CLI and worker events all pass through this.
    const recorded = JSON.stringify(sanitizeToolArgs(rewritten?.params));
    expect(recorded).not.toContain(TOKEN);
    expect(recorded).toContain("/usr/local/bin/cellect commands list");
  });

  describe("what the plugin asks of the host", () => {
    it("declares no tool-result middleware: declaring one slows every agent's tool results", () => {
      const manifest = JSON.parse(
        readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
      ) as { contracts: Record<string, unknown> };
      expect(Object.keys(manifest.contracts)).toEqual(["tools"]);
    });

    it("registers one run hook and its retirement beyond the base branch, and they do nothing where no token is issued", async () => {
      // A runtime with no sandbox: the pin would change how its commands run.
      const turn = plugin({}, {});
      expect(turn.registered()).toEqual({
        // The base branch's hooks, a second before_agent_reply for the token
        // rule, and the fork's own producers: generated-artifact filing
        // completion (after_tool_call + reply_payload_sending), fi-user
        // download-link stripping (message_sending + reply_payload_sending),
        // Fi's proven conversation audience (before_prompt_build), the
        // "Let me know" turn (before_model_resolve + before_prompt_build) and
        // the admin turn's `Fi requester:` line (before_prompt_build).
        hooks: [
          "after_tool_call",
          "before_agent_reply",
          "before_agent_reply",
          "before_dispatch",
          "before_model_resolve",
          "before_prompt_build",
          "before_prompt_build",
          "before_prompt_build",
          "before_steer",
          "before_tool_call",
          "message_received",
          "message_received",
          "message_sending",
          "message_sent",
          "reply_payload_sending",
          "reply_payload_sending",
        ],
        subscriptions: ["admin-delegation-turn-retirement", "matrix-entitlement-turn-retirement"],
        middleware: 0,
      });
      await turn.arrive();
      const started = await turn.start();
      const call = { params: { command: "npm run fi:audit", pty: true } };
      const result = await turn.exec({}, call);
      const read = await turn.exec({ toolName: "read" }, { toolName: "read", params: {} });
      await turn.settle();
      // The run is not answered for, the command is as it was, and Fi is never asked.
      expect(started).toBeUndefined();
      expect(result?.params).toEqual({
        ...call.params,
        env: { FI_ON_BEHALF_OF: expect.any(String) },
      });
      expect(read).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(turn.warn).not.toHaveBeenCalled();
    });
  });

  describe("what arrived and was never run", () => {
    it("is forgotten oldest first, without switching issuing off", async () => {
      const turn = plugin();
      // More sessions than are remembered, each with a message no run took up.
      for (let index = 0; index <= 5_000; index += 1) {
        await turn.arrive({
          sessionKey: `agent:cellect-fi-admin:slack:direct:u0flood${index}`,
          senderId: `U0FLOOD${index}`,
        });
      }
      await turn.arrive();
      await turn.start();
      expect((await turn.exec())?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
      expect(turn.warn).not.toHaveBeenCalled();
    });

    it("no longer admits a run six hours later", async () => {
      vi.useFakeTimers();
      try {
        const turn = plugin();
        await turn.arrive();
        vi.advanceTimersByTime(6 * 60 * 60 * 1000);
        await turn.start();
        expect((await turn.exec())?.params.env).not.toHaveProperty("FI_DELEGATED_USER_TOKEN");
        expect(mints()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("leaves an approved admin action with its typed operation owner", async () => {
    const sessionKey = "agent:cellect-fi-admin:admin-action:zzz222";
    adminActionSessions.set(sessionKey, {
      id: "ZZZ222",
      task: "external_share_link",
      fields: {},
      requester: {
        email: "member@example.com",
        identity: { channel: "slack", requesterSenderId: "U0MEMBER01" },
      },
      createdAt: Date.now(),
      status: "approved",
    });
    try {
      const turn = plugin();
      // Even a turn that would otherwise be admitted on that session.
      await turn.arrive({ sessionKey });
      await turn.start({ sessionKey });
      const result = await turn.exec({ sessionKey });
      expect(result).toEqual({
        block: true,
        blockReason:
          "Approved actions execute only through their exact typed operation owner. Generic agent tools cannot mutate or widen an approved request.",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      adminActionSessions.delete(sessionKey);
    }
  });
});

/** A Fi token whose payload names `sub` in org `a`, as Fi signs them. */
const fiToken = (sub: string, tag = "sig") =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub, org_slug: "a", agent_id: "cellect-fi-admin" })).toString("base64url")}.${tag}`;
const ADMIN_SLACK = fiToken("admin@example.com", "slack");
const ADMIN_MATRIX = fiToken("Admin@Example.com", "matrix");
const OTHER_MATRIX = fiToken("other@example.com", "other");
const PROJECTION = "!projection:matrix.example";
const CROSS = { crossChannelCustody: true };

describe("one person's sandbox hold across two channels (G-B3)", () => {
  beforeEach(() => {
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
    // Fi mints for whoever the request names; the Matrix admission gate answers ok.
    fetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
      if (url === AUTHORIZE_URL) {
        return new Response(
          JSON.stringify({ ok: true, agentId: "cellect-fi-admin", orgId: "org-a" }),
        );
      }
      const body = JSON.parse(init?.body ?? "{}") as Record<string, string>;
      return body.requesterMatrixUserId === "@other:matrix.example"
        ? minted({ token: OTHER_MATRIX }, { email: "other@example.com" })
        : body.requesterMatrixUserId
          ? minted({ token: ADMIN_MATRIX })
          : minted({ token: ADMIN_SLACK });
    });
  });

  /** A reply typed in the Slack thread's Matrix projection, admitted by Fi's source guard. */
  const projected = (senderId = "@admin:matrix.example", eventId = "$reply") => {
    const channelContext = {
      sender: { id: senderId },
      chat: {
        id: PROJECTION,
        eventId,
        sourceReplyAdmission: {
          version: 1,
          sessionKey: SLACK_THREAD,
          roomId: PROJECTION,
          senderId,
          accountId: "adminprod",
          eventId,
          authorizedAt: Date.now(),
        },
      },
    };
    return {
      arrive: {
        channel: "matrix",
        accountId: "adminprod",
        senderId,
        sessionKey: SLACK_THREAD,
        isGroup: true,
        messageId: eventId,
        channelContext,
      },
      start: {
        runId: "run-m",
        channel: "matrix",
        senderId,
        sessionKey: SLACK_THREAD,
        accountId: "adminprod",
        channelContext: { sender: { id: senderId }, chat: { id: PROJECTION, eventId } },
      },
      exec: {
        runId: "run-m",
        sessionKey: SLACK_THREAD,
        requester: { channel: "matrix", senderId, accountId: "adminprod" },
      },
    };
  };

  /** The admin's Slack command holds the agent's sandbox; its run has ended. */
  const afterSlackCommand = async (config: Record<string, unknown> = CROSS) => {
    const turn = plugin(config);
    const slack = slackThread();
    await turn.arrive(slack.arrive);
    await turn.start(slack.start);
    const first = await turn.exec(slack.exec);
    expect(first?.params.env?.FI_DELEGATED_USER_TOKEN).toBeDefined();
    await turn.settle();
    return turn;
  };

  it("lets the same person's Matrix reply in the same session run with its own token", async () => {
    const turn = await afterSlackCommand();
    const reply = projected();
    await turn.arrive(reply.arrive);
    await turn.start(reply.start);
    const result = await turn.exec(reply.exec);
    expect(result?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(ADMIN_MATRIX);
    expect(JSON.parse(String(mints().at(-1)?.[1]?.body))).toMatchObject({
      requesterMatrixUserId: "@admin:matrix.example",
    });
    // Only a minted token proves the subject: the same run's other sandbox tools stay held.
    expect(
      await turn.exec({ ...reply.exec, toolName: "read" }, { toolName: "read", params: {} }),
    ).toEqual({ block: true, blockReason: HELD });
  });

  it("holds a different person on Matrix and never injects the token Fi minted for them", async () => {
    const turn = await afterSlackCommand();
    const reply = projected("@other:matrix.example");
    await turn.arrive(reply.arrive);
    await turn.start(reply.start);
    const before = mints().length;
    const result = await turn.exec(reply.exec);
    expect(result).toEqual({ block: true, blockReason: HELD });
    expect(JSON.stringify(result)).not.toContain(OTHER_MATRIX);
    // The one extra mint the plan accepts; its token is dropped.
    expect(mints()).toHaveLength(before + 1);
  });

  it("holds the same person in a different session without asking Fi", async () => {
    const turn = await afterSlackCommand();
    await turn.arrive(matrix.arrive);
    await turn.start({ ...matrix.start, runId: "run-dm" });
    const before = mints().length;
    expect(await turn.exec({ ...matrix.exec, runId: "run-dm" })).toEqual({
      block: true,
      blockReason: HELD,
    });
    expect(mints()).toHaveLength(before);
  });

  it("holds a tool that does not mint without asking Fi", async () => {
    const turn = await afterSlackCommand();
    const reply = projected();
    await turn.arrive(reply.arrive);
    await turn.start(reply.start);
    const before = mints().length;
    expect(
      await turn.exec({ ...reply.exec, toolName: "write" }, { toolName: "write", params: {} }),
    ).toEqual({ block: true, blockReason: HELD });
    expect(mints()).toHaveLength(before);
  });

  it("holds an unproven run without asking Fi", async () => {
    const turn = await afterSlackCommand();
    await turn.start({
      runId: "cron-1",
      sessionKey: SLACK_THREAD,
      trigger: "cron",
      senderId: undefined,
    });
    const before = mints().length;
    expect(
      await turn.exec({ runId: "cron-1", sessionKey: SLACK_THREAD, requester: undefined }),
    ).toEqual({ block: true, blockReason: UNPROVEN_HOLD });
    expect(mints()).toHaveLength(before);
  });

  it("treats a holder whose token named no subject as a mismatch", async () => {
    fetchMock.mockImplementation(async (url: string, init?: { body?: string }) =>
      url === AUTHORIZE_URL
        ? new Response(JSON.stringify({ ok: true, agentId: "cellect-fi-admin", orgId: "org-a" }))
        : JSON.parse(init?.body ?? "{}").requesterMatrixUserId
          ? minted({ token: ADMIN_MATRIX })
          : minted(),
    );
    const turn = await afterSlackCommand();
    const reply = projected();
    await turn.arrive(reply.arrive);
    await turn.start(reply.start);
    const result = await turn.exec(reply.exec);
    expect(result).toEqual({ block: true, blockReason: HELD });
    expect(JSON.stringify(result)).not.toContain(ADMIN_MATRIX);
  });

  it("holds when another person's holder replaced the sandbox while Fi answered", async () => {
    const turn = await afterSlackCommand();
    const reply = projected();
    await turn.arrive(reply.arrive);
    await turn.start(reply.start);
    let answer!: (response: Response) => void;
    fetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
      if (url === AUTHORIZE_URL) {
        return new Response(
          JSON.stringify({ ok: true, agentId: "cellect-fi-admin", orgId: "org-a" }),
        );
      }
      const body = JSON.parse(init?.body ?? "{}") as Record<string, string>;
      return body.requesterMatrixUserId
        ? new Promise<Response>((resolve) => {
            answer = resolve;
          })
        : minted({ token: OTHER_MATRIX }, { email: "other@example.com" });
    });
    const pending = turn.exec(reply.exec);
    await vi.waitFor(() => expect(answer).toBeDefined());
    // The admin's command finishes; someone else's command takes the sandbox.
    await turn.cleanup({ sessionKey: SLACK_THREAD });
    const other = {
      sessionKey: "agent:cellect-fi-admin:slack:direct:u0other002",
      senderId: "U0OTHER002",
    };
    await turn.arrive(other);
    await turn.start({ ...other, runId: "run-o" });
    expect(
      (
        await turn.exec({
          runId: "run-o",
          sessionKey: other.sessionKey,
          requester: { channel: "slack", senderId: "U0OTHER002" },
        })
      )?.params.env?.FI_DELEGATED_USER_TOKEN,
    ).toBe(OTHER_MATRIX);
    answer(minted({ token: ADMIN_MATRIX }));
    const result = await pending;
    expect(result?.block).toBe(true);
    expect(JSON.stringify(result)).not.toContain(ADMIN_MATRIX);
  });

  it("holds a minting-tool candidate that gets no token, with no token or assertion", async () => {
    const turn = await afterSlackCommand();
    const reply = projected();
    await turn.arrive(reply.arrive);
    await turn.start(reply.start);
    const before = mints().length;
    // Raw shell work is never pinned, so no token is asked for.
    const result = await turn.exec(reply.exec, { params: { command: "env | sort" } });
    expect(result).toEqual({ block: true, blockReason: HELD });
    expect(JSON.stringify(result)).not.toContain("FI_DELEGATED_USER_TOKEN");
    expect(JSON.stringify(result)).not.toContain("FI_ON_BEHALF_OF");
    expect(mints()).toHaveLength(before);
  });

  it("matches nobody once the holder's own mints disagreed on the subject", async () => {
    let slackMints = 0;
    fetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
      if (url === AUTHORIZE_URL) {
        return new Response(
          JSON.stringify({ ok: true, agentId: "cellect-fi-admin", orgId: "org-a" }),
        );
      }
      const body = JSON.parse(init?.body ?? "{}") as Record<string, string>;
      if (body.requesterMatrixUserId) {
        return minted({ token: ADMIN_MATRIX });
      }
      slackMints += 1;
      return minted({
        token: slackMints === 1 ? ADMIN_SLACK : fiToken("relinked@example.com", "second"),
      });
    });
    const turn = plugin(CROSS);
    const slack = slackThread();
    await turn.arrive(slack.arrive);
    await turn.start(slack.start);
    expect((await turn.exec(slack.exec))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(ADMIN_SLACK);
    // The holder's own run gets a token for another subject: its subject is cleared.
    expect((await turn.exec(slack.exec))?.params.env?.FI_DELEGATED_USER_TOKEN).toContain(".second");
    await turn.settle();
    const reply = projected();
    await turn.arrive(reply.arrive);
    await turn.start(reply.start);
    const result = await turn.exec(reply.exec);
    expect(result).toEqual({ block: true, blockReason: HELD });
    expect(JSON.stringify(result)).not.toContain(ADMIN_MATRIX);
  });

  it.each([
    ["off by default", {}],
    ["off unless exactly true", { crossChannelCustody: "true" }],
  ])("is today's behaviour when %s: held, and Fi is never asked", async (_name, config) => {
    const turn = await afterSlackCommand(config);
    const reply = projected();
    await turn.arrive(reply.arrive);
    await turn.start(reply.start);
    const before = mints().length;
    expect(await turn.exec(reply.exec)).toEqual({ block: true, blockReason: HELD });
    expect(mints()).toHaveLength(before);
    expect(sendText).not.toHaveBeenCalled();
  });
});

describe("input written into a run that cannot act for its sender (G-B4)", () => {
  const GRACE = 30_000;
  const inject = (senderId = "U0ADMIN001") => ({
    channel: "slack",
    senderId,
    conversationId: "user:U0ADMIN001",
    threadId: "1792189039.487369",
  });
  /** A run in the admin's DM that nobody proved, such as a completion wake. */
  const wake = async (config: Record<string, unknown> = CROSS, runId = "wake-1") => {
    const turn = plugin(config, SANDBOXED, true);
    await turn.start({ runId, trigger: "cron", senderId: undefined });
    return turn;
  };
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tells the sender once per run, after the run settled and no message run followed", async () => {
    const turn = await wake();
    await turn.inject(inject());
    await turn.inject(inject());
    // Nothing while the run is still going: the host may yet queue the input.
    await vi.advanceTimersByTimeAsync(GRACE * 2);
    expect(sendText).not.toHaveBeenCalled();
    await turn.settle("wake-1");
    await vi.advanceTimersByTimeAsync(GRACE - 1);
    expect(sendText).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:U0ADMIN001",
        threadId: "1792189039.487369",
        text: INJECTED_NOTICE,
      }),
    );
    // The next run that cannot act gets its own notice.
    await turn.start({ runId: "wake-2", trigger: "cron", senderId: undefined });
    await turn.inject(inject());
    await turn.settle("wake-2");
    await vi.advanceTimersByTimeAsync(GRACE);
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(2));
  });

  it("says nothing when the message was queued and started its own proven run", async () => {
    const turn = await wake();
    // Received and dispatched while the wake runs; the host queues it.
    await turn.arrive();
    await turn.settle("wake-1");
    await turn.start();
    expect((await turn.exec())?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
    await vi.advanceTimersByTimeAsync(GRACE * 2);
    expect(sendText).not.toHaveBeenCalled();
  });

  it.each([
    ["the flag is off", {}, inject(), undefined],
    ["the input is a bot's", CROSS, inject(), { sender: { id: "U0ADMIN001", isBot: true } }],
    ["the input has no channel person", CROSS, { ...inject(), channel: "webchat" }, undefined],
  ])("says nothing when %s", async (_name, config, input, channelContext) => {
    const turn = await wake(config);
    await turn.inject({ ...input, ...(channelContext ? { channelContext } : {}) });
    await turn.settle("wake-1");
    await vi.advanceTimersByTimeAsync(GRACE * 2);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("says nothing between runs or into a run that still acts for its sender", async () => {
    const turn = plugin(CROSS, SANDBOXED, true);
    await turn.inject(inject());
    await turn.arrive();
    await turn.start();
    await turn.inject(inject());
    expect((await turn.exec())?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
    await turn.settle();
    await vi.advanceTimersByTimeAsync(GRACE * 2);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("gives a re-sent message its own proof, never the original run's requester or custody", async () => {
    const other = "U0OTHER002";
    const otherToken = fiToken("other@example.com", "theirs");
    fetchMock.mockImplementation(async (_url: string, init?: { body?: string }) =>
      JSON.parse(init?.body ?? "{}").requesterSenderId === other
        ? minted({ token: otherToken }, { email: "other@example.com" })
        : minted({ token: ADMIN_SLACK }),
    );
    const turn = plugin(CROSS, SANDBOXED, true);
    const slack = slackThread();
    await turn.arrive(slack.arrive);
    await turn.start(slack.start);
    expect((await turn.exec(slack.exec))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(ADMIN_SLACK);
    // Someone else writes into the admin's run: it no longer acts for anyone.
    await turn.inject({
      ...inject(other),
      sessionKey: SLACK_THREAD,
      conversationId: SLACK_CHANNEL,
    });
    expect(await turn.exec(slack.exec)).toEqual({ block: true, blockReason: UNPROVEN_HOLD });
    await turn.settle();
    await vi.advanceTimersByTimeAsync(GRACE);
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
    // They send it again: a new arrival, a new run, proven by its own event.
    const eventId = "1792190999.000001";
    await turn.arrive({ ...slack.arrive, senderId: other, messageId: eventId });
    await turn.start({
      ...slack.start,
      runId: "run-2",
      senderId: other,
      channelContext: { sender: { id: other }, chat: { id: SLACK_CHANNEL, eventId } },
    });
    const resent = {
      ...slack.exec,
      runId: "run-2",
      requester: { channel: "slack", senderId: other },
    };
    const held = await turn.exec(resent);
    // Fi was asked about them alone, and the admin's custody is not theirs to use.
    expect(JSON.parse(String(mints().at(-1)?.[1]?.body))).toMatchObject({
      requesterSenderId: other,
    });
    expect(held).toEqual({ block: true, blockReason: HELD });
    expect(JSON.stringify(held)).not.toContain(ADMIN_SLACK);
    expect(JSON.stringify(held)).not.toContain(otherToken);
    // Once the admin's command is cleaned up, their own token runs.
    await turn.cleanup({ sessionKey: SLACK_THREAD });
    expect((await turn.exec(resent))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(otherToken);
  });
});

describe("the host asks before steering a message into the active run (FU-B4)", () => {
  const GRACE = 30_000;
  const dm = (senderId = "U0ADMIN001", messageId = "1792189039.000100") => ({
    channel: "slack",
    senderId,
    messageId,
    conversationId: "user:U0ADMIN001",
    threadId: "1792189039.487369",
  });
  const wake = async (config: Record<string, unknown> = CROSS) => {
    const turn = plugin(config, SANDBOXED, true);
    await turn.start({ runId: "wake-1", trigger: "cron", senderId: undefined });
    return turn;
  };
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("queues a message the active unproven run cannot act on, and retracts its notice", async () => {
    const turn = await wake();
    // message_received fires first and records the notice route; the steer gate follows.
    await turn.inject(dm());
    expect(await turn.steer(dm())).toEqual({ handled: true });
    await turn.settle("wake-1");
    await vi.advanceTimersByTimeAsync(GRACE * 2);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("does not notice a queued message whose message_received arrives after the gate", async () => {
    const turn = await wake();
    expect(await turn.steer(dm())).toEqual({ handled: true });
    await turn.inject(dm());
    await turn.settle("wake-1");
    await vi.advanceTimersByTimeAsync(GRACE * 2);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("still sends the notice for an event the gate was never asked about", async () => {
    const turn = await wake();
    await turn.inject(dm("U0ADMIN001", "1792189039.000200"));
    expect(await turn.steer(dm("U0ADMIN001", "1792189039.000300"))).toEqual({ handled: true });
    await turn.settle("wake-1");
    await vi.advanceTimersByTimeAsync(GRACE);
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
  });

  it("queues another person's message into a run proven for someone else", async () => {
    const turn = plugin(CROSS, SANDBOXED, true);
    await turn.arrive();
    await turn.start();
    expect(await turn.steer(dm("U0OTHER002"))).toEqual({ handled: true });
  });

  it("lets the same person's message steer into their own proven run", async () => {
    const turn = plugin(CROSS, SANDBOXED, true);
    await turn.arrive();
    await turn.start();
    expect(await turn.steer(dm("U0ADMIN001"))).toBeUndefined();
  });

  it.each([
    ["the flag is off", {}],
    ["the flag is not exactly true", { crossChannelCustody: "true" }],
  ])("is today's behaviour when %s: never claims the steer", async (_name, config) => {
    const turn = await wake(config);
    expect(await turn.steer(dm())).toBeUndefined();
    await turn.inject(dm());
    await turn.settle("wake-1");
    await vi.advanceTimersByTimeAsync(GRACE * 2);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("does not claim a steer when no run is active in the session or the channel is not a person's", async () => {
    const idle = plugin(CROSS, SANDBOXED, true);
    expect(await idle.steer(dm())).toBeUndefined();
    const turn = await wake();
    expect(await turn.steer({ ...dm(), channel: "webchat" })).toBeUndefined();
  });
});
