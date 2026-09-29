import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { getSessionEntry, sessionDeliveryOrigin } from "openclaw/plugin-sdk/session-store-runtime";

type Source = {
  provider: string;
  workspaceId: string;
  channelId: string;
  rootMessageId: string;
  peerSenderId?: string;
};
type SourceBinding = {
  targetSessionKey: string;
  externalSource?: Source;
  sourceAccountId?: string;
};
type Reader = {
  workspaceId: string;
  readChannel: (
    channelId: string,
  ) => Promise<{ workspaceId: string; channelId: string; memberSenderIds: string[] }>;
  readDirectIdentity: (
    channelId: string,
    peerSenderId: string,
  ) => Promise<{ workspaceId: string; channelId: string; peerSenderId: string }>;
};

/** The app owns grants; Slack owns source membership; neither is inferred from Matrix membership. */
export function registerSourceReplyAuthorization(
  api: OpenClawPluginApi,
  connection: () => { baseUrl: string; token?: string },
) {
  const resolveSource = async (
    params: SourceBinding,
  ): Promise<{ externalSource: Source; sourceAccountId: string; memberSenderIds?: string[] }> => {
    const match =
      /^agent:(cellect-fi-user|cellect-fi-admin|cellect-main):slack:(channel|group|direct):([a-z0-9]+)(?::thread:(\d+\.\d+))?$/i.exec(
        params.targetSessionKey,
      );
    const [, agentId, kind, nativeId, root] = match ?? [];
    if (!agentId || !kind || !nativeId) {
      throw new Error("Unsupported source session");
    }
    const entry = getSessionEntry({
      agentId,
      sessionKey: params.targetSessionKey,
      readConsistency: "latest",
    });
    const origin = sessionDeliveryOrigin(entry);
    const config = api.runtime.config?.current?.() ?? api.config;
    const accounts = new Set(
      config.bindings
        ?.filter(
          (binding) =>
            binding.agentId === agentId &&
            binding.match.channel === "slack" &&
            binding.match.accountId &&
            binding.match.accountId !== "*" &&
            (!binding.match.peer || binding.match.peer.id.toUpperCase() === nativeId.toUpperCase()),
        )
        .map((binding) => binding.match.accountId),
    );
    // Older writable DMs could replace native delivery origin with Matrix before
    // source metadata existed. Recover only from the app's canonical DM identity.
    const legacyDirect =
      !params.sourceAccountId &&
      origin?.provider !== "slack" &&
      kind === "direct" &&
      Boolean(params.externalSource);
    const accountId =
      params.sourceAccountId ??
      (origin?.provider === "slack"
        ? origin.accountId
        : legacyDirect && accounts.size === 1
          ? [...accounts][0]
          : undefined);
    if (!entry) {
      throw new Error("Source session is unavailable");
    }
    if (!accountId) {
      throw new Error("Source account identity is unavailable");
    }
    if (!accounts.has(accountId)) {
      throw new Error("Source account is not authorized for this agent");
    }
    const reader = api.runtime.channel.runtimeContexts.get<Reader>({
      channelId: "slack",
      accountId,
      capability: "thread-read-projection",
    });
    if (!reader) {
      throw new Error("Source account reader is unavailable");
    }
    const source = params.externalSource;
    // A legacy binding predates `sourceAccountId`, so the channel it may act
    // for is otherwise taken from the delivery origin, which later traffic can
    // move. A channel thread session names its channel in the key itself.
    const legacyChannelId =
      !params.sourceAccountId && kind === "channel" && root ? nativeId : origin?.nativeChannelId;
    const channelId = source?.channelId ?? legacyChannelId;
    if (
      !channelId ||
      (source && (source.provider !== "slack" || source.workspaceId !== reader.workspaceId))
    ) {
      throw new Error("Source workspace mismatch");
    }
    if (
      !params.sourceAccountId &&
      !legacyDirect &&
      legacyChannelId?.toUpperCase() !== channelId.toUpperCase()
    ) {
      throw new Error("Source origin mismatch");
    }
    if (kind === "direct") {
      const peerSenderId = nativeId.toUpperCase();
      if (
        source &&
        (source.peerSenderId !== peerSenderId || source.rootMessageId !== params.targetSessionKey)
      ) {
        throw new Error("Source direct identity mismatch");
      }
      const directSource = await reader.readDirectIdentity(channelId, peerSenderId);
      return {
        externalSource: {
          provider: "slack",
          ...directSource,
          rootMessageId: params.targetSessionKey,
        },
        sourceAccountId: accountId,
      };
    }
    const rootMessageId = root ?? source?.rootMessageId;
    if (
      !rootMessageId ||
      !/^\d+\.\d+$/.test(rootMessageId) ||
      channelId.toUpperCase() !== nativeId.toUpperCase() ||
      (source && source.rootMessageId !== rootMessageId)
    ) {
      throw new Error("Source channel identity mismatch");
    }
    const channel = await reader.readChannel(channelId.toUpperCase());
    return {
      externalSource: {
        provider: "slack",
        workspaceId: channel.workspaceId,
        channelId: channel.channelId,
        rootMessageId,
      },
      sourceAccountId: accountId,
      memberSenderIds: channel.memberSenderIds,
    };
  };
  api.runtime.channel.runtimeContexts.register({
    channelId: "matrix",
    capability: "source-session-authorization",
    context: {
      protocol: "fi-v1",
      resolveSource,
      authorize: async (params: {
        binding: SourceBinding;
        matrixRoomId: string;
        matrixSenderId: string;
      }) => {
        const credentials = connection();
        if (!credentials.token) {
          return "unavailable";
        }
        const verified = await resolveSource(params.binding);
        const source = verified.externalSource;
        const response = await fetch(
          `${credentials.baseUrl}/api/openclaw-session-projection/authorize`,
          {
            method: "POST",
            signal: AbortSignal.timeout(15_000),
            headers: {
              authorization: `Bearer ${credentials.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              matrixRoomId: params.matrixRoomId,
              matrixSenderId: params.matrixSenderId,
              sessionKey: params.binding.targetSessionKey,
              agentId: params.binding.targetSessionKey.split(":")[1],
              ...(source.peerSenderId
                ? {
                    directSource: {
                      workspaceId: source.workspaceId,
                      channelId: source.channelId,
                      peerSenderId: source.peerSenderId,
                    },
                  }
                : {
                    source: {
                      workspaceId: source.workspaceId,
                      channelId: source.channelId,
                      rootMessageId: source.rootMessageId,
                      memberSenderIds: verified.memberSenderIds,
                    },
                  }),
            }),
          },
        );
        if (response.status === 403) {
          return "denied";
        }
        if (!response.ok) {
          return "unavailable";
        }
        const result: unknown = await response.json();
        return result &&
          typeof result === "object" &&
          "allowed" in result &&
          result.allowed === true
          ? "allowed"
          : "denied";
      },
    },
  });
}
