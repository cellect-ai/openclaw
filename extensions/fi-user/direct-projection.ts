import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  getSessionEntry,
  listSessionKeys,
  sessionDeliveryOrigin,
} from "openclaw/plugin-sdk/session-store-runtime";
import { RECONCILE_HISTORY_BATCH_SIZE, takeSweepBatch } from "./reconciliation-batch.js";

const DIRECT_SESSION =
  /^agent:(cellect-fi-user|cellect-fi-admin|cellect-main):slack:direct:([uw][a-z0-9]+)$/i;

export function isSlackDirectSessionKey(sessionKey: string): boolean {
  return DIRECT_SESSION.test(sessionKey);
}
type DirectReader = {
  botUserId: string;
  readDirect: (
    channelId: string,
    peerSenderId: string,
  ) => Promise<{
    directSource: { workspaceId: string; channelId: string; peerSenderId: string };
    messages: Array<{
      messageId: string;
      senderId: string;
      displayName?: string;
      content: string;
      bot: boolean;
    }>;
  }>;
};

/** Operator recovery uses a canonical app source hint, never an inferred DM channel. */
export async function recoverSlackDirectProjection(
  api: OpenClawPluginApi,
  connection: { baseUrl: string; token: string },
  sessionKey: string,
  hint: unknown,
) {
  const [, agentId, peer] = DIRECT_SESSION.exec(sessionKey) ?? [];
  if (
    !agentId ||
    !peer ||
    !hint ||
    typeof hint !== "object" ||
    !("workspaceId" in hint) ||
    !("channelId" in hint) ||
    !("peerSenderId" in hint) ||
    typeof hint.workspaceId !== "string" ||
    typeof hint.channelId !== "string" ||
    hint.peerSenderId !== peer.toUpperCase()
  ) {
    throw new Error("Exact canonical direct source required");
  }
  const directSource = {
    workspaceId: hint.workspaceId,
    channelId: hint.channelId,
    peerSenderId: peer.toUpperCase(),
  };
  const guard = api.runtime.channel.runtimeContexts.get<{
    resolveSource: (params: {
      targetSessionKey: string;
      externalSource: typeof directSource & { provider: string; rootMessageId: string };
    }) => Promise<{ sourceAccountId: string }>;
  }>({ channelId: "matrix", capability: "source-session-authorization" });
  if (!guard) {
    throw new Error("Source authorization is unavailable");
  }
  const verified = await guard.resolveSource({
    targetSessionKey: sessionKey,
    externalSource: { provider: "slack", ...directSource, rootMessageId: sessionKey },
  });
  const reader = api.runtime.channel.runtimeContexts.get<DirectReader>({
    channelId: "slack",
    accountId: verified.sourceAccountId,
    capability: "thread-read-projection",
  });
  if (!reader) {
    throw new Error("Direct source reader unavailable");
  }
  const source = await reader.readDirect(directSource.channelId, directSource.peerSenderId);
  const response = await fetch(`${connection.baseUrl}/api/openclaw-session-projection`, {
    method: "POST",
    signal: AbortSignal.timeout(70_000),
    headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      discover: true,
      agentId,
      sessionKey,
      directSource: source.directSource,
      snapshot: {
        complete: true,
        messages: source.messages.map((message) => ({
          messageId: message.messageId,
          senderId: message.senderId,
          displayName: message.displayName,
          content: message.content,
          role: message.bot ? "assistant" : "user",
          agentId: message.bot && message.senderId === reader.botUserId ? agentId : undefined,
        })),
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Fi direct recovery failed (${response.status})`);
  }
  const result: unknown = await response.json();
  if (
    !result ||
    typeof result !== "object" ||
    !("status" in result) ||
    !["created", "existing", "skipped"].includes(String(result.status))
  ) {
    throw new Error("Invalid Fi direct recovery result");
  }
  return { status: result.status };
}

/** Native direct sessions remain one conversation per agent/account/peer, not per message. */
export async function reconcileSlackDirectProjections(
  api: OpenClawPluginApi,
  connection: { baseUrl: string; token: string },
  bindings: Array<{
    sessionKey: string;
    roomId: string;
    sourceAccountId?: string;
    externalSource?: { channelId: string; peerSenderId?: string };
  }>,
  signal: AbortSignal,
  sweepSeen = new Set<string>(),
  limit = RECONCILE_HISTORY_BATCH_SIZE,
  prioritySessionKey?: string,
  /** Sessions with an outcome since the gateway started; the rest are backlog. */
  reconciled?: Set<string>,
) {
  const config = api.runtime.config?.current?.() ?? api.config;
  const configured = (config?.bindings ?? []).filter(
    (binding) =>
      binding.match.channel === "slack" &&
      ["cellect-fi-user", "cellect-fi-admin", "cellect-main"].includes(binding.agentId) &&
      binding.match.accountId &&
      binding.match.accountId !== "*",
  );
  const sessions = new Set(
    bindings
      .filter((binding) => DIRECT_SESSION.test(binding.sessionKey))
      .map((binding) => binding.sessionKey),
  );
  for (const agentId of new Set(configured.map((binding) => binding.agentId))) {
    for (const sessionKey of await listSessionKeys({ agentId })) {
      if (DIRECT_SESSION.test(sessionKey)) {
        sessions.add(sessionKey);
      }
    }
  }
  if (prioritySessionKey && isSlackDirectSessionKey(prioritySessionKey)) {
    sessions.add(prioritySessionKey);
  }
  const sessionKeys = [...sessions].toSorted();
  if (reconciled) {
    for (const sessionKey of reconciled) {
      if (!sessions.has(sessionKey)) {
        reconciled.delete(sessionKey);
      }
    }
  }
  const unreconciled = () =>
    reconciled ? sessionKeys.filter((sessionKey) => !reconciled.has(sessionKey)) : [];
  const backlog = unreconciled();
  const scheduled =
    prioritySessionKey && sessions.has(prioritySessionKey)
      ? [prioritySessionKey]
      : backlog.length
        ? backlog.slice(0, limit)
        : takeSweepBatch(sessionKeys, sweepSeen, limit);
  const report = {
    scanned: sessions.size,
    // Re-snapshotting a DM that already has an outcome is rotation, not
    // backlog: counting it kept the reconciler on its one-second cadence
    // whenever more than one DM existed.
    pending: 0,
    created: 0,
    existing: 0,
    skipped: 0,
    error: 0,
  };
  const post = async (body: unknown) => {
    const response = await fetch(`${connection.baseUrl}/api/openclaw-session-projection`, {
      method: "POST",
      headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(70_000)]),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Fi direct projection failed (${response.status})`);
    }
    const result = (await response.json()) as { status?: unknown };
    if (
      result.status !== "created" &&
      result.status !== "existing" &&
      result.status !== "skipped"
    ) {
      throw new Error("Invalid Fi direct projection result");
    }
    return result.status;
  };
  for (const sessionKey of scheduled) {
    signal.throwIfAborted();
    const [, agentId, rawPeer] = DIRECT_SESSION.exec(sessionKey) ?? [];
    if (!agentId || !rawPeer) {
      continue;
    }
    const peerSenderId = rawPeer.toUpperCase();
    const binding = bindings.find((candidate) => candidate.sessionKey === sessionKey);
    try {
      const entry = getSessionEntry({ agentId, sessionKey, readConsistency: "latest" });
      const origin = sessionDeliveryOrigin(entry);
      const accountId = binding?.sourceAccountId ?? origin?.accountId;
      const channelId = binding?.sourceAccountId
        ? binding.externalSource?.channelId
        : origin?.nativeChannelId;
      const allowed = configured.some(
        (candidate) =>
          candidate.agentId === agentId &&
          candidate.match.accountId === accountId &&
          (!candidate.match.peer || candidate.match.peer.id.toUpperCase() === peerSenderId),
      );
      if (!entry || !allowed || !accountId || !channelId?.startsWith("D")) {
        throw new Error("Direct source identity unavailable");
      }
      const reader = api.runtime.channel.runtimeContexts.get<DirectReader>({
        channelId: "slack",
        accountId,
        capability: "thread-read-projection",
      });
      if (!reader) {
        throw new Error("Direct source reader unavailable");
      }
      const source = await reader.readDirect(channelId, peerSenderId);
      const status = await post({
        discover: true,
        agentId,
        sessionKey,
        directSource: source.directSource,
        snapshot: {
          complete: true,
          messages: source.messages.map((message) => ({
            messageId: message.messageId,
            senderId: message.senderId,
            displayName: message.displayName,
            content: message.content,
            role: message.bot ? "assistant" : "user",
            agentId: message.bot && message.senderId === reader.botUserId ? agentId : undefined,
          })),
        },
      });
      report[status]++;
    } catch (error) {
      report.error++;
      if (binding) {
        await post({
          reconcile: true,
          unavailable: true,
          projectionRoomId: binding.roomId,
          agentId,
          sessionKey,
        }).catch(() => {
          api.logger.warn(
            `fi-user: failed to revoke unavailable direct projection session=${sessionKey}`,
          );
        });
      }
      api.logger.warn(
        `fi-user: direct projection session=${sessionKey} failed (${error instanceof Error ? error.message.replace(/xox[baprs]-\S+/g, "[redacted]").slice(0, 150) : "unknown"})`,
      );
    }
    reconciled?.add(sessionKey);
  }
  report.pending = unreconciled().length;
  return report;
}
