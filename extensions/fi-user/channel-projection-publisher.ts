import { KeyedAsyncQueue, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { CHANNEL_SESSION } from "./channel-projection-session.js";
import { verifyDetachedProjectionOrigin } from "./detached-projection.js";

type SlackSnapshot = {
  workspaceId: string;
  channelId: string;
  rootMessageId: string;
  memberSenderIds: string[];
  sourcePointerPresent?: boolean;
  sourcePointerCurrent?: boolean;
  messages: Array<{
    messageId: string;
    senderId: string;
    displayName?: string;
    content: string;
    bot: boolean;
  }>;
};

const snapshotQueue = new KeyedAsyncQueue();

export type SlackThreadReader = {
  workspaceId: string;
  botUserId: string;
  readThread: (channelId: string, rootMessageId: string) => Promise<SlackSnapshot>;
  readChannel: (channelId: string) => Promise<SlackChannelScope>;
  postChatPointer?: (input: {
    channelId: string;
    chatUrl: string;
    rootMessageId?: string;
    coversLatest?: boolean;
  }) => Promise<"posted" | "existing" | "skipped">;
};
export type SlackChannelScope = Omit<SlackSnapshot, "rootMessageId" | "messages"> & {
  readThread: (rootMessageId: string) => Promise<SlackSnapshot>;
};

export function isMissingSlackThread(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (typeof current === "string") {
      return /\bthread_not_found\b/i.test(current);
    }
    if (typeof current !== "object") {
      return false;
    }
    const value = current as {
      message?: unknown;
      error?: unknown;
      data?: { error?: unknown };
      response?: { data?: { error?: unknown } };
      cause?: unknown;
    };
    for (const candidate of [
      value.message,
      value.error,
      value.data?.error,
      value.response?.data?.error,
    ]) {
      if (typeof candidate === "string" && /\bthread_not_found\b/i.test(candidate)) {
        return true;
      }
    }
    current = value.cause;
  }
  return false;
}

export type ChannelProjectionParams = {
  api: OpenClawPluginApi;
  sessionKey: string;
  accountId: string;
  requesterSenderId?: string;
  baseUrl: string;
  token: string;
  reconcile?: boolean;
  discover?: boolean;
  projectionRoomId?: string;
  signal?: AbortSignal;
  unavailable?: boolean;
  detachedSource?: {
    provider: "slack";
    workspaceId: string;
    channelId: string;
    rootMessageId: string;
  };
  channelScope?: SlackChannelScope;
  membershipOnly?: boolean;
  /** Periodic full refresh: a failed source read leaves readers untouched. */
  refresh?: boolean;
  onResult?: (status: "created" | "existing" | "skipped") => void;
};

export async function projectSlackChannelThread(params: ChannelProjectionParams): Promise<boolean> {
  const match = params.detachedSource
    ? /^agent:(cellect-fi-user|cellect-fi-admin|cellect-main):slack:(?:channel|group):([cg][a-z0-9]+)$/i.exec(
        params.sessionKey,
      )
    : CHANNEL_SESSION.exec(params.sessionKey);
  const [, rawAgentId, rawChannelId, nativeRoot] = match ?? [];
  const rootMessageId = params.detachedSource?.rootMessageId ?? nativeRoot;
  if (!rawAgentId || !rawChannelId || !rootMessageId) {
    return false;
  }
  const sourceIdentity = {
    agentId: rawAgentId.toLowerCase(),
    channelId: rawChannelId.toUpperCase(),
    rootMessageId,
  };
  const reader = params.unavailable
    ? undefined
    : params.api.runtime.channel.runtimeContexts.get<SlackThreadReader>({
        channelId: "slack",
        accountId: params.accountId,
        capability: "thread-read-projection",
      });
  if (params.detachedSource && !params.unavailable) {
    await verifyDetachedProjectionOrigin(params, sourceIdentity, reader?.workspaceId);
  }
  // Serialize the read as well as delivery: an older snapshot must never arrive
  // after a newer one and delete its replies or restore revoked membership.
  return snapshotQueue.enqueue(
    `${reader?.workspaceId ?? params.projectionRoomId ?? params.accountId}:${sourceIdentity.channelId}:${rootMessageId}`,
    () => publishSlackThreadSnapshot(params, sourceIdentity, reader),
  );
}

