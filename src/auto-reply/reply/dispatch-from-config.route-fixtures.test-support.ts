import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { mockPluginBinding } from "./dispatch-from-config.shared.test-harness.js";
import { buildTestCtx } from "./test-ctx.js";

export function createThreadedSlackContext(
  sessionKey: string,
  body: string,
  overrides: Partial<MsgContext> = {},
) {
  return buildTestCtx({
    Provider: "slack",
    Surface: "slack",
    SessionKey: sessionKey,
    ParentSessionKey: "agent:main:slack:channel:c1",
    Body: body,
    CommandBody: body,
    RawBody: body,
    InboundAccessAuthorized: true,
    InboundEventKind: "user_request",
    InputProvenance: { kind: "external_user", sourceChannel: "slack" },
    ...overrides,
  });
}

export function createArchivedDiscordContext(to: string, sessionKey: string) {
  return buildTestCtx({
    Provider: "discord",
    Surface: "discord",
    OriginatingChannel: "discord",
    OriginatingTo: to,
    ChatType: "channel",
    From: "discord:user:12345",
    To: to,
    AccountId: "default",
    SessionKey: sessionKey,
    Body: "start work",
    CommandBody: "start work",
    RawBody: "start work",
    CommandSource: undefined,
    InboundAccessAuthorized: true,
    InboundEventKind: "user_request",
    InputProvenance: { kind: "external_user", sourceChannel: "discord" },
  });
}

export function groupSilenceConfig(group: "allow" | "disallow"): OpenClawConfig {
  return { agents: { defaults: { silentReply: { group } } } };
}

export function createMentionedGroupContext(channel: "telegram" | "feishu" = "telegram") {
  return buildTestCtx({
    ChatType: "group",
    Surface: channel,
    Provider: channel,
    SessionKey: `agent:main:${channel}:group:oc_group`,
    WasMentioned: true,
  });
}

export function mockTelegramTopicPluginBinding(bindingId: string) {
  mockPluginBinding({
    bindingId,
    targetSessionKey: "plugin-binding:codex:abc123",
    conversation: {
      channel: "telegram",
      accountId: "default",
      conversationId: "-1001234567890:topic:11",
      parentConversationId: "-1001234567890",
    },
    pluginRoot: "/tmp/plugin",
  });
}

export function createTelegramTopicContext(overrides: Partial<MsgContext>) {
  return buildTestCtx({
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: "telegram:-1001234567890",
    To: "telegram:-1001234567890",
    AccountId: "default",
    MessageThreadId: 11,
    ChatType: "group",
    GroupSubject: "Dev",
    WasMentioned: false,
    ...overrides,
  });
}

export function crossChannelGroupContext() {
  return buildTestCtx({
    ChatType: "group",
    Surface: "slack",
    Provider: "slack",
    OriginatingChannel: "telegram",
    OriginatingTo: "telegram:999",
    SessionKey: "agent:main:slack:group:oc_group",
    WasMentioned: true,
  });
}
