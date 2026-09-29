import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  getSessionEntry,
  listSessionKeys,
  sessionDeliveryOrigin,
} from "openclaw/plugin-sdk/session-store-runtime";
import type { ChannelProjectionParams } from "./channel-projection.js";
import {
  RECONCILE_BATCH_SIZE,
  RECONCILE_HISTORY_BATCH_SIZE,
  reconcileRetryDelay,
  takePendingOrRotatingBatch,
} from "./reconciliation-batch.js";

type Source = NonNullable<ChannelProjectionParams["detachedSource"]>;
export type ProjectionInventoryBinding = {
  sessionKey: string;
  roomId: string;
  externalSource?: Source;
  sourceAccountId?: string;
};
export type ProjectionInventory = {
  list: () => Promise<ProjectionInventoryBinding[]>;
  /** Structural, read-only dry run of one bound room's reconcile pass. */
  plan?: (
    roomId: string,
  ) => Promise<{ converged: boolean; invariantsOk: boolean; hasHumanMember?: boolean }>;
};

/**
 * Structural, read-only plan verdict for one bound room, or undefined when the
 * plan could not be read (logged; the room is planned again later).
 */
export async function planProjectionRoom(
  inventory: ProjectionInventory | undefined,
  roomId: string,
  logger?: { warn: (message: string) => void },
): Promise<{ converged: boolean; invariantsOk: boolean; hasHumanMember?: boolean } | undefined> {
  try {
    return await inventory?.plan?.(roomId);
  } catch (error) {
    logger?.warn(
      `fi-user: projection refresh plan failed room=${roomId} error=${safeError(error)}`,
    );
    return undefined;
  }
}

/** One line per periodic full refresh, so the self-healing pass is observable. */
export function logProjectionRefresh(
  logger: { info: (message: string) => void; warn: (message: string) => void },
  lane: "channel" | "detached",
  roomId: string,
  sessionKey: string,
  error?: unknown,
): void {
  const line = `fi-user: projection refresh lane=${lane} room=${roomId} session=${sessionKey}`;
  if (error === undefined) {
    logger.info(`${line} outcome=refreshed`);
  } else {
    logger.warn(`${line} outcome=failed error=${safeError(error)}`);
  }
}

type Scope = NonNullable<ChannelProjectionParams["channelScope"]> & {
  readHistoryPage: (cursor?: string) => Promise<{ roots: string[]; nextCursor?: string }>;
};
type Reader = {
  workspaceId: string;
  botUserId?: string;
  readChannel: (channelId: string, clawBotUserIds?: Iterable<string>) => Promise<Scope>;
};
type ReconcileBudget = {
  /** Existing rooms only need their membership checked. */
  maxExistingRooms?: number;
  /** Historical root discovery is intentionally a separate maintenance lane. */
  allowDiscovery?: boolean;
};
type ConfiguredBinding = {
  agentId: string;
  match: { accountId?: string; peer?: { id: string } };
};
export const PARENT =
  /^agent:(cellect-fi-user|cellect-fi-admin|cellect-main):slack:(?:channel|group):([cg][a-z0-9]+)$/i;
const identity = (source: Source) =>
  `${source.workspaceId}:${source.channelId}:${source.rootMessageId}`;
