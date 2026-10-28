import { createHash } from "node:crypto";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { parseAgentSessionKey, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { CoreConfig } from "../types.js";
import { resolveMatrixAccountConfig } from "./account-config.js";
import { listMatrixAccountIds, resolveMatrixAccount } from "./accounts.js";
import { resolveMatrixInboundRoute } from "./monitor/route.js";
import type { MatrixClient } from "./sdk.js";
import {
  getMatrixThreadBindingManager,
  listAllBindings,
  resolveBindingKey,
} from "./thread-bindings-shared.js";

/** Execution admission, never a routing binding or source-publication authorization. */
export type MatrixProjectionExecution = {
  version: 1;
  environment: string;
  conversationId: string;
  roomId: string;
  canonicalBindingId: string;
  threadRootEventId: string;
  accountId: string;
  agentId: string;
  sessionKey: string;
  producerMxid: string;
};

const admissionQueue = new KeyedAsyncQueue();
const admitted = new Map<
  string,
  {
    execution: MatrixProjectionExecution;
    manager: ReturnType<typeof getMatrixThreadBindingManager>;
  }
>();

/**
 * Fi seated a bot of this gateway in a room whose canonical binding row lives
 * on another gateway (a Superadmin chat with a tenant agent, or the reverse).
 * Execution admission still requires native ingress and a non-default route;
 * this record only names the binding such a run reports its lifecycle under.
 */
type MatrixRelatedCanonical = CanonicalRoom & { version: 1; roomId: string };

const RELATED_NAMESPACE = "projection-related-canonical-v1";
const related = new Map<string, CanonicalRoom>();

function relatedStore(core: PluginRuntime) {
  return core.state.openKeyedStore<MatrixRelatedCanonical>({
    namespace: RELATED_NAMESPACE,
    maxEntries: 10_000,
    overflowPolicy: "reject-new",
  });
}

function relatedKey(roomId: string) {
  return createHash("sha256").update(roomId).digest("hex");
}

/** `<owner account>:<room>:<$root>`, as resolveBindingKey shapes it on the owning gateway. */
function relatedThreadRoot(bindingId: string, roomId: string): string | undefined {
  const marker = `:${roomId}:`;
  const index = bindingId.lastIndexOf(marker);
  const owner = bindingId.slice(0, index);
  const root = bindingId.slice(index + marker.length);
  return index > 0 &&
    bindingId.length <= 256 &&
    !/[\s\u0000-\u001f\u007f]/.test(bindingId) &&
    !owner.includes(":") &&
    /^\$\S{1,254}$/.test(root)
    ? root
    : undefined;
}

function decodeRelated(value: unknown, entryKey: string): MatrixRelatedCanonical | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const text = (field: string) =>
    typeof row[field] === "string" && row[field] && (row[field] as string).length <= 1024;
  if (
    row.version !== 1 ||
    !["roomId", "bindingId", "environment", "projectedConversationId", "threadRootEventId"].every(
      text,
    )
  ) {
    return undefined;
  }
  const record = value as MatrixRelatedCanonical;
  return record.roomId.startsWith("!") &&
    relatedKey(record.roomId) === entryKey &&
    relatedThreadRoot(record.bindingId, record.roomId) === record.threadRootEventId
    ? record
    : undefined;
}

function key(execution: MatrixProjectionExecution) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        execution.environment,
        execution.conversationId,
        execution.roomId,
        execution.threadRootEventId,
        execution.accountId,
        execution.agentId,
      ]),
    )
    .digest("hex");
}

function same(left: unknown, right: MatrixProjectionExecution): boolean {
  if (!left || typeof left !== "object" || Array.isArray(left)) {
    return false;
  }
  const value = left as Record<string, unknown>;
  return Object.keys(right).every((field) => value[field] === right[field as keyof typeof right]);
}

function decode(value: unknown): MatrixProjectionExecution | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  if (row.version !== 1) {
    return undefined;
  }
  for (const field of [
    "environment",
    "conversationId",
    "roomId",
    "canonicalBindingId",
    "threadRootEventId",
    "accountId",
    "agentId",
    "sessionKey",
    "producerMxid",
  ]) {
    const text = row[field];
    if (typeof text !== "string" || !text || text.length > 1024) {
      return undefined;
    }
    for (const character of text) {
      if (character.charCodeAt(0) < 0x20) {
        return undefined;
      }
    }
  }
  const execution = value as MatrixProjectionExecution;
  return execution.roomId.startsWith("!") &&
    execution.threadRootEventId.startsWith("$") &&
    execution.producerMxid.startsWith("@") &&
    parseAgentSessionKey(execution.sessionKey)?.agentId === execution.agentId
    ? execution
    : undefined;
}

