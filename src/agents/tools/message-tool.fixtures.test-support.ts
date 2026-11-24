import { markInboundContextLabel } from "../../auto-reply/reply/inbound-context-marker.js";
import type { ChannelMessageAdapterShape } from "../../channels/message/types.js";
import type { ChannelMessageCapability } from "../../channels/plugins/message-capabilities.js";
import type {
  ChannelMessageActionName,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import type { MessageActionResult } from "../../infra/outbound/message-action-contracts.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createMessageTool } from "./message-tool-execution.js";

export type CreateMessageTool = typeof createMessageTool;

export type DescribeMessageTool = NonNullable<
  NonNullable<ChannelPlugin["actions"]>["describeMessageTool"]
>;

export type MessageToolDiscoveryContext = Parameters<DescribeMessageTool>[0];

export type MessageToolSchema = NonNullable<ReturnType<DescribeMessageTool>>["schema"];

export function makeSendResult(
  overrides: Partial<Extract<MessageActionResult, { kind: "send" }>> = {},
): MessageActionResult {
  return {
    kind: "send",
    action: "send",
    channel: "telegram",
    to: "telegram:123",
    handledBy: "plugin",
    payload: {},
    dryRun: true,
    ...overrides,
  };
}

export function getToolProperties(tool: ReturnType<CreateMessageTool>) {
  return (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
}

export function getActionEnum(properties: Record<string, unknown>) {
  return (properties.action as { enum?: string[] } | undefined)?.enum ?? [];
}

export const secretRef = (id: string) => ({ source: "env", provider: "default", id });

export const channelConfig = (channel: string, config: Record<string, unknown>) => ({
  channels: { [channel]: config },
});

export const accountSecrets = (field: string, entries: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(entries).map(([id, value]) => [id, { [field]: value }]));

export const inboundMetadata = (label: string, value: Record<string, unknown>) =>
  [markInboundContextLabel(label), "```json", JSON.stringify(value), "```"].join("\n");

export function createChannelPlugin(params: {
  id: string;
  actions?: ChannelMessageActionName[];
  capabilities?: readonly ChannelMessageCapability[];
  toolSchema?: MessageToolSchema | ((params: MessageToolDiscoveryContext) => MessageToolSchema);
  describeMessageTool?: DescribeMessageTool;
  messageActionTargetAliases?: NonNullable<ChannelPlugin["actions"]>["messageActionTargetAliases"];
  config?: Partial<ChannelPlugin["config"]>;
  message?: ChannelMessageAdapterShape;
  messaging?: ChannelPlugin["messaging"];
  outbound?: ChannelPlugin["outbound"];
}): ChannelPlugin & { actions: NonNullable<ChannelPlugin["actions"]> } {
  return {
    ...createChannelTestPluginBase({
      id: params.id as ChannelPlugin["id"],
      capabilities: { chatTypes: ["direct", "group"], media: true },
      config: params.config,
    }),
    ...(params.message ? { message: params.message } : {}),
    ...(params.messaging ? { messaging: params.messaging } : {}),
    ...(params.outbound ? { outbound: params.outbound } : {}),
    actions: {
      describeMessageTool:
        params.describeMessageTool ??
        ((ctx) => {
          const schema =
            typeof params.toolSchema === "function" ? params.toolSchema(ctx) : params.toolSchema;
          return {
            actions: params.actions ?? [],
            capabilities: params.capabilities,
            ...(schema ? { schema } : {}),
          };
        }),
      messageActionTargetAliases: params.messageActionTargetAliases,
    },
  };
}

export function registerPlugins(...plugins: ChannelPlugin[]) {
  setActivePluginRegistry(
    createTestRegistry(plugins.map((plugin) => ({ pluginId: plugin.id, source: "test", plugin }))),
  );
}

export function registerMessagingPlugin(
  id: string,
  messaging: NonNullable<ChannelPlugin["messaging"]>,
) {
  registerPlugins(createChannelPlugin({ id, messaging }));
}

export function createQaChannelSendResult(
  params: Record<string, unknown> | undefined,
  callIndex: number,
): MessageActionResult {
  return {
    kind: "send",
    action: "send",
    channel: "qa-channel",
    to: typeof params?.target === "string" ? params.target : "channel:loop-room",
    handledBy: "plugin",
    payload: {
      message: {
        id: `qa-message-${callIndex}`,
        accountId: "default",
        direction: "outbound",
        conversation: { id: "loop-room", chatType: "channel" },
        senderId: "openclaw",
        text: "same visible reply",
        timestamp: 1_800_000_000_000 + callIndex,
      },
    },
    dryRun: false,
  } satisfies MessageActionResult;
}

export const EMPTY_PREPARED_MESSAGE_TOOL_CATALOG = {
  version: 0,
  channels: [],
  getChannel: () => undefined,
} as const;
