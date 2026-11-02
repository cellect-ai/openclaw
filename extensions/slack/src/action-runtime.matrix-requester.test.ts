import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackActionContext } from "./action-context.js";
import { handleSlackAction, slackActionRuntime } from "./action-runtime.js";

const { requesterSlackIdentity, authTest, getClient } = vi.hoisted(() => ({
  requesterSlackIdentity: vi.fn(),
  authTest: vi.fn(),
  getClient: vi.fn(),
}));
vi.mock("./actions.js", () => ({ getClient }));
vi.mock("./runtime.js", () => ({
  getOptionalSlackRuntime: () => ({
    channel: { runtimeContexts: { get: () => ({ resolveSender: requesterSlackIdentity }) } },
  }),
}));
const original = { ...slackActionRuntime };
const readSlackMessages = vi.fn();
const isSlackConversationMember = vi.fn();
function slackConfig(overrides: Record<string, unknown> = {}): OpenClawConfig {
  return {
    agents: { entries: { "cellect-main": {}, "other-agent": {} } },
    bindings: ["default", "readerone", "readertwo"].map((accountId) => ({
      agentId: "cellect-main",
      match: { channel: "slack", accountId, teamId: "T12345678" },
    })),
    channels: { slack: { botToken: "fixture-token", ...overrides } },
  };
}
const allowlisted = () =>
  slackConfig({ groupPolicy: "allowlist", channels: { C_CURRENT: { enabled: true } } });