/** Account startup restores persisted relationships, not routing or run authority.
 * Canonical rows can load in either account order; the resolver checks them at use.
 */
export async function restoreMatrixProjectionExecutions(params: {
  core: PluginRuntime;
  client: Pick<MatrixClient, "getJoinedRooms" | "getUserId">;
  accountId: string;
}): Promise<void> {
  const manager = getMatrixThreadBindingManager(params.accountId);
  if (!manager) {
    return;
  }
  const [producer, joinedRooms, entries, relatedEntries] = await Promise.all([
    params.client.getUserId(),
    params.client.getJoinedRooms(),
    params.core.state
      .openKeyedStore<MatrixProjectionExecution>({
        namespace: "projection-executions-v1",
        maxEntries: 10_000,
        overflowPolicy: "reject-new",
      })
      .entries(),
    relatedStore(params.core).entries(),
  ]);
  if (manager !== getMatrixThreadBindingManager(params.accountId)) {
    return;
  }
  const joined = new Set(joinedRooms);
  for (const entry of relatedEntries) {
    const record = decodeRelated(entry.value, entry.key);
    if (record && joined.has(record.roomId)) {
      related.set(record.roomId, {
        bindingId: record.bindingId,
        environment: record.environment,
        projectedConversationId: record.projectedConversationId,
        threadRootEventId: record.threadRootEventId,
      });
    }
  }
  for (const entry of entries) {
    const execution = decode(entry.value);
    if (
      execution &&
      execution.accountId === params.accountId &&
      execution.producerMxid === producer &&
      joined.has(execution.roomId) &&
      key(execution) === entry.key
    ) {
      admitted.set(entry.key, { execution, manager });
    }
  }
}

/** A room's canonical projection binding, whichever gateway holds its binding row. */
type CanonicalRoom = {
  bindingId: string;
  environment: string;
  projectedConversationId: string;
  threadRootEventId: string;
};

function localRows(roomId: string) {
  return listAllBindings().filter(
    (row) => row.parentConversationId === roomId || row.conversationId === roomId,
  );
}

function canonical(roomId: string): CanonicalRoom | undefined {
  const rows = localRows(roomId);
  if (!rows.length) {
    // Only a room with no binding row of this gateway may follow another
    // gateway's canonical binding; a local row always decides alone.
    return related.get(roomId);
  }
  const row = rows[0];
  // Source-backed rooms keep their existing source owner; this relation cannot
  // transfer Slack/source custody to a seated native Matrix account.
  if (
    rows.length !== 1 ||
    !row ||
    row.boundBy !== "session-projection" ||
    row.externalSource ||
    row.sourceReplyAuthorization ||
    !parseAgentSessionKey(row.targetSessionKey)?.rest.startsWith("matrix:") ||
    !row.environment ||
    !row.projectedConversationId ||
    row.parentConversationId !== roomId ||
    !row.conversationId.startsWith("$")
  ) {
    return undefined;
  }
  return {
    bindingId: resolveBindingKey(row),
    environment: row.environment,
    projectedConversationId: row.projectedConversationId,
    threadRootEventId: row.conversationId,
  };
}

function matchesCurrent(execution: MatrixProjectionExecution, cfg: CoreConfig) {
  const row = canonical(execution.roomId);
  const account = resolveMatrixAccountConfig({ cfg, accountId: execution.accountId });
  if (
    !row ||
    row.bindingId !== execution.canonicalBindingId ||
    row.environment !== execution.environment ||
    row.projectedConversationId !== execution.conversationId ||
    row.threadRootEventId !== execution.threadRootEventId ||
    cfg.channels?.matrix?.enabled === false ||
    account.enabled === false ||
    !listMatrixAccountIds(cfg).includes(execution.accountId) ||
    !getMatrixThreadBindingManager(execution.accountId) ||
    (account.userId && account.userId !== execution.producerMxid)
  ) {
    return false;
  }
  const resolved = resolveMatrixInboundRoute({
    cfg,
    accountId: execution.accountId,
    roomId: execution.roomId,
    senderId: "",
    isDirectMessage: false,
    threadId: execution.threadRootEventId,
    resolveAgentRoute: (input) =>
      resolveAgentRoute({ ...input, defaultAgentId: execution.agentId }),
  });
  return (
    resolved.bindingOwnerAvailable &&
    !resolved.configuredBinding &&
    !resolved.pluginId &&
    resolved.route.matchedBy !== "default" &&
    (!resolved.runtimeBindingId || resolved.runtimeBindingId === execution.canonicalBindingId) &&
    resolved.route.agentId === execution.agentId &&
    resolved.route.sessionKey === execution.sessionKey
  );
}

