import { createHash } from "node:crypto";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { parseAgentSessionKey, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { CoreConfig } from "../types.js";
import { resolveMatrixAccountConfig } from "./account-config.js";
import { listMatrixAccountIds } from "./accounts.js";
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
  const [producer, joinedRooms, entries] = await Promise.all([
    params.client.getUserId(),
    params.client.getJoinedRooms(),
    params.core.state
      .openKeyedStore<MatrixProjectionExecution>({
        namespace: "projection-executions-v1",
        maxEntries: 10_000,
        overflowPolicy: "reject-new",
      })
      .entries(),
  ]);
  if (manager !== getMatrixThreadBindingManager(params.accountId)) {
    return;
  }
  const joined = new Set(joinedRooms);
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

function canonical(roomId: string) {
  const rows = listAllBindings().filter(
    (row) => row.parentConversationId === roomId || row.conversationId === roomId,
  );
  if (!rows.length) {
    return undefined;
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
  return row;
}

function matchesCurrent(execution: MatrixProjectionExecution, cfg: CoreConfig) {
  const row = canonical(execution.roomId);
  const account = resolveMatrixAccountConfig({ cfg, accountId: execution.accountId });
  if (
    !row ||
    resolveBindingKey(row) !== execution.canonicalBindingId ||
    row.environment !== execution.environment ||
    row.projectedConversationId !== execution.conversationId ||
    row.conversationId !== execution.threadRootEventId ||
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

/** Called only by authenticated native ingress, after access/mention routing and before dispatch. */
export async function admitMatrixProjectionExecution(params: {
  core: PluginRuntime;
  cfg: CoreConfig;
  client: Pick<MatrixClient, "getJoinedRooms" | "getUserId">;
  roomId: string;
  threadRootEventId?: string;
  accountId: string;
  agentId: string;
  sessionKey: string;
}): Promise<void> {
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
    canonicalBindingId: resolveBindingKey(row),
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
