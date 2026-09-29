import { createPersistentDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import {
  createPluginStateErrorReporter,
  type PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { getOptionalSlackRuntime } from "./runtime.js";

/**
 * Cache of Slack threads the bot has participated in.
 * Used to auto-respond in threads without requiring @mention after the first reply.
 */

const MAX_ENTRIES = 5000;
const PERSISTENT_MAX_ENTRIES = 1000;
const MAX_FAILURE_NOTICES = 1000;
const PERSISTENT_NAMESPACE = "slack.thread-participation";
const THREAD_OWNER_PERSISTENT_NAMESPACE = "slack.thread-owner";

type SlackThreadParticipationRecord = {
  agentId?: string;
  repliedAt: number;
};

/**
 * Keep Slack thread participation shared across bundled chunks so thread
 * auto-reply gating does not diverge between prepare/dispatch call paths.
 */
const SLACK_THREAD_PARTICIPATION_KEY = Symbol.for("openclaw.slackThreadParticipation");
const SLACK_THREAD_FAILURE_NOTICES_KEY = Symbol.for("openclaw.slackThreadFailureNotices");
const SLACK_THREAD_OWNER_KEY = Symbol.for("openclaw.slackThreadOwner");
const threadParticipation = createPersistentDedupeCache<SlackThreadParticipationRecord>({
  globalKey: SLACK_THREAD_PARTICIPATION_KEY,
  // Participation remains valid until bounded oldest-entry eviction removes it.
  ttlMs: 0,
  maxSize: MAX_ENTRIES,
  persistent: {
    namespace: PERSISTENT_NAMESPACE,
    maxEntries: PERSISTENT_MAX_ENTRIES,
    openStore: (options) => getOptionalSlackRuntime()?.state.openKeyedStore(options),
    logError: createPluginStateErrorReporter(
      getOptionalSlackRuntime,
      "slack",
      "thread-participation-state",
      "Slack persistent thread participation state failed",
    ),
  },
});
const threadFailureNotices = resolveGlobalSingleton(
  SLACK_THREAD_FAILURE_NOTICES_KEY,
  () => new Map<string, string>(),
  (notices) => notices.clear(),
);

type SlackThreadOwnerRecord = {
  accountId: string;
  claimedAt: number;
};

type SlackThreadOwnerCache = {
  owners: Map<string, SlackThreadOwnerRecord>;
  claims: Map<string, Promise<unknown>>;
  peers: Map<string, SlackThreadOwnerPeer>;
  store?: PluginStateKeyedStore<SlackThreadOwnerRecord>;
  disabled: boolean;
};

/**
 * Live view of another Slack account in this gateway, so each account can
 * decide ownership from the same facts instead of racing the other's claim.
 */
export type SlackThreadOwnerPeer = {
  botUserId: () => string | undefined;
  /** Whether the account answers an unmentioned top-level message in this channel. */
  answersUnmentioned: (channelId: string, channelName?: string) => boolean;
};

const threadOwners = resolveGlobalSingleton<SlackThreadOwnerCache>(
  SLACK_THREAD_OWNER_KEY,
  () => ({ owners: new Map(), claims: new Map(), peers: new Map(), disabled: false }),
  (cache) => {
    cache.owners.clear();
    cache.claims.clear();
    cache.peers.clear();
    cache.store = undefined;
    cache.disabled = false;
  },
);

/** Registers a running Slack account as a thread-ownership peer; returns the unregister hook. */
export function registerSlackThreadOwnerPeer(
  accountId: string,
  peer: SlackThreadOwnerPeer,
): () => void {
  threadOwners.peers.set(accountId, peer);
  return () => {
    if (threadOwners.peers.get(accountId) === peer) {
      threadOwners.peers.delete(accountId);
    }
  };
}

export function getSlackThreadOwnerPeer(accountId: string): SlackThreadOwnerPeer | undefined {
  return threadOwners.peers.get(accountId);
}

/** Serializes read-modify-write claims per thread so concurrent handlers see one owner. */
function withThreadOwnerClaimLock<T>(key: string, claim: () => Promise<T>): Promise<T> {
  const previous = threadOwners.claims.get(key) ?? Promise.resolve();
  const result = previous.then(claim, claim);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  threadOwners.claims.set(key, settled);
  void settled.then(() => {
    if (threadOwners.claims.get(key) === settled) {
      threadOwners.claims.delete(key);
    }
  });
  return result;
}

const reportThreadOwnerStateError = createPluginStateErrorReporter(
  getOptionalSlackRuntime,
  "slack",
  "thread-owner-state",
  "Slack persistent thread owner state failed",
);

function makeKey(accountId: string, channelId: string, threadTs: string, teamId?: string): string {
  return `${accountId}:${teamId ? `${teamId}:` : ""}${channelId}:${threadTs}`;
}

function makeThreadOwnerKey(channelId: string, threadTs: string, teamId?: string): string {
  return `${teamId ? `${teamId}:` : ""}${channelId}:${threadTs}`;
}

function rememberSlackThreadOwner(key: string, owner: SlackThreadOwnerRecord): void {
  threadOwners.owners.delete(key);
  threadOwners.owners.set(key, owner);
  if (threadOwners.owners.size > MAX_ENTRIES) {
    const oldestKey = threadOwners.owners.keys().next().value;
    if (oldestKey !== undefined) {
      threadOwners.owners.delete(oldestKey);
    }
  }
}

function getSlackThreadOwnerStore(): PluginStateKeyedStore<SlackThreadOwnerRecord> | undefined {
  if (threadOwners.disabled) {
    return undefined;
  }
  if (threadOwners.store) {
    return threadOwners.store;
  }
  try {
    threadOwners.store = getOptionalSlackRuntime()?.state.openKeyedStore({
      namespace: THREAD_OWNER_PERSISTENT_NAMESPACE,
      maxEntries: PERSISTENT_MAX_ENTRIES,
    });
    return threadOwners.store;
  } catch (error) {
    threadOwners.disabled = true;
    reportThreadOwnerStateError(error);
    return undefined;
  }
}

function isSlackThreadOwnerRecord(value: unknown): value is SlackThreadOwnerRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SlackThreadOwnerRecord).accountId === "string" &&
    typeof (value as SlackThreadOwnerRecord).claimedAt === "number"
  );
}

