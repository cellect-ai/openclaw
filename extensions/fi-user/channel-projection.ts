import { KeyedAsyncQueue, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  getSessionEntry,
  listSessionKeys,
  sessionDeliveryOrigin,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  createDetachedProjectionReconciler,
  verifyDetachedProjectionOrigin,
  type ProjectionInventory,
} from "./detached-projection.js";
import { isSlackDirectSessionKey, reconcileSlackDirectProjections } from "./direct-projection.js";
import { createProjectionDriftScheduler, runProjectionDriftPass } from "./projection-drift.js";
import {
  nextMaintenanceLane,
  type ProjectionMaintenanceLane,
  RECONCILE_BATCH_SIZE,
  RECONCILE_BACKLOG_DELAY_MS,
  RECONCILE_FULL_REFRESH_BUDGET,
  RECONCILE_HISTORY_BATCH_SIZE,
  RECONCILE_IDLE_DELAY_MS,
  takeSweepBatch,
} from "./reconciliation-batch.js";

type SlackSnapshot = {
  workspaceId: string;
  channelId: string;
  rootMessageId: string;
  memberSenderIds: string[];
  messages: Array<{
    messageId: string;
    senderId: string;
    displayName?: string;
    content: string;
    bot: boolean;
  }>;
};

const CHANNEL_SESSION =
  /^agent:(cellect-fi-user|cellect-fi-admin|cellect-main):slack:channel:([cg][a-z0-9]+):thread:(\d+\.\d+)$/i;