beforeEach(() => {
  requesterSlackIdentity.mockReset().mockResolvedValue("U123");
  authTest.mockReset().mockResolvedValue({ ok: true, team_id: "T12345678" });
  getClient.mockReset().mockResolvedValue({ auth: { test: authTest } });
  readSlackMessages.mockReset().mockResolvedValue({ messages: [], hasMore: false });
  isSlackConversationMember.mockReset().mockResolvedValue(false);
  Object.assign(slackActionRuntime, {
    readSlackMessages,
    isSlackConversationMember,
    resolveSlackConversationInfo: async ({ channelId }: { channelId: string }) =>
      channelId.startsWith("D") ? { type: "dm", user: "U123" } : { type: "channel" },
  });
});
afterEach(() => Object.assign(slackActionRuntime, original));
describe("Matrix requester Slack reads", () => {
  const matrixRequester = {
    agentId: "cellect-main",
    currentChannelProvider: "matrix",
    sessionKey: "agent:cellect-main:matrix:room:!room:example.test",
    currentChannelId: "!room:example.test",
    requesterAccountId: "fi-user",
    requesterSenderId: "@member:example.test",
  } satisfies SlackActionContext;

  it.each(["C0AD5780BSQ", "D0B7Y5Y477H"])(
    "reads %s through a verified Matrix requester without changing the source identity",
    async (channelId) => {
      if (channelId.startsWith("C")) {
        isSlackConversationMember.mockResolvedValueOnce(true);
      }
      await handleSlackAction(
        { action: "readMessages", channelId },
        allowlisted(),
        matrixRequester,
      );
      expect(requesterSlackIdentity).toHaveBeenCalledWith({
        sessionKey: matrixRequester.sessionKey,
        accountId: "fi-user",
        senderId: "@member:example.test",
        workspaceId: "T12345678",
      });
      expect(readSlackMessages).toHaveBeenCalled();
    },
  );

  it("allows different Slack bot accounts in the same authenticated workspace", async () => {
    const config = slackConfig({
      groupPolicy: "allowlist",
      accounts: {
        readerone: { botToken: "fixture-reader-one" },
        readertwo: { botToken: "fixture-reader-two" },
      },
    });
    isSlackConversationMember.mockResolvedValue(true);
    for (const accountId of ["readerone", "readertwo"]) {
      await handleSlackAction(
        { action: "readMessages", channelId: "C_OTHER", accountId },
        config,
        matrixRequester,
      );
      expect(getClient).toHaveBeenLastCalledWith(expect.objectContaining({ accountId }));
      expect(requesterSlackIdentity).toHaveBeenLastCalledWith({
        sessionKey: matrixRequester.sessionKey,
        accountId: "fi-user",
        senderId: matrixRequester.requesterSenderId,
        workspaceId: "T12345678",
      });
    }
    expect(readSlackMessages).toHaveBeenCalledTimes(2);
  });

  it("uses the selected read token's authenticated workspace", async () => {
    authTest.mockResolvedValueOnce({ ok: true, team_id: "T99999999" });
    isSlackConversationMember.mockResolvedValueOnce(true);
    const config = slackConfig({ groupPolicy: "allowlist", userToken: "fixture-user-token" });
    config.bindings = [
      {
        agentId: "cellect-main",
        match: {
          channel: "slack",
          accountId: "default",
          teamId: "T99999999",
        },
      },
    ];
    await handleSlackAction(
      { action: "readMessages", channelId: "C_OTHER" },
      config,
      matrixRequester,
    );
    expect(getClient).toHaveBeenCalledWith(
      expect.objectContaining({ token: "fixture-user-token" }),
    );
    expect(requesterSlackIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "T99999999" }),
    );
    expect(readSlackMessages).toHaveBeenCalled();
  });

  it("uses an Enterprise installation's explicit target workspace", async () => {
    authTest.mockResolvedValueOnce({
      ok: true,
      is_enterprise_install: true,
      enterprise_id: "E12345678",
    });
    isSlackConversationMember.mockResolvedValueOnce(true);
    await handleSlackAction(
      { action: "readMessages", channelId: "team:T12345678:channel:C0123456789" },
      allowlisted(),
      matrixRequester,
    );
    expect(getClient).toHaveBeenCalledWith(expect.objectContaining({ teamId: "T12345678" }));
    expect(requesterSlackIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "T12345678" }),
    );
    expect(readSlackMessages).toHaveBeenCalled();
  });

  it.each([
    { auth: { ok: true, team_id: "T99999999" }, channelId: "team:T12345678:channel:C0123456789" },
    {
      auth: { ok: true, is_enterprise_install: true, enterprise_id: "E12345678" },
      channelId: "C_OTHER",
    },
    { auth: { ok: false }, channelId: "C_OTHER" },
  ])("refuses an unproven effective target workspace: %j", async ({ auth, channelId }) => {
    authTest.mockResolvedValueOnce(auth);
    isSlackConversationMember.mockResolvedValueOnce(true);
    await expect(
      handleSlackAction({ action: "readMessages", channelId }, allowlisted(), matrixRequester),
    ).rejects.toThrow("Slack read target channel is not allowed");
    expect(requesterSlackIdentity).not.toHaveBeenCalled();
    expect(isSlackConversationMember).not.toHaveBeenCalled();
    expect(readSlackMessages).not.toHaveBeenCalled();
  });

  it("keeps configured read policy independent of Matrix mapping", async () => {
    await handleSlackAction(
      { action: "readMessages", channelId: "C_CURRENT" },
      allowlisted(),
      matrixRequester,
    );
    expect(authTest).toHaveBeenCalledTimes(1);
    expect(requesterSlackIdentity).not.toHaveBeenCalled();
    expect(readSlackMessages).toHaveBeenCalled();
  });

  it("rejects a read token from outside the configured binding workspace before content", async () => {
    authTest.mockResolvedValueOnce({ ok: true, team_id: "T99999999" });
    await expect(
      handleSlackAction(
        { action: "readMessages", channelId: "C_CURRENT" },
        allowlisted(),
        matrixRequester,
      ),
    ).rejects.toThrow("no matching agent account binding");
    expect(requesterSlackIdentity).not.toHaveBeenCalled();
    expect(readSlackMessages).not.toHaveBeenCalled();
  });

  it("does not let a wildcard binding widen the selected account's workspace", async () => {
    const config = allowlisted();
    config.bindings?.push({ agentId: "cellect-main", match: { channel: "slack", accountId: "*" } });
    authTest.mockResolvedValueOnce({ ok: true, team_id: "T99999999" });
    await expect(
      handleSlackAction(
        { action: "readMessages", channelId: "C_CURRENT" },
        config,
        matrixRequester,
      ),
    ).rejects.toThrow("no matching agent account binding");
    expect(requesterSlackIdentity).not.toHaveBeenCalled();
    expect(readSlackMessages).not.toHaveBeenCalled();
  });

  it.each(["channel", "direct"] as const)(
    "honors another agent's more specific %s binding",
    async (kind) => {
      const config = allowlisted();
      config.bindings?.push({
        agentId: "other-agent",
        match: {
          channel: "slack",
          accountId: "default",
          teamId: "T12345678",
          peer: { kind, id: kind === "direct" ? "U123" : "C_CURRENT" },
        },
      });
      await expect(
        handleSlackAction(
          { action: "readMessages", channelId: kind === "direct" ? "D0DM" : "C_CURRENT" },
          config,
          matrixRequester,
        ),
      ).rejects.toThrow("no matching agent account binding");
      expect(requesterSlackIdentity).not.toHaveBeenCalled();
      expect(readSlackMessages).not.toHaveBeenCalled();
    },
  );

  it.each(["agentId", "sessionKey", "requesterAccountId", "requesterSenderId"] as const)(
    "refuses missing host %s before authenticating credentials",
    async (field) => {
      await expect(
        handleSlackAction({ action: "readMessages", channelId: "C_CURRENT" }, allowlisted(), {
          ...matrixRequester,
          [field]: undefined,
        }),
      ).rejects.toThrow("no matching agent account binding");
      expect(authTest).not.toHaveBeenCalled();
      expect(readSlackMessages).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])("retains requester membership for Matrix reads (DM=%s)", async (dm) => {
    requesterSlackIdentity.mockResolvedValueOnce("U999");
    await expect(
      handleSlackAction(
        { action: "readMessages", channelId: dm ? "D0DM" : "C_OTHER" },
        allowlisted(),
        matrixRequester,
      ),
    ).rejects.toThrow("the requester is not a member");
    expect(readSlackMessages).not.toHaveBeenCalled();
  });

  it("refuses unconfigured Matrix mapping and other source providers", async () => {
    requesterSlackIdentity.mockResolvedValue(undefined);
    for (const currentChannelProvider of ["matrix", "webchat"]) {
      await expect(
        handleSlackAction({ action: "readMessages", channelId: "C_OTHER" }, allowlisted(), {
          ...matrixRequester,
          currentChannelProvider,
        }),
      ).rejects.toThrow("Slack read target channel is not allowed");
    }
    expect(readSlackMessages).not.toHaveBeenCalled();
  });

  it("rejects a Matrix mapping retired during lookup", async () => {
    const assertCurrent = vi.fn();
    requesterSlackIdentity.mockImplementationOnce(async () => {
      assertCurrent.mockImplementation(() => {
        throw new Error("request retired");
      });
      return "U123";
    });
    await expect(
      handleSlackAction({ action: "readMessages", channelId: "C_OTHER" }, allowlisted(), {
        ...matrixRequester,
        assertDirectAdapterHandoff: assertCurrent,
      }),
    ).rejects.toThrow("request retired");
    expect(readSlackMessages).not.toHaveBeenCalled();
  });

  it("stops when authority retires during workspace authentication", async () => {
    const assertCurrent = vi.fn();
    authTest.mockImplementationOnce(async () => {
      assertCurrent.mockImplementation(() => {
        throw new Error("request retired");
      });
      return { ok: true, team_id: "T12345678" };
    });
    await expect(
      handleSlackAction({ action: "readMessages", channelId: "C_OTHER" }, allowlisted(), {
        ...matrixRequester,
        assertDirectAdapterHandoff: assertCurrent,
      }),
    ).rejects.toThrow("request retired");
    expect(requesterSlackIdentity).not.toHaveBeenCalled();
    expect(readSlackMessages).not.toHaveBeenCalled();
  });

  it("does not map Matrix identities for writes or explicitly disabled targets", async () => {
    for (const [action, config] of [
      ["deleteMessage", allowlisted()],
      ["readMessages", slackConfig({ channels: { C_OTHER: { enabled: false } } })],
      ["readMessages", slackConfig({ dm: { enabled: false } })],
      ["readMessages", slackConfig({ groupPolicy: "disabled" })],
      ["readMessages", slackConfig({ channels: { "*": { enabled: false } } })],
    ] as const) {
      await expect(
        handleSlackAction(
          {
            action,
            channelId: config.channels?.slack?.dm?.enabled === false ? "D0DM" : "C_OTHER",
            messageId: "1.000001",
          },
          config,
          matrixRequester,
        ),
      ).rejects.toThrow("Slack read target channel is not allowed");
    }
    expect(requesterSlackIdentity).not.toHaveBeenCalled();
  });

  it("keeps DM reads enabled when channel policy disables channels", async () => {
    await handleSlackAction(
      { action: "readMessages", channelId: "D0DM" },
      slackConfig({ groupPolicy: "disabled", channels: { "*": { enabled: false } } }),
      matrixRequester,
    );
    expect(readSlackMessages).toHaveBeenCalled();
  });
});