type AdmissionParams = {
  core: PluginRuntime;
  cfg: CoreConfig;
  client: Pick<MatrixClient, "getJoinedRooms" | "getUserId">;
  roomId: string;
  threadRootEventId?: string;
  accountId: string;
  agentId: string;
  sessionKey: string;
};

/** Called only by authenticated native ingress, after access/mention routing and before dispatch. */
export async function admitMatrixProjectionExecution(params: AdmissionParams): Promise<void> {
  if (localRows(params.roomId).length || !related.has(params.roomId)) {
    return admitCanonicalExecution(params);
  }
  // Another gateway owns this room. Before relate existed such a run was
  // dispatched without lifecycle; a refused relation must not now drop the turn.
  try {
    await admitCanonicalExecution(params);
  } catch {
    // The run proceeds unadmitted and publishes no lifecycle, as before.
  }
}

async function admitCanonicalExecution(params: AdmissionParams): Promise<void> {
  const row = canonical(params.roomId);
  if (!row) {
    if (
      listAllBindings().some(
        (binding) =>
          binding.parentConversationId === params.roomId &&
          binding.boundBy === "session-projection" &&
          binding.environment &&
          binding.projectedConversationId &&
          !binding.externalSource &&
          !binding.sourceReplyAuthorization &&
          parseAgentSessionKey(binding.targetSessionKey)?.rest.startsWith("matrix:"),
      )
    ) {
      throw new Error("Matrix execution admission refused: canonical_binding_conflict");
    }
    return;
  }
  const manager = getMatrixThreadBindingManager(params.accountId);
  const environment = row.environment;
  const conversationId = row.projectedConversationId;
  if (!environment || !conversationId) {
    return;
  }
  const execution: MatrixProjectionExecution = {
    version: 1,
    environment,
    conversationId,
    roomId: params.roomId,
    canonicalBindingId: row.bindingId,
    threadRootEventId: params.threadRootEventId ?? "",
    accountId: params.accountId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    producerMxid: await params.client.getUserId(),
  };
  const currentCfg = () => (params.core.config.current?.() ?? params.cfg) as CoreConfig;
  const assertCurrent = () => {
    if (
      !manager ||
      manager !== getMatrixThreadBindingManager(params.accountId) ||
      !execution.producerMxid.startsWith("@") ||
      !matchesCurrent(execution, currentCfg())
    ) {
      throw new Error("Matrix execution admission refused: identity_mismatch");
    }
    for (const { execution: other, manager: otherManager } of admitted.values()) {
      if (
        other.sessionKey === execution.sessionKey &&
        other.agentId === execution.agentId &&
        other.accountId !== execution.accountId &&
        otherManager === getMatrixThreadBindingManager(other.accountId) &&
        matchesCurrent(other, currentCfg())
      ) {
        throw new Error("Matrix execution admission refused: execution_owner_conflict");
      }
    }
  };
  assertCurrent();
  if (!(await params.client.getJoinedRooms()).includes(params.roomId)) {
    throw new Error("Matrix execution admission refused: producer_not_joined");
  }
  assertCurrent();
  // Accounts can intentionally share one native session key. Serialize that
  // execution owner, rather than inferring one from the configured account set.
  await admissionQueue.enqueue(execution.sessionKey, async () => {
    assertCurrent();
    // Plugin KV is already worker-backed SQLite. This namespace stores only
    // independently typed execution relationships, not a second room registry.
    const store = params.core.state.openKeyedStore<MatrixProjectionExecution>({
      namespace: "projection-executions-v1",
      maxEntries: 10_000,
      overflowPolicy: "reject-new",
    });
    const saved = await store.lookup(key(execution));
    assertCurrent();
    if (saved && !same(saved, execution)) {
      throw new Error("Matrix execution admission refused: relation_conflict");
    }
    if (!saved) {
      await store.registerIfAbsent(key(execution), execution);
      const committed = await store.lookup(key(execution));
      if (!same(committed, execution)) {
        throw new Error("Matrix execution admission refused: relation_conflict");
      }
    }
    assertCurrent();
    admitted.set(key(execution), { execution, manager });
  });
}

export function resolveMatrixProjectionExecutions(
  owner: { agentId: string; sessionKey: string },
  cfg: CoreConfig,
): MatrixProjectionExecution[] {
  for (const [id, { execution, manager }] of admitted) {
    if (manager !== getMatrixThreadBindingManager(execution.accountId)) {
      admitted.delete(id);
    }
  }
  const matching = [...admitted.values()].flatMap(({ execution, manager }) =>
    execution.agentId === owner.agentId &&
    execution.sessionKey === owner.sessionKey &&
    manager === getMatrixThreadBindingManager(execution.accountId) &&
    matchesCurrent(execution, cfg)
      ? [execution]
      : [],
  );
  // A restored contradictory relationship cannot select two senders for one
  // native session. Native ingress reports execution_owner_conflict on retry.
  return matching.length > 1 ? [] : matching;
}