const snapshotQueue = new KeyedAsyncQueue();
type SlackThreadReader = {
  workspaceId: string;
  botUserId: string;
  readThread: (channelId: string, rootMessageId: string) => Promise<SlackSnapshot>;
  readChannel: (channelId: string) => Promise<SlackChannelScope>;
};
type SlackChannelScope = Omit<SlackSnapshot, "rootMessageId" | "messages"> & {
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
    if (params.onResult) {
      const result = (await response.json()) as { status?: unknown };
      if (
        result.status !== "created" &&
        result.status !== "existing" &&
        result.status !== "skipped"
      ) {
        throw new Error("Invalid Fi projection response status");
      }
      params.onResult(result.status);
    }
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
  await post({
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
  return true;
}

/** Reconstruct work from durable session/binding stores; no timer state is authoritative. */
export function registerSlackProjectionReconciler(
  api: OpenClawPluginApi,
  connection: () => { baseUrl: string; token?: string; fullRefreshesPerTick?: number },
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let stopped = true;
  let running = false;
  let wakeRequested = false;
  let prioritySessionKey: string | undefined;
  let maintenanceLane: ProjectionMaintenanceLane = "channel";
  let channelWorkKind: "acl" | "history" = "acl";
  let detachedWorkKind: "acl" | "history" = "acl";
  let lastDriftAt = 0;
  let discoveryCursor = "";
  const bindingSweepSeen = new Set<string>();
  const directSweepSeen = new Set<string>();
  const directReconciled = new Set<string>();
  const outcomes = new Map<string, "created" | "existing" | "skipped" | "error">();
  const drift = createProjectionDriftScheduler();
  let driftReport = { rooms: 0, planned: 0, refreshed: 0, refreshFailed: 0, refreshDeclined: 0 };
  let report = {
    scanned: 0,
    pending: 0,
    created: 0,
    existing: 0,
    skipped: 0,
    error: 0,
    unavailable: 0,
    historyDiscoveryPending: 0,
    historyDiscoveryActionable: 0,
    complete: false,
  };
  let directReport = { scanned: 0, pending: 0, created: 0, existing: 0, skipped: 0, error: 0 };
  let detachedReport = {
    channels: 0,
    pending: 0,
    actionable: 0,
    unavailable: 0,
    error: 0,
    created: 0,
    existing: 0,
    skipped: 0,
  };
  const reconcileDetached = createDetachedProjectionReconciler(api, projectSlackChannelThread);
  api.registerGatewayMethod(
    "fi.slackProjection.status",
    async ({ respond }) => {
      respond(true, {
        ...report,
        direct: directReport,
        detached: detachedReport,
        drift: { ...driftReport, ...drift.summary() },
      });
    },
    { scope: "operator.admin" },
  );
  const reconcile = async () => {
    const generation = controller;
    if (!generation || running) {
      return;
    }
    running = true;
    try {
      report = { ...report, complete: false };
      const { fullRefreshesPerTick, ...config } = connection();
      if (!config.token) {
        return;
      }
      const inventory = api.runtime.channel.runtimeContexts.get<ProjectionInventory>({
        channelId: "matrix",
        capability: "session-read-projections",
      });
      if (!inventory) {
        throw new Error("Matrix projection inventory unavailable");
      }
      const bindings = await inventory.list();
      const runtimeConfig = api.runtime.config?.current?.() ?? api.config;
      const configuredBindings = (runtimeConfig?.bindings ?? []).filter(
        (binding) =>
          binding.match.channel === "slack" &&
          Boolean(binding.match.accountId && binding.match.accountId !== "*") &&
          ["cellect-fi-user", "cellect-fi-admin", "cellect-main"].includes(binding.agentId),
      );
      const resolveAccount = (
        agentId: string,
        channelId: string,
        sessionKey: string,
        stored?: string,
      ) => {
        const accounts = new Set(
          configuredBindings
            .filter(
              (binding) =>
                binding.agentId === agentId &&
                (!binding.match.peer ||
                  binding.match.peer.id.toUpperCase() === channelId.toUpperCase()),
            )
            .map((binding) => binding.match.accountId),
        );
        const durable = bindings.find(
          (binding) => binding.sessionKey === sessionKey,
        )?.sourceAccountId;
        if (durable) {
          return accounts.has(durable) ? durable : undefined;
        }
        return stored && accounts.has(stored)
          ? stored
          : accounts.size === 1
            ? [...accounts][0]
            : undefined;
      };
      const discovered = new Map<string, { sessionKey: string; accountId: string }>();
      const knownRoots = new Set<string>();
      const unavailableSessions = new Set<string>();
      const rootIdentity = (sessionKey: string, accountId: string) => {
        const match = CHANNEL_SESSION.exec(sessionKey);
        const reader = api.runtime.channel.runtimeContexts.get<SlackThreadReader>({
          channelId: "slack",
          accountId,
          capability: "thread-read-projection",
        });
        return match && reader
          ? `${reader.workspaceId}:${match[2]?.toUpperCase()}:${match[3]}`
          : undefined;
      };
      for (const { sessionKey } of bindings) {
        const [, agentId, channelId] = CHANNEL_SESSION.exec(sessionKey) ?? [];
        if (!agentId || !channelId) {
          continue;
        }
        const accountId = resolveAccount(agentId, channelId, sessionKey);
        const identity = accountId && rootIdentity(sessionKey, accountId);
        if (identity) {
          knownRoots.add(identity);
        } else {
          unavailableSessions.add(sessionKey);
        }
      }
      for (const agentId of new Set(configuredBindings.map((binding) => binding.agentId))) {
        for (const sessionKey of await listSessionKeys({ agentId })) {
          const [, sourceAgentId, channelId] = CHANNEL_SESSION.exec(sessionKey) ?? [];
          if (sourceAgentId !== agentId || !channelId) {
            continue;
          }
          const entry = getSessionEntry({ agentId, sessionKey, readConsistency: "latest" });
          // The durable key index includes archived conversations. Archival is
          // the operator's terminal retirement signal; probing those roots on
          // every restart resurrects deleted Slack work into the repair queue.
          if (entry?.archivedAt !== undefined) {
            continue;
          }
          const accountId = resolveAccount(agentId, channelId, sessionKey);
          if (!accountId) {
            unavailableSessions.add(sessionKey);
            continue;
          }
          const identity = rootIdentity(sessionKey, accountId);
          if (identity && !knownRoots.has(identity) && !discovered.has(identity)) {
            discovered.set(identity, { sessionKey, accountId });
          } else if (!identity) {
            unavailableSessions.add(sessionKey);
          }
        }
      }
      // Restart re-enumerates durable sessions. Only scheduling position is transient;
      // Fi/source identity makes replay idempotent and opt-outs remain authoritative.
      const keys = [...discovered.keys()].toSorted();
      const ordered = [
        ...keys.filter((key) => key > discoveryCursor),
        ...keys.filter((key) => key <= discoveryCursor),
      ];
      const discoveryCandidate = ordered.slice(0, RECONCILE_HISTORY_BATCH_SIZE).flatMap((key) => {
        const candidate = discovered.get(key);
        if (!candidate) {
          return [];
        }
        return [{ ...candidate, roomId: undefined }];
      });
      const bindingKeys = bindings
        .filter((binding) => CHANNEL_SESSION.test(binding.sessionKey))
        .map((binding) => binding.sessionKey)
        .toSorted();
      const unseenBindingKeys = bindingKeys.filter((sessionKey) => {
        const [, agentId, channelId] = CHANNEL_SESSION.exec(sessionKey) ?? [];
        if (!agentId || !channelId) {
          return false;
        }
        const accountId = resolveAccount(agentId, channelId, sessionKey);
        const identity = accountId && rootIdentity(sessionKey, accountId);
        return Boolean(identity && !outcomes.has(identity));
      });
      // Once this lane has classified all bindings, let the other recovery
      // lanes drain before rotating completed ACL checks. Transient channel
      // errors are retried on the normal idle cadence after the global
      // backlog settles rather than consuming every fast recovery cycle.
      const bindingSweepKeys =
        unseenBindingKeys.length > 0
          ? unseenBindingKeys
          : detachedReport.actionable > 0 || directReport.pending > 0
            ? []
            : bindingKeys;
      const priority = prioritySessionKey
        ? bindings.find((binding) => binding.sessionKey === prioritySessionKey)
        : undefined;
      const bindingBatch =
        maintenanceLane === "channel" && !priority
          ? takeSweepBatch(bindingSweepKeys, bindingSweepSeen, RECONCILE_BATCH_SIZE)
          : new Set<string>();
      const channelScopes = new Map<
        string,
        { createdAt: number; scope: Promise<SlackChannelScope> }
      >();
      const aclCandidate = bindings.find((binding) => bindingBatch.has(binding.sessionKey));
      const historyCandidate = discoveryCandidate[0];
      // This service has one global maintenance slot.  A previous implementation
      // separately admitted channel ACLs, detached ACLs, direct snapshots, and
      // history discovery, creating a burst despite each local cap.  Live Slack
      // delivery is deliberately outside this scheduler; a wake only gives its
      // own session the next maintenance slot.
      const projects =
        maintenanceLane !== "channel"
          ? []
          : priority
            ? [priority]
            : channelWorkKind === "acl"
              ? aclCandidate
                ? [aclCandidate]
                : historyCandidate
                  ? [historyCandidate]
                  : []
              : historyCandidate
                ? [historyCandidate]
                : aclCandidate
                  ? [aclCandidate]
                  : [];
      if (historyCandidate && projects[0] === historyCandidate) {
        const identity = rootIdentity(historyCandidate.sessionKey, historyCandidate.accountId);
        if (identity) {
          discoveryCursor = identity;
        }
      }
      if (projects.length && !priority) {
        channelWorkKind = channelWorkKind === "acl" ? "history" : "acl";
      }
      if (priority && maintenanceLane === "channel") {
        prioritySessionKey = undefined;
      }
      // A full-room ACL sweep exhausts Fi's shared provisioning credential before
      // live traffic can authenticate.  The selected item is the durable repair
      // path; an existing live Slack event has its own direct projection hook.
      for (const { sessionKey, roomId } of projects) {
        if (stopped || controller !== generation) {
          return;
        }
        const [, agentId, channelId] = CHANNEL_SESSION.exec(sessionKey) ?? [];
        if (!agentId || !channelId) {
          continue;
        }
        const entry = getSessionEntry({ agentId, sessionKey, readConsistency: "latest" });
        const accountId = resolveAccount(
          agentId,
          channelId,
          sessionKey,
          sessionDeliveryOrigin(entry)?.accountId,
        );
        const identity = accountId && rootIdentity(sessionKey, accountId);
        let enteredPublisher = false;
        try {
          let channelScope: SlackChannelScope | undefined;
          if (entry && accountId) {
            const reader = api.runtime.channel.runtimeContexts.get<SlackThreadReader>({
              channelId: "slack",
              accountId,
              capability: "thread-read-projection",
            });
            if (reader) {
              const scopeKey = `${accountId}:${reader.workspaceId}:${channelId.toUpperCase()}`;
              let cached = channelScopes.get(scopeKey);
              if (!cached || Date.now() - cached.createdAt > 20_000) {
                cached = {
                  createdAt: Date.now(),
                  scope: reader.readChannel(channelId.toUpperCase()),
                };
                channelScopes.set(scopeKey, cached);
              }
              channelScope = await cached.scope;
            }
          }
          enteredPublisher = true;
          await projectSlackChannelThread({
            api,
            ...config,
            token: config.token,
            sessionKey,
            accountId: accountId ?? "unavailable",
            unavailable: !entry || !accountId,
            reconcile: Boolean(roomId),
            discover: !roomId,
            projectionRoomId: roomId,
            channelScope,
            // Existing projections receive source content on live delivery.
            // The periodic repair path only needs to reconcile current
            // readers, so it must not re-read and re-upload an entire Slack
            // thread for every bound room (the drift pass refreshes drift).
            membershipOnly: Boolean(roomId),
            onResult: (status) => {
              if (identity) {
                outcomes.set(identity, status);
              }
            },
            signal: AbortSignal.any([generation.signal, AbortSignal.timeout(90_000)]),
          });
        } catch (error) {
          if (identity) {
            // A deleted Slack root is terminal for this durable source. Keep
            // the session available for explicit operator archival, but do
            // not spend a maintenance slot retrying it forever. A restart
            // probes once again, so restoring the Slack source self-heals.
            outcomes.set(identity, isMissingSlackThread(error) ? "skipped" : "error");
          }
          if (roomId && !enteredPublisher) {
            await projectSlackChannelThread({
              api,
              ...config,
              token: config.token,
              sessionKey,
              accountId: accountId ?? "unavailable",
              unavailable: true,
              reconcile: true,
              projectionRoomId: roomId,
              signal: AbortSignal.any([generation.signal, AbortSignal.timeout(70_000)]),
            }).catch(() => {
              api.logger.warn(
                `fi-user: failed to revoke unavailable projection session=${sessionKey}`,
              );
            });
          }
          const detail =
            error instanceof Error
              ? error.message
                  .replace(/xox[baprs]-\S+/g, "[redacted]")
                  .replace(/\s+/g, " ")
                  .slice(0, 200)
              : "unknown error";
          api.logger.warn(
            `fi-user: Slack reconciliation account=${accountId} session=${sessionKey}: ${detail}`,
          );
        }
      }
      const candidates = new Set([...knownRoots, ...discovered.keys()]);
      for (const identity of outcomes.keys()) {
        if (!candidates.has(identity)) {
          outcomes.delete(identity);
        }
      }
      const counts = { created: 0, existing: 0, skipped: 0, error: 0 };
      for (const identity of candidates) {
        const outcome = outcomes.get(identity);
        if (outcome) {
          counts[outcome]++;
        }
      }
      const pending =
        [...candidates].filter((identity) => !outcomes.has(identity)).length +
        unavailableSessions.size;
      if (maintenanceLane === "detached") {
        detachedReport = await reconcileDetached.reconcile(
          { ...config, token: config.token },
          bindings,
          generation.signal,
          knownRoots,
          detachedWorkKind === "acl"
            ? { maxExistingRooms: RECONCILE_BATCH_SIZE, allowDiscovery: false }
            : { maxExistingRooms: 0, allowDiscovery: true },
        );
        detachedWorkKind = detachedWorkKind === "acl" ? "history" : "acl";
      } else if (maintenanceLane === "direct") {
        const directPrioritySessionKey = prioritySessionKey;
        prioritySessionKey = undefined;
        directReport = await reconcileSlackDirectProjections(
          api,
          { ...config, token: config.token },
          bindings,
          generation.signal,
          directSweepSeen,
          RECONCILE_HISTORY_BATCH_SIZE,
          directPrioritySessionKey,
          directReconciled,
        );
      }
      // During a historical drain, passes run every second. Keep the expensive
      // all-room drift inventory on its normal minute cadence; live activity
      // still enters through its immediate hook above.
      if (lastDriftAt === 0 || Date.now() - lastDriftAt >= RECONCILE_IDLE_DELAY_MS) {
        driftReport =
          (await runProjectionDriftPass({
            api,
            drift,
            inventory,
            bindings,
            budget: fullRefreshesPerTick ?? RECONCILE_FULL_REFRESH_BUDGET,
            configured: configuredBindings,
            active: () => !stopped && controller === generation,
            channelAccount: (agentId, channelId, sessionKey) => {
              const entry = getSessionEntry({ agentId, sessionKey, readConsistency: "latest" });
              const stored = sessionDeliveryOrigin(entry)?.accountId;
              return entry && resolveAccount(agentId, channelId, sessionKey, stored);
            },
            publish: (params) =>
              projectSlackChannelThread({
                ...params,
                ...config,
                token: config.token ?? "",
                signal: AbortSignal.any([generation.signal, AbortSignal.timeout(90_000)]),
              }),
          })) ?? driftReport;
        lastDriftAt = Date.now();
      }
      maintenanceLane = wakeRequested ? maintenanceLane : nextMaintenanceLane(maintenanceLane);
      report = {
        scanned: candidates.size,
        pending,
        ...counts,
        unavailable: unavailableSessions.size,
        historyDiscoveryPending: detachedReport.pending,
        historyDiscoveryActionable: detachedReport.actionable,
        complete:
          pending === 0 &&
          counts.error === 0 &&
          unavailableSessions.size === 0 &&
          directReport.error === 0 &&
          detachedReport.pending === 0 &&
          detachedReport.error === 0 &&
          detachedReport.unavailable === 0,
      };
      api.logger.info(
        `fi-user: Slack discovery ${JSON.stringify({ ...report, drift: { ...driftReport, ...drift.summary() } })}`,
      );
    } catch (error) {
      report = { ...report, complete: false, error: report.error + 1 };
      const detail =
        error instanceof Error
          ? error.message
              .replace(/xox[baprs]-\S+/g, "[redacted]")
              .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
              .replace(/\s+/g, " ")
              .slice(0, 240)
          : "unknown error";
      api.logger.warn(`fi-user: Slack projection reconciliation scan failed: ${detail}`);
    } finally {
      running = false;
      if (!stopped && controller === generation) {
        // Only new work earns the backlog cadence. Rescans, failed-source
        // retries and DM rotation are maintenance on the idle cadence;
        // `historyDiscoveryPending` still reports them.
        const actionablePending =
          report.pending > report.unavailable ||
          report.historyDiscoveryActionable > 0 ||
          directReport.pending > 0;
        const delay =
          wakeRequested || actionablePending ? RECONCILE_BACKLOG_DELAY_MS : RECONCILE_IDLE_DELAY_MS;
        timer = setTimeout(() => void reconcile(), delay);
        wakeRequested = false;
        timer.unref();
      }
    }
  };
  api.registerService({
    id: "fi-slack-projection-reconciler",
    start() {
      if (!stopped) {
        return;
      }
      stopped = false;
      // Timer/cursor state is deliberately transient. A fresh service start
      // begins at the channel lane so a durable room never waits behind a
      // stale detached/direct cursor from the prior gateway generation.
      prioritySessionKey = undefined;
      maintenanceLane = "channel";
      channelWorkKind = "acl";
      detachedWorkKind = "acl";
      lastDriftAt = 0;
      bindingSweepSeen.clear();
      directSweepSeen.clear();
      directReconciled.clear();
      controller = new AbortController();
      timer = setTimeout(() => void reconcile(), 5_000);
      timer.unref();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
      controller?.abort();
      controller = undefined;
    },
  });
  return {
    /** Slack or Matrix activity: plan the matching rooms ahead of the rotation. */
    noteActivity: (key: string | undefined) => drift.noteActivity(key),
    wake: (sessionKey: string, lane: ProjectionMaintenanceLane = "channel") => {
      if (lane === "direct" && !isSlackDirectSessionKey(sessionKey)) {
        return;
      }
      if (lane !== "direct") {
        reconcileDetached.invalidate(sessionKey);
      }
      prioritySessionKey = sessionKey;
      maintenanceLane = lane;
      if (stopped) {
        return;
      }
      if (running) {
        wakeRequested = true;
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => void reconcile(), 1_000);
      timer.unref();
    },
  };
}
