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