/**
 * A Fi (Matrix) turn reads a pasted Slack permalink without naming a Slack
 * account: the acting agent's own bound account reads it, and only what the
 * requester's linked Slack identity can see in that workspace is admitted.
 */
describe("Slack permalinks read from a Fi chat turn", () => {
  const fiAdmin = {
    agentId: "cellect-fi-admin",
    currentChannelProvider: "matrix",
    sessionKey: "agent:cellect-fi-admin:matrix:channel:!room:example.test:thread:$root",
    currentChannelId: "!room:example.test",
    requesterAccountId: "shapeadminprod",
    requesterSenderId: "@alex:example.test",
  } satisfies SlackActionContext;
  /** Shape's shape: per-agent Slack accounts, a tokenless default, a fi-user catch-all. */
  const tenantConfig = (): OpenClawConfig => ({
    agents: { entries: { "cellect-fi-admin": {}, "cellect-fi-user": {} } },
    bindings: [
      { agentId: "cellect-fi-user", match: { channel: "slack", accountId: "fi-user", teamId: "T12345678" } },
      { agentId: "cellect-fi-admin", match: { channel: "slack", accountId: "fi-admin", teamId: "T12345678" } },
      { agentId: "cellect-fi-user", match: { channel: "slack", accountId: "*" } },
    ],
    channels: {
      slack: {
        accounts: {
          default: { groupPolicy: "open" },
          "fi-admin": { botToken: "fixture-admin-token", groupPolicy: "allowlist" },
          "fi-user": { botToken: "fixture-user-token", groupPolicy: "allowlist" },
        },
      },
    },
  });

  it.each([
    ["cellect-fi-admin", "fi-admin"],
    ["cellect-fi-user", "fi-user"],
  ])("lets %s read a channel the requester can see through its own account", async (agentId, account) => {
    isSlackConversationMember.mockResolvedValueOnce(true);
    await handleSlackAction(
      { action: "readMessages", channelId: "C0BJLAWS49H", threadId: "1793070634.018549" },
      tenantConfig(),
      { ...fiAdmin, agentId, sessionKey: fiAdmin.sessionKey.replace("cellect-fi-admin", agentId) },
    );
    expect(getClient).toHaveBeenCalledWith(expect.objectContaining({ accountId: account }));
    expect(isSlackConversationMember).toHaveBeenCalledWith(
      "C0BJLAWS49H",
      "U123",
      expect.objectContaining({ accountId: account }),
    );
    expect(requesterSlackIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ senderId: "@alex:example.test", workspaceId: "T12345678" }),
    );
    expect(readSlackMessages).toHaveBeenCalledWith(
      "C0BJLAWS49H",
      expect.objectContaining({ threadId: "1793070634.018549" }),
    );
  });

  it("denies a channel the requester cannot see", async () => {
    isSlackConversationMember.mockResolvedValueOnce(false);
    await expect(
      handleSlackAction({ action: "readMessages", channelId: "C0PRIVATE01" }, tenantConfig(), fiAdmin),
    ).rejects.toThrow("the requester is not a member");
    expect(readSlackMessages).not.toHaveBeenCalled();
  });

  it("denies a requester with no linked Slack identity", async () => {
    requesterSlackIdentity.mockResolvedValueOnce(undefined);
    await expect(
      handleSlackAction({ action: "readMessages", channelId: "C0BJLAWS49H" }, tenantConfig(), fiAdmin),
    ).rejects.toThrow("Slack read target channel is not allowed");
    expect(readSlackMessages).not.toHaveBeenCalled();
  });

  it("denies another workspace, by its token or by the link's team", async () => {
    authTest.mockResolvedValueOnce({ ok: true, team_id: "T99999999" });
    await expect(
      handleSlackAction({ action: "readMessages", channelId: "C0BJLAWS49H" }, tenantConfig(), fiAdmin),
    ).rejects.toThrow("Slack read target channel is not allowed");
    await expect(
      handleSlackAction(
        { action: "readMessages", channelId: "team:T99999999:channel:C0OTHER001" },
        tenantConfig(),
        fiAdmin,
      ),
    ).rejects.toThrow();
    expect(readSlackMessages).not.toHaveBeenCalled();
    expect(isSlackConversationMember).not.toHaveBeenCalled();
  });

  it("selects no account for an agent with several or no explicit Slack bindings, or a Slack turn", async () => {
    const several = tenantConfig();
    several.bindings!.push({
      agentId: "cellect-fi-admin",
      match: { channel: "slack", accountId: "fi-user", teamId: "T12345678" },
    });
    for (const [config, context] of [
      [several, fiAdmin],
      [tenantConfig(), { ...fiAdmin, agentId: "other-agent" }],
      [tenantConfig(), { ...fiAdmin, currentChannelProvider: "slack" }],
      [tenantConfig(), { ...fiAdmin, conversationReadOrigin: "direct-operator" as const }],
    ] as const) {
      await handleSlackAction(
        { action: "readMessages", channelId: "C0BJLAWS49H" },
        config,
        context,
      ).catch(() => undefined);
    }
    // Nothing selected an agent's own account: only the named-or-default path ran.
    const selected = [
      ...getClient.mock.calls.map(([opts]) => (opts as { accountId?: string }).accountId),
      ...readSlackMessages.mock.calls.map(([, opts]) => (opts as { accountId?: string }).accountId),
    ];
    expect(selected.filter((id) => id === "fi-admin" || id === "fi-user")).toEqual([]);
  });
});
