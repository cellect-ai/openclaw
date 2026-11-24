import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSlackAccount } from "../../accounts.js";
import {
  clearSlackThreadParticipationCache,
  recordSlackThreadParticipation,
  registerSlackThreadOwnerPeer,
} from "../../sent-thread-cache.js";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackEventScope } from "../event-scope.js";
import {
  createInboundSlackTestContext,
  createSlackSessionStoreFixture,
  createSlackTestAccount as createSlackAccount,
  prepareInbound,
  slackConfig,
} from "./prepare.test-helpers.js";

describe("slack implicit mention policy", () => {
  const storeFixture = createSlackSessionStoreFixture("openclaw-slack-explicit-mention-");

  beforeEach(clearSlackThreadParticipationCache);

  function prepareThreadMessage(
    eventScope?: SlackEventScope,
    options: Pick<
      Parameters<typeof createInboundSlackTestContext>[0],
      "channelsConfig" | "groupPolicy"
    > = {},
  ) {
    const channelsConfig = options.channelsConfig ?? { C123: { requireMention: true } };
    const ctx = createInboundSlackTestContext({
      cfg: slackConfig(
        { channels: channelsConfig, groupPolicy: options.groupPolicy },
        { session: { store: storeFixture.makeTmpStorePath().storePath } },
      ),
      channelsConfig,
      groupPolicy: options.groupPolicy,
    });
    ctx.resolveUserName = async () => ({ name: "Alice" });
    return prepareInbound(
      ctx,
      {
        channel: "C123",
        channel_type: "channel",
        text: "hello",
        ts: "1700000001.000001",
        thread_ts: "1700000000.000000",
        parent_user_id: "U2",
      },
      undefined,
      { source: "message", eventScope },
    );
  }

  it("accepts an unmentioned reply more than 24 hours after joining a required-mention thread", async () => {
    const threadTs = "1700000000.000000";
    const initialNow = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(initialNow);

    try {
      recordSlackThreadParticipation("default", "C123", threadTs);
      nowSpy.mockReturnValue(initialNow + 25 * 60 * 60 * 1000);

      const result = await prepareThreadMessage();

      expect(result?.ctxPayload.MentionSource).toBe("implicit_thread");
      expect(result?.ctxPayload.ImplicitMentionKinds).toEqual(["bot_thread_participant"]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  const unauthorizedThreadCases: Array<{
    authorization: string;
    options: Parameters<typeof prepareThreadMessage>[1];
  }> = [
    {
      authorization: "channel",
      options: {
        channelsConfig: { C_ALLOWED: { enabled: true, requireMention: true } },
        groupPolicy: "allowlist" as const,
      },
    },
    {
      authorization: "sender",
      options: { channelsConfig: { C123: { requireMention: true, users: ["U_ALLOWED"] } } },
    },
  ];
  it.each(unauthorizedThreadCases)(
    "rejects a joined thread when $authorization authorization fails",
    async ({ options }) => {
      recordSlackThreadParticipation("default", "C123", "1700000000.000000");

      expect(await prepareThreadMessage(undefined, options)).toBeNull();
    },
  );

  it("does not accept participation recorded in a different enterprise workspace", async () => {
    recordSlackThreadParticipation("default", "C123", "1700000000.000000", { teamId: "T_OTHER" });
    const eventScope = {
      teamId: "T1",
      client: {} as SlackEventScope["client"],
    } satisfies SlackEventScope;

    expect(await prepareThreadMessage(eventScope)).toBeNull();
  });

  it("drops the current owner when another bot is mentioned, even if it handles the event first", async () => {
    const threadTs = "1700000000.000000";
    const { fiAdmin, fiUser } = createOwnershipPair();
    recordSlackThreadParticipation("fi-admin", "C123", threadTs);
    recordSlackThreadParticipation("fi-user", "C123", threadTs);
    await prepareOwnershipThreadMessage({ ...fiAdmin, message: { thread_ts: threadTs } });

    const mention = { thread_ts: threadTs, text: "<@BUSER> take this one" };
    // The owner's handler starts before the mentioned bot's forced claim lands.
    const [adminResult, userResult] = await Promise.all([
      prepareOwnershipThreadMessage({ ...fiAdmin, message: mention }),
      prepareOwnershipThreadMessage({ ...fiUser, message: mention }),
    ]);
    const nextAdmin = await prepareOwnershipThreadMessage({
      ...fiAdmin,
      message: { thread_ts: threadTs, ts: "1700000002.000001" },
    });

    expect(adminResult).toBeNull();
    expect(userResult?.ctxPayload.MentionSource).toBe("explicit_bot");
    expect(nextAdmin).toBeNull();
  });

  it("lets a lower-ranked bot own a top-level message that mentions only it", async () => {
    const { fiAdmin, fiUser } = createOwnershipPair({ requireMention: false });
    const message = {
      text: "<@BUSER> status?",
      thread_ts: undefined,
      parent_user_id: undefined,
    };

    const adminResult = await prepareOwnershipThreadMessage({ ...fiAdmin, message });
    const userResult = await prepareOwnershipThreadMessage({ ...fiUser, message });

    expect(adminResult).toBeNull();
    expect(userResult?.ctxPayload.MentionSource).toBe("explicit_bot");
  });

  it("admits one bot for an unmentioned top-level message both bots would answer", async () => {
    const { fiAdmin, fiUser } = createOwnershipPair({ requireMention: false });
    const message = { text: "status?", thread_ts: undefined, parent_user_id: undefined };

    const userResult = await prepareOwnershipThreadMessage({ ...fiUser, message });
    const adminResult = await prepareOwnershipThreadMessage({ ...fiAdmin, message });

    expect(userResult).toBeNull();
    expect(adminResult).not.toBeNull();
  });

  it("runs only the highest-ranked mentioned bot on a top-level channel message", async () => {
    const { fiAdmin, fiUser } = createOwnershipPair();
    const message = {
      text: "<@BUSER> <@BADMIN> please both look",
      thread_ts: undefined,
      parent_user_id: undefined,
    };

    const userResult = await prepareOwnershipThreadMessage({ ...fiUser, message });
    const adminResult = await prepareOwnershipThreadMessage({ ...fiAdmin, message });

    expect(userResult).toBeNull();
    expect(adminResult?.ctxPayload.MentionSource).toBe("explicit_bot");
  });

  it("runs only the highest-ranked bot when several preferred bots are mentioned", async () => {
    const { fiAdmin, fiUser } = createOwnershipPair();
    const message = { text: "<@BUSER> <@BADMIN> please both look" };

    const [userResult, adminResult] = await Promise.all([
      prepareOwnershipThreadMessage({ ...fiUser, message }),
      prepareOwnershipThreadMessage({ ...fiAdmin, message }),
    ]);

    expect(userResult).toBeNull();
    expect(adminResult?.ctxPayload.MentionSource).toBe("explicit_bot");
  });

  it("transfers shared-thread ownership when another bot is explicitly mentioned", async () => {
    const threadTs = "1700000000.000000";
    const cfg = {
      channels: {
        slack: {
          enabled: true,
          implicitMentions: { threadParticipation: true },
          threadOwnership: { preferredAccounts: ["fi-admin", "fi-user"] },
          accounts: { "fi-admin": {}, "fi-user": {} },
        },
      },
      session: {},
    } as OpenClawConfig;
    const fiAdminContext = createInboundSlackTestContext({ cfg, accountId: "fi-admin" });
    const fiUserContext = createInboundSlackTestContext({ cfg, accountId: "fi-user" });
    fiAdminContext.resolveUserName = async () => ({ name: "Alice" });
    fiUserContext.resolveUserName = async () => ({ name: "Alice" });
    const fiAdminAccount = { ...createSlackAccount(), accountId: "fi-admin" };
    const fiUserAccount = { ...createSlackAccount(), accountId: "fi-user" };
    recordSlackThreadParticipation("fi-admin", "C123", threadTs);
    recordSlackThreadParticipation("fi-user", "C123", threadTs);

    await prepareOwnershipThreadMessage({
      ctx: fiAdminContext,
      account: fiAdminAccount,
      message: { thread_ts: threadTs },
    });
    const explicitFiUser = await prepareOwnershipThreadMessage({
      ctx: fiUserContext,
      account: fiUserAccount,
      message: { thread_ts: threadTs, text: "<@B1> continue" },
    });
    const nextFiAdmin = await prepareOwnershipThreadMessage({
      ctx: fiAdminContext,
      account: fiAdminAccount,
      message: { thread_ts: threadTs },
    });

    expect(explicitFiUser?.ctxPayload.MentionSource).toBe("explicit_bot");
    expect(nextFiAdmin).toBeNull();
  });

  it("admits only the preferred participating account in a shared unmentioned thread", async () => {
    const threadTs = "1700000000.000000";
    const cfg = {
      channels: {
        slack: {
          enabled: true,
          implicitMentions: { threadParticipation: true },
          threadOwnership: { preferredAccounts: ["fi-admin", "fi-user"] },
          accounts: { "fi-admin": {}, "fi-user": {} },
        },
      },
      session: {},
    } as OpenClawConfig;
    const fiAdminContext = createInboundSlackTestContext({ cfg, accountId: "fi-admin" });
    const fiUserContext = createInboundSlackTestContext({ cfg, accountId: "fi-user" });
    fiAdminContext.resolveUserName = async () => ({ name: "Alice" });
    fiUserContext.resolveUserName = async () => ({ name: "Alice" });
    const fiAdminAccount = { ...createSlackAccount(), accountId: "fi-admin" };
    const fiUserAccount = { ...createSlackAccount(), accountId: "fi-user" };
    recordSlackThreadParticipation("fi-admin", "C123", threadTs);
    recordSlackThreadParticipation("fi-user", "C123", threadTs);

    const fiUser = await prepareOwnershipThreadMessage({
      ctx: fiUserContext,
      account: fiUserAccount,
      message: { thread_ts: threadTs },
    });
    const fiAdmin = await prepareOwnershipThreadMessage({
      ctx: fiAdminContext,
      account: fiAdminAccount,
      message: { thread_ts: threadTs },
    });

    expect(fiUser).toBeNull();
    expect(fiAdmin?.ctxPayload.MentionSource).toBe("implicit_thread");
  });

  async function prepareOwnershipThreadMessage(params: {
    ctx: SlackMonitorContext;
    message?: Partial<SlackMessageEvent>;
    account?: ResolvedSlackAccount;
  }) {
    const { storePath } = storeFixture.makeTmpStorePath();
    vi.spyOn(
      await import("openclaw/plugin-sdk/session-store-runtime"),
      "resolveStorePath",
    ).mockReturnValue(storePath);
    return prepareInbound(
      params.ctx,
      {
        channel: "C123",
        channel_type: "channel",
        user: "U1",
        text: "hello",
        ts: "1700000001.000001",
        thread_ts: "1700000000.000000",
        parent_user_id: "U2",
        ...params.message,
      },
      params.account,
    );
  }

  function createOwnershipPair(options?: { requireMention?: boolean }) {
    const cfg = {
      channels: {
        slack: {
          enabled: true,
          implicitMentions: { threadParticipation: true },
          threadOwnership: { preferredAccounts: ["fi-admin", "fi-user"] },
          accounts: { "fi-admin": {}, "fi-user": {} },
        },
      },
      session: {},
    } as OpenClawConfig;
    const defaultRequireMention = options?.requireMention ?? true;
    const fiAdmin = createInboundSlackTestContext({
      cfg,
      accountId: "fi-admin",
      defaultRequireMention,
    });
    const fiUser = createInboundSlackTestContext({
      cfg,
      accountId: "fi-user",
      defaultRequireMention,
    });
    fiAdmin.botUserId = "BADMIN";
    fiUser.botUserId = "BUSER";
    for (const ctx of [fiAdmin, fiUser]) {
      ctx.resolveUserName = async () => ({ name: "Alice" });
      registerSlackThreadOwnerPeer(ctx.accountId, {
        botUserId: () => ctx.botUserId,
        answersUnmentioned: () => !defaultRequireMention,
      });
    }
    return {
      fiAdmin: {
        ctx: fiAdmin,
        account: { ...createSlackAccount(), accountId: "fi-admin" },
      },
      fiUser: {
        ctx: fiUser,
        account: { ...createSlackAccount(), accountId: "fi-user" },
      },
    };
  }
});