export const safeError = (error: unknown) =>
  (error instanceof Error ? error.message : "Source unavailable")
    .replace(/xox[baprs]-\S+/g, "[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 240);

export async function verifyDetachedProjectionOrigin(
  params: ChannelProjectionParams,
  sourceIdentity: { agentId: string; channelId: string },
  readerWorkspaceId?: string,
) {
  if (!params.detachedSource) {
    throw new Error("Detached source required");
  }
  const entry = getSessionEntry({
    agentId: sourceIdentity.agentId,
    sessionKey: params.sessionKey,
    readConsistency: "latest",
  });
  const origin = sessionDeliveryOrigin(entry);
  const inventory = params.api.runtime.channel.runtimeContexts.get<ProjectionInventory>({
    channelId: "matrix",
    capability: "session-read-projections",
  });
  const persisted = (await inventory?.list())?.find(
    (binding) =>
      binding.sessionKey === params.sessionKey &&
      binding.sourceAccountId === params.accountId &&
      binding.externalSource?.channelId === sourceIdentity.channelId &&
      binding.externalSource.workspaceId === params.detachedSource?.workspaceId,
  );
  if (
    !entry ||
    (!persisted &&
      (origin?.accountId !== params.accountId ||
        origin.nativeChannelId?.toUpperCase() !== sourceIdentity.channelId)) ||
    params.detachedSource.channelId !== sourceIdentity.channelId ||
    readerWorkspaceId !== params.detachedSource.workspaceId
  ) {
    throw new Error("Detached Slack source does not match native parent origin");
  }
}

/**
 * The Slack account that may serve an existing detached room: its durable
 * source account, else the parent session's delivery account, and only when a
 * configured binding still admits it for this agent and channel.
 */
export function resolveDetachedRoomAccount(
  configured: readonly ConfiguredBinding[],
  binding: ProjectionInventoryBinding,
): { accountId?: string; allowed: boolean } {
  const source = binding.externalSource;
  const agentId = PARENT.exec(binding.sessionKey)?.[1];
  const entry = agentId
    ? getSessionEntry({ agentId, sessionKey: binding.sessionKey, readConsistency: "latest" })
    : undefined;
  const accountId = binding.sourceAccountId ?? sessionDeliveryOrigin(entry)?.accountId;
  const allowed = configured.some(
    (candidate) =>
      candidate.agentId === agentId &&
      candidate.match.accountId === accountId &&
      (!candidate.match.peer || candidate.match.peer.id.toUpperCase() === source?.channelId),
  );
  return { accountId, allowed: Boolean(entry && source && accountId && allowed) };
}

const RESCAN_MARGIN_SECONDS = 3600;
const RESCAN_MAX_PAGES = 3;
const RESCAN_MAX_FAILED_ROOTS = 1000;
const FULL_RESCAN_INTERVAL_MS = 24 * 3600_000;

/** Cursor state is only a bounded scheduler; durable source/room identity makes restart replay safe. */
export function createDetachedProjectionReconciler(
  api: OpenClawPluginApi,
  publish: (params: ChannelProjectionParams) => Promise<boolean>,
  /** A publish error that no retry can repair, such as a deleted Slack thread. */
  isTerminal: (error: unknown) => boolean = () => false,
) {
  type Scan = {
    cursor?: string;
    roots: string[];
    /** Failed roots keep their own backoff across rescans; they never hold a scan open. */
    failed: Map<string, { failures: number; retryAt: number }>;
    pages: number;
    done: boolean;
    /** A periodic safety rescan, not new work: it runs at the idle cadence. */
    background: boolean;
    /** Consecutive whole-channel failures and when the channel may be read again. */
    failures: number;
    retryAt?: number;
    /** Roots that failed during this scan; bounds a scan against a systemic outage. */
    scanFailures: number;
    startedAt: number;
    /**
     * Unix seconds. A rescan stops paging once it reaches roots older than
     * this; undefined reads the whole history (the first scan after start).
     */
    since?: number;
    /** Stopped before reaching `since` (page cap or failure stop): its window is unread. */
    truncated: boolean;
    /**
     * A rescan's page allowance. After a truncated scan the next one keeps
     * the unread window and pages deeper, so it reaches what was skipped.
     */
    maxPages: number;
    /** When the last full-depth scan of this channel began, once one has finished. */
    fullScanAt?: number;
    completedAt?: number;
    created: number;
    existing: number;
    skipped: number;
    error?: string;
  };
  const scans = new Map<string, Scan>();
  // A rescan re-reads history only back to where the previous scan began
  // (less a margin), so one rescan of a long channel is a page or two rather
  // than hours of paging at the idle cadence. A scan that did not finish
  // hands its own window on, so nothing it had not reached is skipped.
  const newScan = (background: boolean, previous?: Scan): Scan => {
    // Shallow rescans cannot see an old thread that becomes a Claw conversation
    // later, so a background rescan goes to full depth once a day.
    const full =
      !previous ||
      (background && Date.now() - (previous.fullScanAt ?? 0) >= FULL_RESCAN_INTERVAL_MS);
    return {
      roots: [],
      failed: previous?.failed ?? new Map(),
      pages: 0,
      done: false,
      background,
      failures: 0,
      scanFailures: 0,
      startedAt: Date.now(),
      since: full
        ? undefined
        : previous.done && !previous.truncated
          ? Math.floor(previous.startedAt / 1000) - RESCAN_MARGIN_SECONDS
          : previous.since,
      truncated: false,
      maxPages:
        previous?.truncated && !full ? previous.maxPages + RESCAN_MAX_PAGES : RESCAN_MAX_PAGES,
      fullScanAt: previous?.fullScanAt,
      created: 0,
      existing: 0,
      skipped: 0,
    };
  };
  const due = (retryAt: number | undefined) => retryAt === undefined || Date.now() >= retryAt;
  // A channel waiting out a read failure has nothing to do until then, so it
  // must not hold back the periodic rescan of every other channel.
  const settled = (scan: Scan | undefined) => Boolean(scan && (scan.done || !due(scan.retryAt)));
  // Background scans (a daily full-depth rescan can page for hours) must not
  // hold back other channels' refresh; unfinished initial scans still do.
  const refreshable = (scan: Scan | undefined) =>
    Boolean(scan && (scan.background || settled(scan)));
  // Only unread history is actionable. A background rescan, a channel waiting
  // out a failure, and a scan whose remaining roots are retries of earlier
  // failures are all maintenance and must not hold the backlog cadence.
  const actionable = (scan: Scan | undefined) =>
    !scan ||
    (!scan.done &&
      !scan.background &&
      scan.failures === 0 &&
      (scan.pages === 0 ||
        scan.cursor !== undefined ||
        scan.roots.some((root) => !scan.failed.has(root))));
  let channelCursor = "";
  let existingCursor = "";
  let refreshAt = 0;
  const existingOutcomes = new Map<string, "ok" | "unavailable" | "error">();
  const run = async (
    connection: { baseUrl: string; token: string },
    bindings: ProjectionInventoryBinding[],
    signal: AbortSignal,
    knownRoots: Set<string>,
    budget: ReconcileBudget = {},
  ) => {
    const config = api.runtime.config?.current?.() ?? api.config;
    const configured = (config?.bindings ?? []).filter(
      (binding) =>
        binding.match.channel === "slack" &&
        ["cellect-fi-user", "cellect-fi-admin", "cellect-main"].includes(binding.agentId) &&
        binding.match.accountId &&
        binding.match.accountId !== "*",
    );
    const parents = new Map<
      string,
      { sessionKey: string; accountId: string; workspaceId: string; channelId: string }
    >();
    let unavailable = 0;
    for (const agentId of new Set(configured.map((binding) => binding.agentId))) {
      for (const sessionKey of await listSessionKeys({ agentId })) {
        const channelId = PARENT.exec(sessionKey)?.[2]?.toUpperCase();
        if (!channelId) {
          continue;
        }
        const persisted = bindings.find(
          (binding) =>
            binding.sessionKey === sessionKey &&
            binding.sourceAccountId &&
            binding.externalSource?.channelId === channelId,
        );
        const configuredAccounts = new Set(
          configured
            .filter(
              (binding) =>
                binding.agentId === agentId &&
                (!binding.match.peer || binding.match.peer.id.toUpperCase() === channelId),
            )
            .map((binding) => binding.match.accountId),
        );
        const accountId =
          persisted?.sourceAccountId ??
          (configuredAccounts.size === 1 ? [...configuredAccounts][0] : undefined);
        const allowed =
          accountId &&
          (!persisted || persisted.externalSource?.channelId.toUpperCase() === channelId) &&
          configured.some(
            (binding) =>
              binding.agentId === agentId &&
              binding.match.accountId === accountId &&
              (!binding.match.peer || binding.match.peer.id.toUpperCase() === channelId),
          );
        const reader = allowed
          ? api.runtime.channel.runtimeContexts.get<Reader>({
              channelId: "slack",
              accountId,
              capability: "thread-read-projection",
            })
          : undefined;
        if (!accountId || !reader) {
          unavailable++;
          continue;
        }
        const key = `${reader.workspaceId}:${channelId}`;
        if (!parents.has(key)) {
          parents.set(key, { sessionKey, accountId, workspaceId: reader.workspaceId, channelId });
        }
      }
    }
    for (const key of scans.keys()) {
      if (!parents.has(key)) {
        scans.delete(key);
      }
    }
    // History is read with one account per channel, but any Claw bot in the
    // workspace makes a thread a Claw conversation.
    const clawBots = new Map<string, Set<string>>();
    for (const binding of configured) {
      const bot = api.runtime.channel.runtimeContexts.get<Reader>({
        channelId: "slack",
        accountId: binding.match.accountId,
        capability: "thread-read-projection",
      });
      if (bot?.botUserId) {
        const bots = clawBots.get(bot.workspaceId) ?? new Set<string>();
        bots.add(bot.botUserId);
        clawBots.set(bot.workspaceId, bots);
      }
    }
    const scopes = new Map<string, { at: number; scope: Promise<Scope> }>();
    const scopeFor = (accountId: string, channelId: string) => {
      const key = `${accountId}:${channelId}`;
      let cached = scopes.get(key);
      if (!cached || Date.now() - cached.at > 20_000) {
        const reader = api.runtime.channel.runtimeContexts.get<Reader>({
          channelId: "slack",
          accountId,
          capability: "thread-read-projection",
        });
        cached = {
          at: Date.now(),
          scope: reader
            ? reader.readChannel(channelId, clawBots.get(reader.workspaceId))
            : Promise.reject(new Error("Slack parent reader unavailable")),
        };
        scopes.set(key, cached);
      }
      return cached.scope;
    };
    const existing = bindings.filter(
      (binding) => binding.externalSource?.provider === "slack" && PARENT.test(binding.sessionKey),
    );
    const currentRooms = new Set(existing.map((binding) => binding.roomId));
    for (const roomId of existingOutcomes.keys()) {
      if (!currentRooms.has(roomId)) {
        existingOutcomes.delete(roomId);
      }
    }
    const roomIds = existing.map((binding) => binding.roomId).toSorted();
    const scheduled = takePendingOrRotatingBatch(
      roomIds,
      new Set(existingOutcomes.keys()),
      existingCursor,
      budget.maxExistingRooms ?? RECONCILE_BATCH_SIZE,
    );
    const existingRooms = scheduled.batch;
    existingCursor = scheduled.cursor;
    for (const binding of existing) {
      const source = binding.externalSource;
      if (!source) {
        continue;
      }
      knownRoots.add(identity(source));
      if (!existingRooms.has(binding.roomId)) {
        continue;
      }
      signal.throwIfAborted();
      const { accountId, allowed } = resolveDetachedRoomAccount(configured, binding);
      try {
        if (!allowed || !accountId) {
          throw new Error("Detached parent unavailable");
        }
        // A detached room already has its historical snapshot, so readers are
        // reconciled without replaying it. Drifted rooms are refreshed by the
        // reconciler's drift pass, not here.
        await publish({
          api,
          ...connection,
          sessionKey: binding.sessionKey,
          accountId,
          detachedSource: source,
          reconcile: true,
          projectionRoomId: binding.roomId,
          channelScope: await scopeFor(accountId, source.channelId),
          membershipOnly: true,
          signal,
        });
        existingOutcomes.set(binding.roomId, "ok");
      } catch (error) {
        const revoked = await publish({
          api,
          ...connection,
          sessionKey: binding.sessionKey,
          accountId: accountId ?? "unavailable",
          detachedSource: source,
          reconcile: true,
          projectionRoomId: binding.roomId,
          unavailable: true,
          signal,
        }).then(
          () => true,
          () => false,
        );
        existingOutcomes.set(binding.roomId, revoked ? "unavailable" : "error");
        api.logger.warn(
          `fi-user: detached source unavailable room=${binding.roomId} error=${safeError(error)}`,
        );
      }
    }
    const keys = [...parents.keys()].toSorted();
    const summary = () => {
      const states = [...scans.values()];
      const uncheckedRooms = roomIds.filter((roomId) => !existingOutcomes.has(roomId)).length;
      return {
        channels: parents.size,
        pending: keys.filter((candidate) => !scans.get(candidate)?.done).length + uncheckedRooms,
        /** The part of `pending` that is new work and may use the backlog cadence. */
        actionable:
          keys.filter((candidate) => actionable(scans.get(candidate))).length + uncheckedRooms,
        unavailable:
          unavailable +
          [...existingOutcomes.values()].filter((outcome) => outcome === "unavailable").length,
        error:
          states.filter((state) => state.error).length +
          [...existingOutcomes.values()].filter((outcome) => outcome === "error").length,
        created: states.reduce((sum, state) => sum + state.created, 0),
        existing: states.reduce((sum, state) => sum + state.existing, 0),
        skipped: states.reduce((sum, state) => sum + state.skipped, 0),
      };
    };
    if (!budget.allowDiscovery && budget.maxExistingRooms !== undefined) {
      return summary();
    }
    if (
      refreshAt &&
      Date.now() >= refreshAt &&
      keys.every((candidate) => refreshable(scans.get(candidate)))
    ) {
      // The periodic rescan is a safety net for history that live delivery
      // missed. It re-reads every channel, so it is background work; only a
      // root it actually creates promotes that channel back to the backlog.
      for (const [candidate, scan] of scans) {
        if (scan.done) {
          scans.set(candidate, newScan(true, scan));
        }
      }
      refreshAt = 0;
    }
    for (const scan of scans.values()) {
      if (
        scan.done &&
        !scan.cursor &&
        [...scan.failed.values()].some((retry) => due(retry.retryAt))
      ) {
        scan.done = false;
      }
    }
    const ordered = [
      ...keys.filter((key) => key > channelCursor),
      ...keys.filter((key) => key <= channelCursor),
    ].filter((candidate) => {
      const scan = scans.get(candidate);
      return !scan?.done && due(scan?.retryAt);
    });
    const key = ordered.find((candidate) => !scans.get(candidate)?.background) ?? ordered[0];
    const parent = key ? parents.get(key) : undefined;
    if (key && parent) {
      channelCursor = key;
      const state = scans.get(key) ?? newScan(false);
      scans.set(key, state);
      try {
        const scope = await scopeFor(parent.accountId, parent.channelId);
        if (!state.roots.length) {
          if (state.pages > 0 && !state.cursor) {
            state.roots = [...state.failed]
              .filter(([, retry]) => due(retry.retryAt))
              .map(([rootMessageId]) => rootMessageId)
              .slice(0, RECONCILE_HISTORY_BATCH_SIZE);
          } else {
            const page = await scope.readHistoryPage(state.cursor);
            state.pages++;
            state.cursor = page.nextCursor;
            state.roots = [...page.roots];
            const since = state.since;
            if (since !== undefined && state.cursor) {
              if (page.roots.some((root) => Number(root) < since)) {
                state.cursor = undefined;
              } else if (state.pages >= state.maxPages) {
                state.cursor = undefined;
                state.truncated = true;
              }
            }
          }
        }
        // Known and backed-off roots cost no network call, so they do not
        // spend the one publish this pass may make.
        let published = 0;
        while (published < RECONCILE_HISTORY_BATCH_SIZE) {
          const rootMessageId = state.roots[0];
          if (rootMessageId === undefined) {
            break;
          }
          signal.throwIfAborted();
          const source: Source = {
            provider: "slack",
            workspaceId: parent.workspaceId,
            channelId: parent.channelId,
            rootMessageId,
          };
          const retry = state.failed.get(rootMessageId);
          if (knownRoots.has(identity(source))) {
            state.existing++;
            state.failed.delete(rootMessageId);
          } else if (!retry || due(retry.retryAt)) {
            published++;
            try {
              await publish({
                api,
                ...connection,
                sessionKey: parent.sessionKey,
                accountId: parent.accountId,
                detachedSource: source,
                discover: true,
                channelScope: await scopeFor(parent.accountId, parent.channelId),
                signal,
                onResult: (status) => {
                  state[status]++;
                  if (status === "created") {
                    state.background = false;
                  }
                },
              });
              state.failed.delete(rootMessageId);
            } catch (error) {
              if (signal.aborted) {
                throw error;
              }
              state.failed.delete(rootMessageId);
              if (isTerminal(error)) {
                // Deleted at the source: nothing to project, and nothing a
                // retry can change. A rescan that finds it again re-probes it.
                state.skipped++;
              } else {
                const failures = (retry?.failures ?? 0) + 1;
                state.failed.set(rootMessageId, {
                  failures,
                  retryAt: Date.now() + reconcileRetryDelay(failures),
                });
                state.scanFailures++;
                state.error = safeError(error);
              }
            }
          }
          state.roots.shift();
        }
        if (state.scanFailures >= RESCAN_MAX_FAILED_ROOTS && state.cursor) {
          // A systemic failure, not a bad root: stop paging this scan. Its
          // failed roots keep their backoff and the next rescan starts clean.
          state.cursor = undefined;
          state.roots = [];
          state.truncated = true;
          api.logger.warn(
            `fi-user: detached discovery source=${key} stopped after ${state.scanFailures} failed roots`,
          );
        }
        // A root waiting out its backoff is reported through `error`; it does
        // not keep the channel open, or every rescan would stall behind it.
        state.done =
          !state.cursor &&
          !state.roots.length &&
          ![...state.failed.values()].some((failed) => due(failed.retryAt));
        if (state.done) {
          state.completedAt = Date.now();
          if (state.since === undefined && !state.truncated) {
            state.fullScanAt = state.startedAt;
          }
        }
        if (!state.failed.size) {
          state.error = undefined;
        }
        state.failures = 0;
        state.retryAt = undefined;
      } catch (error) {
        state.error = safeError(error);
        // A stopped gateway generation is not a source failure.
        if (!signal.aborted) {
          state.failures++;
          state.retryAt = Date.now() + reconcileRetryDelay(state.failures);
        }
        api.logger.warn(`fi-user: detached discovery source=${key} error=${state.error}`);
      }
    }
    if (!refreshAt && keys.every((candidate) => refreshable(scans.get(candidate)))) {
      refreshAt = Date.now() + 300_000;
    }
    return summary();
  };
  return {
    reconcile: run,
    /** A fresh service start retries every backed-off channel and root once. */
    resetBackoff: () => {
      for (const scan of scans.values()) {
        scan.failures = 0;
        scan.retryAt = undefined;
        for (const retry of scan.failed.values()) {
          retry.failures = 0;
          retry.retryAt = 0;
        }
      }
    },
    invalidate: (sessionKey: string) => {
      const channelId = PARENT.exec(sessionKey)?.[2]?.toUpperCase();
      if (!channelId) {
        return;
      }
      // Live parent activity is new work: restart the channel on the backlog
      // cadence, keeping each failed root's backoff.
      for (const [key, scan] of scans) {
        if (key.endsWith(`:${channelId}`) && (scan.done || scan.background)) {
          scans.set(key, newScan(false, scan));
          refreshAt = 0;
        }
      }
    },
  };
}
