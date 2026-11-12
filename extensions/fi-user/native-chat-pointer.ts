import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { ProjectionInventory } from "./detached-projection.js";

/** A content-free receipt from the current Matrix binding's complete history. */
export type NativeChatActivity = {
  eventId: string;
  originServerTs: number;
  bindingId: string;
  sessionKey: string;
  roomId: string;
  threadRootEventId: string;
  accountId: string;
  environment: string;
  conversationId: string;
  sourceAccountId: string;
  externalSource: {
    provider: string;
    workspaceId: string;
    channelId: string;
    rootMessageId: string;
    peerSenderId?: string;
  };
};
export type NativeChatPointerWriter = {
  workspaceId: string;
  postChatPointer?: (input: {
    channelId: string;
    chatUrl: string;
    rootMessageId?: string;
    nativeEventId: string;
    nativeEventTs: number;
    isCurrent: () => Promise<boolean>;
  }) => Promise<"posted" | "updated" | "existing" | "skipped">;
};

/** Projection creation and Slack activity alone never produce a notification. */
export async function publishNativeChatPointer(params: {
  api: OpenClawPluginApi;
  sessionKey: string;
  accountId: string;
  channelId: string;
  rootMessageId?: string;
  chatUrl: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { api } = params;
  const configuration = api.runtime.config?.current?.() ?? api.config;
  const inventory = api.runtime.channel.runtimeContexts.get<ProjectionInventory>({
    channelId: "matrix",
    capability: "session-read-projections",
  });
  const reader = api.runtime.channel.runtimeContexts.get<NativeChatPointerWriter>({
    channelId: "slack",
    accountId: params.accountId,
    capability: "thread-read-projection",
  });
  if (!inventory?.plan || !reader?.postChatPointer || params.signal?.aborted) {
    return;
  }
  const candidates = (await inventory.list()).filter(
    (binding) =>
      binding.sessionKey === params.sessionKey &&
      binding.sourceAccountId === params.accountId &&
      binding.externalSource?.provider === "slack" &&
      binding.externalSource.workspaceId === reader.workspaceId &&
      binding.externalSource.channelId === params.channelId &&
      (!params.rootMessageId || binding.externalSource.rootMessageId === params.rootMessageId),
  );
  if (candidates.length !== 1) {
    return;
  }
  const binding = candidates[0]!;
  const activity = (await inventory.plan(binding.roomId)).nativeActivity;
  if (
    !activity ||
    activity.sessionKey !== params.sessionKey ||
    activity.roomId !== binding.roomId ||
    activity.sourceAccountId !== params.accountId ||
    activity.externalSource.provider !== "slack" ||
    activity.externalSource.workspaceId !== reader.workspaceId ||
    activity.externalSource.channelId !== params.channelId ||
    (params.rootMessageId && activity.externalSource.rootMessageId !== params.rootMessageId) ||
    new URL(params.chatUrl).searchParams.get("fiConversation") !== activity.conversationId
  ) {
    return;
  }
  const result = await reader.postChatPointer({
    channelId: params.channelId,
    rootMessageId: params.rootMessageId,
    chatUrl: params.chatUrl,
    nativeEventId: activity.eventId,
    nativeEventTs: activity.originServerTs,
    isCurrent: async () => {
      if (
        params.signal?.aborted ||
        (api.runtime.config?.current?.() ?? api.config) !== configuration ||
        api.runtime.channel.runtimeContexts.get({
          channelId: "matrix",
          capability: "session-read-projections",
        }) !== inventory ||
        api.runtime.channel.runtimeContexts.get({
          channelId: "slack",
          accountId: params.accountId,
          capability: "thread-read-projection",
        }) !== reader
      ) {
        return false;
      }
      const current = (await inventory.list()).find(
        (candidate) => candidate.roomId === binding.roomId,
      );
      if (!current || JSON.stringify(current) !== JSON.stringify(binding)) {
        return false;
      }
      const latest = (await inventory.plan!(binding.roomId)).nativeActivity;
      return (
        !params.signal?.aborted &&
        (api.runtime.config?.current?.() ?? api.config) === configuration &&
        latest !== undefined &&
        latest.originServerTs >= activity.originServerTs &&
        JSON.stringify({
          ...latest,
          eventId: activity.eventId,
          originServerTs: activity.originServerTs,
        }) === JSON.stringify(activity) &&
        api.runtime.channel.runtimeContexts.get({
          channelId: "matrix",
          capability: "session-read-projections",
        }) === inventory &&
        api.runtime.channel.runtimeContexts.get({
          channelId: "slack",
          accountId: params.accountId,
          capability: "thread-read-projection",
        }) === reader
      );
    },
  });
  if (result === "skipped") {
    throw new Error("Native chat pointer publication deferred");
  }
}
