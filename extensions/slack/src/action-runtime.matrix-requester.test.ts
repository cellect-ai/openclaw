import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackActionContext } from "./action-context.js";
import { handleSlackAction, slackActionRuntime } from "./action-runtime.js";

const requesterSlackIdentity = vi.hoisted(() => vi.fn());
vi.mock("./runtime.js", () => ({
  getOptionalSlackRuntime: () => ({
    channel: { runtimeContexts: { get: () => ({ resolveSender: requesterSlackIdentity }) } },
  }),
}));
const original = { ...slackActionRuntime };
const readSlackMessages = vi.fn();
const isSlackConversationMember = vi.fn();
function slackConfig(overrides: Record<string, unknown> = {}): OpenClawConfig {
  return { channels: { slack: { botToken: "fixture-token", ...overrides } } };
}
const allowlisted = () =>
  slackConfig({ groupPolicy: "allowlist", channels: { C_CURRENT: { enabled: true } } });
beforeEach(() => {
  requesterSlackIdentity.mockReset().mockResolvedValue("U123");
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
      });
      expect(readSlackMessages).toHaveBeenCalled();
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