const relateQueue = new KeyedAsyncQueue();

function sameRelated(left: MatrixRelatedCanonical, right: MatrixRelatedCanonical) {
  return (Object.keys(right) as (keyof MatrixRelatedCanonical)[]).every(
    (field) => left[field] === right[field],
  );
}

/**
 * Operator-only: Fi seated this gateway's bot in a room whose canonical binding
 * row is another gateway's. Records which binding the bot's runs report under;
 * a room this gateway itself holds a binding row for is answered `local`.
 */
export async function relateMatrixProjectionCanonical(params: {
  core: PluginRuntime;
  cfg: CoreConfig;
  client: Pick<MatrixClient, "getJoinedRooms">;
  request: Record<string, unknown>;
}) {
  const required = (field: string, max: number) => {
    const value = params.request[field];
    const text = typeof value === "string" ? value.trim() : "";
    if (!text || text.length > max || /[\u0000-\u001f]/.test(text)) {
      throw new Error(`Invalid ${field}`);
    }
    return text;
  };
  const roomId = required("roomId", 255);
  const accountId = normalizeAccountId(required("accountId", 64));
  const environment = required("environment", 64);
  const conversationId = required("conversationId", 255);
  const agentId = required("agentId", 64);
  const bindingId = required("bindingId", 256);
  const threadRootEventId = roomId.startsWith("!")
    ? relatedThreadRoot(bindingId, roomId)
    : undefined;
  if (!threadRootEventId) {
    throw new Error("Invalid bindingId");
  }
  const account = resolveMatrixAccount({ cfg: params.cfg, accountId });
  if (
    !listMatrixAccountIds(params.cfg).includes(accountId) ||
    !account.enabled ||
    !account.configured ||
    !getMatrixThreadBindingManager(accountId)
  ) {
    throw new Error("Explicit configured Matrix account must be running");
  }
  const record: MatrixRelatedCanonical = {
    version: 1,
    roomId,
    bindingId,
    environment,
    projectedConversationId: conversationId,
    threadRootEventId,
  };
  const result = (status: "local" | "related") => ({
    status,
    roomId,
    bindingId,
    environment,
    conversationId,
    threadRootEventId,
    accountId,
  });
  return relateQueue.enqueue(roomId, async () => {
    if (!(await params.client.getJoinedRooms()).includes(roomId)) {
      throw new Error("Configured Matrix bot must already be joined to the room");
    }
    if (localRows(roomId).length) {
      const local = canonical(roomId);
      if (
        local?.bindingId === bindingId &&
        local.environment === environment &&
        local.projectedConversationId === conversationId
      ) {
        return result("local");
      }
      throw new Error("Room already has a different or source-backed owner");
    }
    const resolved = resolveMatrixInboundRoute({
      cfg: params.cfg,
      accountId,
      roomId,
      senderId: "",
      isDirectMessage: false,
      threadId: threadRootEventId,
      resolveAgentRoute: (input) => resolveAgentRoute({ ...input, defaultAgentId: agentId }),
    });
    if (
      !resolved.bindingOwnerAvailable ||
      resolved.configuredBinding ||
      resolved.pluginId ||
      resolved.runtimeBindingId ||
      resolved.route.matchedBy === "default" ||
      resolved.route.agentId !== agentId
    ) {
      throw new Error("Native Matrix route does not match the requested owner");
    }
    const store = relatedStore(params.core);
    const entryKey = relatedKey(roomId);
    const stored = await store.lookup(entryKey);
    const saved = stored === undefined ? undefined : decodeRelated(stored, entryKey);
    if (stored !== undefined && (!saved || !sameRelated(saved, record))) {
      throw new Error("Matrix canonical relation refused: relation_conflict");
    }
    if (!saved) {
      await store.registerIfAbsent(entryKey, record);
      const committed = decodeRelated(await store.lookup(entryKey), entryKey);
      if (!committed || !sameRelated(committed, record)) {
        throw new Error("Matrix canonical relation refused: relation_conflict");
      }
    }
    related.set(roomId, {
      bindingId,
      environment,
      projectedConversationId: conversationId,
      threadRootEventId,
    });
    return result("related");
  });
}

/** Test seam: the related-room cache is process state restored from plugin SQLite. */
export function resetMatrixRelatedCanonicalForTests() {
  related.clear();
}
