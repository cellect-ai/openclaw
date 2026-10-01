import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  getSessionEntry,
  listSessionKeys,
  sessionDeliveryOrigin,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  directRetryDelay,
  RECONCILE_HISTORY_BATCH_SIZE,
  takeSweepBatch,
} from "./reconciliation-batch.js";

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
    sourcePointerPresent?: boolean;
    sourcePointerCurrent?: boolean;
    messages: Array<{
      messageId: string;
      senderId: string;
      displayName?: string;
      content: string;
      bot: boolean;
    }>;
  }>;
  postChatPointer?: (input: {
    channelId: string;
    chatUrl: string;
    rootMessageId?: string;
    coversLatest?: boolean;
  }) => Promise<"posted" | "existing" | "skipped">;
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
  if (
    (result.status === "created" || result.status === "existing") &&
    "chatUrl" in result &&
    typeof result.chatUrl === "string"
  ) {
    try {
      await reader.postChatPointer?.({
        channelId: directSource.channelId,
        chatUrl: result.chatUrl,
        coversLatest: source.sourcePointerCurrent,
      });
    } catch {
      // Recovery still succeeded; the next DM snapshot retries the pointer.
    }
  }
  return { status: result.status };
}

/** Native direct sessions remain one conversation per agent/account/peer, not per message. */
/** DM reconciliation state that outlives one pass. */
export type DirectProjectionBacklog = {
  /** Snapshotted successfully since start; only these rotate on the idle cadence. */
  reconciled: Set<string>;
  /**
   * `identity` marks a deterministic failure (no session, binding, account or
   * DM channel): it is not retried until those inputs change or the DM wakes.
   */
  failed: Map<string, { failures: number; retryAt: number; identity?: string }>;
  /** Last seen Slack socket connect time per account. */
  connectedAt: Map<string, number>;
};

export function createDirectProjectionBacklog(): DirectProjectionBacklog {
  return { reconciled: new Set(), failed: new Map(), connectedAt: new Map() };
}

/** Live activity in a DM makes it due now, whatever its earlier failures. */
export function markDirectActive(backlog: DirectProjectionBacklog, sessionKey: string) {
  backlog.reconciled.delete(sessionKey);
  backlog.failed.delete(sessionKey);
}

/**
 * Socket Mode drops DMs sent while disconnected. When a Slack account's socket
 * reconnects, every DM is due again once, on the backlog cadence.
 */
export function noteSlackSocketReconnects(
  api: OpenClawPluginApi,
  bindings: ReadonlyArray<{ match: { accountId?: string } }>,
  backlog: DirectProjectionBacklog,
) {
  for (const accountId of new Set(bindings.map((binding) => binding.match.accountId ?? ""))) {
    const connectedAt = api.runtime.channel.runtimeContexts
      .get<{ socketConnectedAt?: () => number | undefined }>({
        channelId: "slack",
        accountId,
        capability: "thread-read-projection",
      })
      ?.socketConnectedAt?.();
    const previous = backlog.connectedAt.get(accountId);
    if (connectedAt !== undefined && connectedAt !== previous) {
      backlog.connectedAt.set(accountId, connectedAt);
      if (previous !== undefined) {
        backlog.reconciled.clear();
      }
    }
  }
}