async function readSlackThreadOwner(key: string): Promise<SlackThreadOwnerRecord | undefined> {
  const memoryOwner = threadOwners.owners.get(key);
  if (memoryOwner) {
    return memoryOwner;
  }
  const store = getSlackThreadOwnerStore();
  if (!store) {
    return undefined;
  }
  try {
    const storedOwner = await store.lookup(key);
    const concurrentOwner = threadOwners.owners.get(key);
    if (concurrentOwner) {
      return concurrentOwner;
    }
    if (!isSlackThreadOwnerRecord(storedOwner)) {
      return undefined;
    }
    rememberSlackThreadOwner(key, storedOwner);
    return storedOwner;
  } catch (error) {
    threadOwners.disabled = true;
    reportThreadOwnerStateError(error);
    return threadOwners.owners.get(key);
  }
}

/**
 * Atomically chooses the single Slack account allowed to continue a shared
 * thread. Explicit bot mentions intentionally replace the existing owner,
 * while implicit continuations preserve the first owner. Claims for one
 * thread are serialized, so an interleaved read never observes a stale owner.
 */
export async function claimSlackThreadOwner(params: {
  channelId: string;
  threadTs: string;
  candidateAccountIds: readonly string[];
  teamId?: string;
  force?: boolean;
}): Promise<string | undefined> {
  if (!params.channelId || !params.threadTs || params.candidateAccountIds.length === 0) {
    return undefined;
  }
  return await withThreadOwnerClaimLock(
    makeThreadOwnerKey(params.channelId, params.threadTs, params.teamId),
    () => claimSlackThreadOwnerUnlocked(params),
  );
}

async function claimSlackThreadOwnerUnlocked(params: {
  channelId: string;
  threadTs: string;
  candidateAccountIds: readonly string[];
  teamId?: string;
  force?: boolean;
}): Promise<string | undefined> {
  const candidateAccountId = params.candidateAccountIds.find(Boolean);
  if (!candidateAccountId) {
    return undefined;
  }
  const key = makeThreadOwnerKey(params.channelId, params.threadTs, params.teamId);
  if (!params.force) {
    const owner = await readSlackThreadOwner(key);
    if (owner) {
      return owner.accountId;
    }
  }
  const candidate = { accountId: candidateAccountId, claimedAt: Date.now() };
  const store = getSlackThreadOwnerStore();
  if (!store) {
    rememberSlackThreadOwner(key, candidate);
    return candidate.accountId;
  }
  try {
    if (params.force) {
      if (store.update) {
        await store.update(key, () => candidate);
      } else {
        await store.register(key, candidate);
      }
      rememberSlackThreadOwner(key, candidate);
      return candidate.accountId;
    }
    const inserted = await store.registerIfAbsent(key, candidate);
    if (inserted) {
      rememberSlackThreadOwner(key, candidate);
      return candidate.accountId;
    }
    const owner = await readSlackThreadOwner(key);
    return owner?.accountId;
  } catch (error) {
    threadOwners.disabled = true;
    reportThreadOwnerStateError(error);
    const owner = threadOwners.owners.get(key);
    if (owner) {
      return owner.accountId;
    }
    rememberSlackThreadOwner(key, candidate);
    return candidate.accountId;
  }
}

