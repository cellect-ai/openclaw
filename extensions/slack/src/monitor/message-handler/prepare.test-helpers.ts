// Slack helper module supports prepare helpers behavior.
import fs from "node:fs/promises";
import path from "node:path";
import type { App } from "@slack/bolt";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach } from "vitest";
import type { ResolvedSlackAccount } from "../../accounts.js";
import { installSlackTestRuntime } from "../../test-runtime.test-support.js";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackChannelConfigEntries } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import { createMonitorTestContext } from "../monitor-context.test-support.js";
import { prepareSlackMessage } from "./prepare.js";

export function createInboundSlackTestContext(params: {
  accountId?: string;
  app?: App;
  cfg: OpenClawConfig;
  appClient?: App["client"];
  defaultRequireMention?: boolean;
  replyToMode?: "off" | "all" | "first" | "batched";
  channelsConfig?: SlackChannelConfigEntries;
  dmHistoryLimit?: number;
  groupDmEnabled?: boolean;
  groupPolicy?: "open" | "disabled" | "allowlist";
  channelRuntime?: ChannelRuntimeSurface;
}) {
  const runtime = installSlackTestRuntime({
    channel: { inbound: { buildContext: buildChannelInboundEventContext } },
  });
  return createMonitorTestContext({
    cfg: params.cfg,
    accountId: params.accountId ?? "default",
    botToken: "token",
    app: params.app ?? ({ client: params.appClient ?? {} } as App),
    channelRuntime: params.channelRuntime ?? runtime.channel,
    botUserId: "B1",
    botId: "B1",
    teamId: "T1",
    apiAppId: "A1",
    dmHistoryLimit: params.dmHistoryLimit ?? 0,
    allowFrom: ["*"],
    groupDmEnabled: params.groupDmEnabled ?? true,
    defaultRequireMention: params.defaultRequireMention ?? true,
    channelsConfig: params.channelsConfig,
    groupPolicy: params.groupPolicy ?? "open",
    replyToMode: params.replyToMode ?? "off",
    slashCommand: {
      enabled: false,
      name: "openclaw",
      sessionPrefix: "slack:slash",
      ephemeral: true,
    },
    mediaMaxBytes: 1024,
  });
}

export function createSlackTestAccount(
  config: ResolvedSlackAccount["config"] = {},
): ResolvedSlackAccount {
  return {
    accountId: "default",
    enabled: true,
    identity: "bot",
    botTokenSource: "config",
    appTokenSource: "config",
    userTokenSource: "none",
    config,
    replyToMode: config.replyToMode,
    replyToModeByChatType: config.replyToModeByChatType,
    dm: config.dm,
  };
}

export function createSlackSessionStoreFixture(prefix: string) {
  const sessionDirs = useSessionStoreTempDirs(afterAll, prefix);

  return {
    makeTmpStorePath() {
      const dir = sessionDirs.make();
      return { dir, storePath: path.join(dir, "sessions.json") };
    },
  };
}

const mediaPaths = new Set<string>();
export function trackMedia(media: ReadonlyArray<{ path?: string }>) {
  for (const item of media) {
    if (item.path) {
      mediaPaths.add(item.path);
    }
  }
}
afterEach(async () => {
  await Promise.all([...mediaPaths].map((path) => fs.rm(path, { force: true })));
  mediaPaths.clear();
});
export function slackConfig(
  slack: ResolvedSlackAccount["config"] = {},
  extra: OpenClawConfig = {},
): OpenClawConfig {
  return { ...extra, channels: { slack: { enabled: true, ...slack } } };
}

export async function prepareInbound(
  ctx: SlackMonitorContext,
  message: Partial<SlackMessageEvent>,
  account: ResolvedSlackAccount = createSlackTestAccount(),
  opts: Parameters<typeof prepareSlackMessage>[0]["opts"] = { source: "message" },
) {
  const prepared = await prepareSlackMessage({
    ctx,
    account,
    message: createSlackMessage(message),
    opts,
  });
  trackMedia(prepared?.ctxPayload.media ?? []);
  return prepared;
}

export function createSlackMessage(overrides: Partial<SlackMessageEvent>): SlackMessageEvent {
  return {
    type: "message",
    channel: "D123",
    channel_type: "im",
    user: "U1",
    text: "hi",
    ts: "1.000",
    ...overrides,
  };
}