/** The DM cannot be resolved from its session and bindings; retrying cannot help. */
class DirectIdentityUnavailable extends Error {
  constructor(readonly identity: string) {
    super("Direct source identity unavailable");
  }
}

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
  backlog?: DirectProjectionBacklog,
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
  if (backlog) {
    for (const sessionKey of backlog.reconciled) {
      if (!sessions.has(sessionKey)) {
        backlog.reconciled.delete(sessionKey);
      }
    }
    for (const sessionKey of backlog.failed.keys()) {
      if (!sessions.has(sessionKey)) {
        backlog.failed.delete(sessionKey);
      }
    }
  }
  const resolveIdentity = (sessionKey: string) => {
    const [, agentId, rawPeer] = DIRECT_SESSION.exec(sessionKey) ?? [];
    if (!agentId || !rawPeer) {
      return undefined;
    }
    const peerSenderId = rawPeer.toUpperCase();
    const binding = bindings.find((candidate) => candidate.sessionKey === sessionKey);
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
    return {
      agentId,
      peerSenderId,
      binding,
      accountId,
      channelId,
      usable: Boolean(entry && allowed && accountId && channelId?.startsWith("D")),
      fingerprint: JSON.stringify([Boolean(entry), accountId, channelId, allowed]),
    };
  };
  // Due work: never snapshotted since start, a transient failure whose backoff
  // has expired, or a deterministic failure whose inputs have since changed.
  const retryDue = (sessionKey: string) => {
    const failed = backlog?.failed.get(sessionKey);
    if (!failed) {
      return true;
    }
    return failed.identity !== undefined
      ? resolveIdentity(sessionKey)?.fingerprint !== failed.identity
      : Date.now() >= failed.retryAt;
  };
  const due = () =>
    backlog
      ? sessionKeys.filter(
          (sessionKey) => !backlog.reconciled.has(sessionKey) && retryDue(sessionKey),
        )
      : [];
  const pending = due();
  const scheduled =
    prioritySessionKey && sessions.has(prioritySessionKey)
      ? [prioritySessionKey]
      : pending.length
        ? pending.slice(0, limit)
        : takeSweepBatch(
            backlog
              ? sessionKeys.filter((sessionKey) => backlog.reconciled.has(sessionKey))
              : sessionKeys,
            sweepSeen,
            limit,
          );
  const report = {
    scanned: sessions.size,
    // Re-snapshotting a DM that was already snapshotted is rotation, not
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
    const result = (await response.json()) as { status?: unknown; chatUrl?: unknown };
    if (
      result.status !== "created" &&
      result.status !== "existing" &&
      result.status !== "skipped"
    ) {
      throw new Error("Invalid Fi direct projection result");
    }
    return result as { status: "created" | "existing" | "skipped"; chatUrl?: unknown };
  };
  for (const sessionKey of scheduled) {
    signal.throwIfAborted();
    const [, agentId, rawPeer] = DIRECT_SESSION.exec(sessionKey) ?? [];
    if (!agentId || !rawPeer) {
      continue;
    }
    const binding = bindings.find((candidate) => candidate.sessionKey === sessionKey);
    try {
      const identity = resolveIdentity(sessionKey);
      const { peerSenderId, accountId, channelId } = identity ?? {};
      if (!identity?.usable || !peerSenderId || !accountId || !channelId) {
        throw new DirectIdentityUnavailable(identity?.fingerprint ?? "");
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
      const result = await post({
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
      const status = result.status;
      if ((status === "created" || status === "existing") && typeof result.chatUrl === "string") {
        try {
          await reader.postChatPointer?.({
            channelId,
            chatUrl: result.chatUrl,
            coversLatest: source.sourcePointerCurrent,
          });
        } catch (error) {
          api.logger.warn(
            `fi-user: slack chat pointer failed direct=${channelId} error=${
              error instanceof Error ? error.message : "unavailable"
            }`,
          );
        }
      }
      report[status]++;
      backlog?.reconciled.add(sessionKey);
      backlog?.failed.delete(sessionKey);
    } catch (error) {
      report.error++;
      if (backlog) {
        // Its readers were just revoked, so it must heal on its own short
        // backoff rather than wait for the next rotation.
        const failures = (backlog.failed.get(sessionKey)?.failures ?? 0) + 1;
        backlog.reconciled.delete(sessionKey);
        backlog.failed.set(
          sessionKey,
          error instanceof DirectIdentityUnavailable
            ? { failures, retryAt: Number.POSITIVE_INFINITY, identity: error.identity }
            : { failures, retryAt: Date.now() + directRetryDelay(failures) },
        );
      }
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
  }
  report.pending = due().length;
  return report;
}