async function publishSlackThreadSnapshot(
  params: ChannelProjectionParams,
  sourceIdentity: { agentId: string; channelId: string; rootMessageId: string },
  reader: SlackThreadReader | undefined,
): Promise<boolean> {
  params.signal?.throwIfAborted();
  const { agentId, channelId, rootMessageId } = sourceIdentity;
  const post = async (body: unknown) => {
    const response = await fetch(`${params.baseUrl}/api/openclaw-session-projection`, {
      method: "POST",
      signal: params.signal
        ? AbortSignal.any([params.signal, AbortSignal.timeout(70_000)])
        : AbortSignal.timeout(70_000),
      headers: { authorization: `Bearer ${params.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        ...(body as Record<string, unknown>),
        ...(params.detachedSource ? { sourceDetached: true } : {}),
      }),
    });
    if (!response.ok) {
      throw new Error(`Fi channel projection failed (${response.status})`);
    }
    const result =
      typeof response.json === "function"
        ? ((await response.json()) as { status?: unknown; chatUrl?: unknown })
        : {};
    if (params.onResult) {
      if (
        result.status !== "created" &&
        result.status !== "existing" &&
        result.status !== "skipped"
      ) {
        throw new Error("Invalid Fi projection response status");
      }
      params.onResult(result.status);
    }
    return result;
  };
  let snapshot: SlackSnapshot;
  try {
    if (!reader) {
      throw new Error("Slack thread reader unavailable for this account");
    }
    if (params.membershipOnly && params.channelScope) {
      const { readThread: _readThread, ...source } = params.channelScope;
      await post({
        reconcile: true,
        agentId,
        sessionKey: params.sessionKey,
        source: { ...source, rootMessageId },
      });
      return true;
    }
    snapshot = params.channelScope
      ? await params.channelScope.readThread(rootMessageId)
      : await reader.readThread(channelId, rootMessageId);
  } catch (error) {
    if (params.reconcile && !params.refresh) {
      // Loss of source access removes readers, but must never be interpreted
      // as an empty message snapshot or delete mirrored history.
      await post({
        reconcile: true,
        ...(params.projectionRoomId
          ? { unavailable: true, projectionRoomId: params.projectionRoomId }
          : reader
            ? {
                source: {
                  workspaceId: reader.workspaceId,
                  channelId,
                  rootMessageId,
                  memberSenderIds: [],
                },
              }
            : {}),
        agentId,
        sessionKey: params.sessionKey,
        ...(params.detachedSource
          ? { source: { ...params.detachedSource, memberSenderIds: [] } }
          : {}),
      });
    }
    throw error;
  }
  const requesterSenderId =
    params.requesterSenderId ?? snapshot.messages.find((message) => !message.bot)?.senderId;
  if (
    !params.reconcile &&
    !params.discover &&
    (!requesterSenderId || !snapshot.memberSenderIds.includes(requesterSenderId))
  ) {
    throw new Error("Slack requester is not a current channel member");
  }
  const { messages, ...source } = snapshot;
  const config = params.api.runtime.config?.current?.() ?? params.api.config;
  const botAgents = new Map<string, Set<string>>();
  for (const binding of config?.bindings ?? []) {
    if (
      binding.match.channel !== "slack" ||
      !binding.match.accountId ||
      !["cellect-fi-user", "cellect-fi-admin", "cellect-main"].includes(binding.agentId)
    ) {
      continue;
    }
    const identity = params.api.runtime.channel.runtimeContexts.get<{
      workspaceId: string;
      botUserId: string;
    }>({
      channelId: "slack",
      accountId: binding.match.accountId,
      capability: "thread-read-projection",
    });
    if (!identity || identity.workspaceId !== snapshot.workspaceId || !identity.botUserId) {
      continue;
    }
    const agents = botAgents.get(identity.botUserId) ?? new Set<string>();
    agents.add(binding.agentId);
    botAgents.set(identity.botUserId, agents);
  }
  // Current session is authoritative even when an integration has no account binding.
  if (reader && !botAgents.has(reader.botUserId)) {
    botAgents.set(reader.botUserId, new Set([agentId]));
  }
  if (
    params.detachedSource &&
    !params.reconcile &&
    !messages.some(
      (message) =>
        (message.bot && botAgents.get(message.senderId)?.size === 1) ||
        [...botAgents].some(
          ([botId, agents]) => agents.size === 1 && message.content.includes(`<@${botId}>`),
        ),
    )
  ) {
    params.onResult?.("skipped");
    return true;
  }
  const result = await post({
    requesterSenderId,
    ...(params.reconcile ? { reconcile: true } : {}),
    ...(params.discover ? { discover: true } : {}),
    agentId,
    sessionKey: params.sessionKey,
    source,
    snapshot: {
      complete: true,
      messages: messages.map((message) => ({
        messageId: message.messageId,
        senderId: message.senderId,
        displayName: message.displayName,
        content: message.content,
        role: message.bot ? "assistant" : "user",
        agentId:
          message.bot && botAgents.get(message.senderId)?.size === 1
            ? botAgents.get(message.senderId)?.values().next().value
            : undefined,
      })),
    },
  });
  if (
    (result.status === "created" || result.status === "existing") &&
    typeof result.chatUrl === "string"
  ) {
    try {
      await reader?.postChatPointer?.({
        channelId,
        rootMessageId,
        chatUrl: result.chatUrl,
        coversLatest: snapshot.sourcePointerCurrent,
      });
    } catch (error) {
      params.api.logger.warn(
        `fi-user: slack chat pointer failed channel=${channelId} error=${
          error instanceof Error ? error.message : "unavailable"
        }`,
      );
    }
  }
  return true;
}