export function recordSlackThreadParticipation(
  accountId: string,
  channelId: string,
  threadTs: string,
  opts?: { agentId?: string; teamId?: string },
): void {
  if (!accountId || !channelId || !threadTs) {
    return;
  }
  void threadParticipation.register(makeKey(accountId, channelId, threadTs, opts?.teamId), {
    // Stored for future per-agent thread routing; current reads only need presence.
    ...(opts?.agentId ? { agentId: opts.agentId } : {}),
    repliedAt: Date.now(),
  });
}

export function hasSlackThreadParticipation(
  accountId: string,
  channelId: string,
  threadTs: string,
  teamId?: string,
): boolean {
  if (!accountId || !channelId || !threadTs) {
    return false;
  }
  return threadParticipation.peek(makeKey(accountId, channelId, threadTs, teamId));
}

export async function hasSlackThreadParticipationWithPersistence(params: {
  accountId: string;
  channelId: string;
  threadTs: string;
  teamId?: string;
}): Promise<boolean> {
  if (!params.accountId || !params.channelId || !params.threadTs) {
    return false;
  }
  return await threadParticipation.lookup(
    makeKey(params.accountId, params.channelId, params.threadTs, params.teamId),
  );
}

type SlackFailureNotice = {
  accountId: string;
  channelId: string;
  threadTs?: string;
  failureText: string;
  teamId?: string;
};

function makeFailureNoticeKey(params: Omit<SlackFailureNotice, "failureText">): string {
  const scope = params.threadTs ? `thread:${params.threadTs}` : "channel";
  return makeKey(params.accountId, params.channelId, scope, params.teamId);
}

/** Returns whether this failure was already delivered in the thread or channel. */
export function hasSlackThreadFailureNotice(params: SlackFailureNotice): boolean {
  const { accountId, channelId, failureText } = params;
  const fingerprint = failureText.trim().replace(/\s+/gu, " ");
  if (!accountId || !channelId || !fingerprint) {
    return false;
  }
  return threadFailureNotices.get(makeFailureNoticeKey(params)) === fingerprint;
}

/** Records a failure after it was delivered in the thread or channel. */
export function recordSlackThreadFailureNotice(params: SlackFailureNotice): boolean {
  const { accountId, channelId, failureText } = params;
  const fingerprint = failureText.trim().replace(/\s+/gu, " ");
  if (!accountId || !channelId || !fingerprint) {
    return false;
  }
  const key = makeFailureNoticeKey(params);
  if (threadFailureNotices.get(key) === fingerprint) {
    return false;
  }
  threadFailureNotices.delete(key);
  threadFailureNotices.set(key, fingerprint);
  if (threadFailureNotices.size > MAX_FAILURE_NOTICES) {
    const oldestKey = threadFailureNotices.keys().next().value;
    if (oldestKey !== undefined) {
      threadFailureNotices.delete(oldestKey);
    }
  }
  return true;
}

/** Clears a thread or channel outage notice after a healthy model turn completes. */
export function clearSlackThreadFailureNotice(params: {
  accountId: string;
  channelId: string;
  threadTs?: string;
  teamId?: string;
}): void {
  const { accountId, channelId } = params;
  if (!accountId || !channelId) {
    return;
  }
  threadFailureNotices.delete(makeFailureNoticeKey(params));
}

export function clearSlackThreadParticipationCache(): void {
  threadParticipation.clearForTest();
  threadFailureNotices.clear();
  threadOwners.owners.clear();
  threadOwners.claims.clear();
  threadOwners.peers.clear();
  threadOwners.store = undefined;
  threadOwners.disabled = false;
}
