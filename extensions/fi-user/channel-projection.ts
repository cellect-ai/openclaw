import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  getSessionEntry,
  listSessionKeys,
  sessionDeliveryOrigin,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  projectSlackChannelThread,
  isMissingSlackThread,
  type SlackThreadReader,
  type SlackChannelScope,
} from "./channel-projection-publisher.js";
import { CHANNEL_SESSION } from "./channel-projection-session.js";
import {
  createDetachedProjectionReconciler,
  type ProjectionInventory,
} from "./detached-projection.js";
import {
  createDirectProjectionBacklog,
  isSlackDirectSessionKey,
  markDirectActive,
  noteSlackSocketReconnects,
  reconcileSlackDirectProjections,
} from "./direct-projection.js";
import { createProjectionDriftScheduler, runProjectionDriftPass } from "./projection-drift.js";
import {
  createReconcileSchedule,
  createLiveChannelRetryGate,
  type ProjectionMaintenanceLane,
  RECONCILE_BATCH_SIZE,
  RECONCILE_FULL_REFRESH_BUDGET,
  RECONCILE_HISTORY_BATCH_SIZE,
  RECONCILE_IDLE_DELAY_MS,
  takeSweepBatch,
} from "./reconciliation-batch.js";

/** Reconstruct work from durable session/binding stores; no timer state is authoritative. */
export function registerSlackProjectionReconciler(
  api: OpenClawPluginApi,
  connection: () => { baseUrl: string; token?: string; fullRefreshesPerTick?: number },
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let stopped = true;
  let running = false;
  const schedule = createReconcileSchedule();
  const liveChannelRetry = createLiveChannelRetryGate();
  let channelWorkKind: "acl" | "history" = "acl";
  let detachedWorkKind: "acl" | "history" = "acl";
  let lastDriftAt = 0;
  let discoveryCursor = "";
  const bindingSweepSeen = new Set<string>();
  const directSweepSeen = new Set<string>();
  const directBacklog = createDirectProjectionBacklog();
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
  const reconcileDetached = createDetachedProjectionReconciler(
    api,
    projectSlackChannelThread,
    isMissingSlackThread,
  );
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
    const pass = schedule.take();
    const { lane, sessionKey: prioritySessionKey } = pass;
    let handled = false;
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
        lane === "channel" && !priority
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
        lane !== "channel"
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
            // A wake is a retry of live delivery, so repair its content too.
            membershipOnly: Boolean(roomId) && !priority,
            refresh: Boolean(priority),
            onResult: (status) => {
              if (identity) {
                outcomes.set(identity, status);
              }
            },
            signal: AbortSignal.any([generation.signal, AbortSignal.timeout(90_000)]),
          });
          if (priority) {
            liveChannelRetry.succeeded(sessionKey);
          }
        } catch (error) {
          if (priority && !isMissingSlackThread(error)) {
            schedule.requeue(pass);
          }
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
      if (lane === "direct") {
        noteSlackSocketReconnects(api, configuredBindings, directBacklog);
      }
      if (lane === "detached") {
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
      } else if (lane === "direct") {
        const directPrioritySessionKey = prioritySessionKey;
        directReport = await reconcileSlackDirectProjections(
          api,
          { ...config, token: config.token },
          bindings,
          generation.signal,
          directSweepSeen,
          RECONCILE_HISTORY_BATCH_SIZE,
          directPrioritySessionKey,
          directBacklog,
        );
      }
      handled = true;
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
      if (!handled) {
        schedule.requeue(pass);
      }
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
        const delay = schedule.finish(pass, actionablePending);
        timer = setTimeout(() => void reconcile(), delay);
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
      schedule.reset(5_000);
      liveChannelRetry.reset();
      channelWorkKind = "acl";
      detachedWorkKind = "acl";
      lastDriftAt = 0;
      bindingSweepSeen.clear();
      directSweepSeen.clear();
      directBacklog.reconciled.clear();
      directBacklog.failed.clear();
      reconcileDetached.resetBackoff();
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
  const reconciler = {
    /** Slack or Matrix activity: plan the matching rooms ahead of the rotation. */
    noteActivity: (key: string | undefined) => drift.noteActivity(key),
    wake: (sessionKey: string, lane: ProjectionMaintenanceLane = "channel") => {
      if (lane === "direct" && !isSlackDirectSessionKey(sessionKey)) {
        return;
      }
      if (lane === "direct") {
        markDirectActive(directBacklog, sessionKey);
      } else {
        reconcileDetached.invalidate(sessionKey);
      }
      schedule.wake(sessionKey, lane);
      if (stopped || running) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => void reconcile(), 1_000);
      timer.unref();
    },
  };
  return {
    ...reconciler,
    channelProjectionSucceeded: (sessionKey: string) => liveChannelRetry.succeeded(sessionKey),
    retryChannelProjection: (sessionKey: string) => {
      if (CHANNEL_SESSION.test(sessionKey) && liveChannelRetry.admit(sessionKey)) {
        reconciler.wake(sessionKey);
      }
    },
  };
}
