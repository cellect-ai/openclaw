import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import * as commandSecretGateway from "../../cli/command-secret-gateway.js";
import * as commandSecretTargets from "../../cli/command-secret-targets.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type {
  MessageActionInput,
  MessageActionResult,
} from "../../infra/outbound/message-action-contracts.js";
import * as messageActionRunner from "../../infra/outbound/message-action-runner.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { createMessageTool } from "./message-tool-execution.js";
import {
  registerMessageChannel,
  resolvedMessageSecrets,
  stubMessageSecrets,
} from "./message-tool-execution.test-support.js";

const EMPTY_CATALOG = { version: 0, channels: [], getChannel: () => undefined } as const;
beforeEach(() => {
  setRuntimeConfigSnapshot({});
  stubMessageSecrets();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});

describe("message tool destination account selection", () => {
  afterEach(() => resetPluginRuntimeStateForTest());
  it.each([
    "matching-team",
    "wrong-team",
    "changed-team",
    "bare-target",
    "bare-channel",
    "explicit-account",
  ])("uses provider-owned account scope and target grammar: %s", async (mode) => {
    let authenticatedTeam = mode === "wrong-team" ? "T_OTHER" : "T_EXPECTED";
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "slack",
        config: { listAccountIds: () => ["slack-admin", "explicit-slack", "fallback"] },
      }),
      messaging: {
        resolveAccountBindingScope: () => ({
          groupSpace: authenticatedTeam,
        }),
        inferTargetChatType: ({ to }) =>
          to.startsWith("U") ? "direct" : to.startsWith("C") ? "channel" : undefined,
      },
      actions: { describeMessageTool: () => ({ actions: ["send"] }) },
    };
    registerMessageChannel(plugin);
    const getScoped = vi.mocked(commandSecretTargets.getScopedChannelsCommandSecretTargets);
    vi.mocked(commandSecretGateway.resolveCommandSecretRefsViaGateway).mockImplementation(
      async ({ config }) => {
        if (mode === "changed-team") authenticatedTeam = "T_OTHER";
        return resolvedMessageSecrets(config);
      },
    );
    const runAction = vi
      .spyOn(messageActionRunner, "runMessageAction")
      .mockImplementation(async (_input: MessageActionInput): Promise<MessageActionResult> => ({
        kind: "send",
        channel: "slack",
        action: "send",
        to: "user:recipient",
        handledBy: "plugin",
        payload: { ok: true, messageId: "sent-fixture" },
        dryRun: false,
      }));
    const tool = createMessageTool({
      config: {
        bindings: [
          {
            agentId: "fixture-admin",
            match: {
              channel: "slack",
              accountId: "slack-admin",
              teamId: "T_EXPECTED",
              ...(mode === "bare-target" || mode === "bare-channel"
                ? {
                    peer: {
                      kind: mode === "bare-target" ? ("direct" as const) : ("channel" as const),
                      id: "*",
                    },
                  }
                : {}),
            },
          },
          ...(mode === "bare-target" || mode === "bare-channel"
            ? [{ agentId: "fixture-admin", match: { channel: "slack", accountId: "fallback" } }]
            : []),
        ],
      },
      agentId: "fixture-admin",
      agentAccountId: "matrix-admin",
      currentChannelProvider: "matrix",
      currentChannelId: "!source:example.test",
      preparedMessageToolCatalog: EMPTY_CATALOG,
    });
    const send = tool.execute("cross-provider", {
      action: "send",
      channel: "slack",
      target:
        mode === "bare-target"
          ? "U_RECIPIENT"
          : mode === "bare-channel"
            ? "C_TARGET"
            : "user:recipient",
      ...(mode === "explicit-account" ? { accountId: "explicit-slack" } : {}),
      message: "Requested fixture DM",
    });
    if (mode === "wrong-team") {
      await expect(send).rejects.toThrow("No destination account binding matches");
      expect(runAction).not.toHaveBeenCalled();
      expect(getScoped).not.toHaveBeenCalled();
      return;
    }
    if (mode === "changed-team") {
      await expect(send).rejects.toThrow("authenticated binding scope changed before delivery");
      expect(runAction).not.toHaveBeenCalled();
      return;
    }
    await send;
    expect(getScoped).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        accountId: mode === "explicit-account" ? "explicit-slack" : "slack-admin",
      }),
    );
    expect(runAction).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultAccountId: mode === "explicit-account" ? "explicit-slack" : "slack-admin",
      }),
    );
  });
});
