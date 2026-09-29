import { createHash } from "node:crypto";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/core";
import { parseAgentSessionKey, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { CoreConfig } from "../types.js";
import { listMatrixAccountIds, resolveMatrixAccount } from "./accounts.js";
import { resolveMatrixInboundRoute } from "./monitor/route.js";
import { getMatrixProjectionStatus } from "./projection-source.js";
import { withResolvedMatrixSendClient } from "./send/client.js";
import {
  getMatrixThreadBindingManager,
  listAllBindings,
  resolveBindingKey,
} from "./thread-bindings-shared.js";

const bootstrapQueue = new KeyedAsyncQueue();

/** Operator-only registration of a provisioned native room, before its first run. */
export async function bootstrapMatrixSessionProjection(
  cfg: CoreConfig,
  params: Record<string, unknown>,
) {
  const required = (key: string, max: number) => {
    const value = typeof params[key] === "string" ? params[key].trim() : "";
    if (!value || value.length > max || /[\u0000-\u001f]/.test(value)) {
      throw new Error(`Invalid ${key}`);
    }
    return value;
  };
  const roomId = required("roomId", 255);
  const accountId = normalizeAccountId(required("accountId", 64));
  const environment = required("environment", 64);
  const conversationId = required("conversationId", 255);
  const agentId = required("agentId", 64);
  if (!roomId.startsWith("!") || params.targetSessionKey !== undefined) {
    throw new Error("Native bootstrap requires a room, not a supplied session target");
  }
  const account = resolveMatrixAccount({ cfg, accountId });
  if (
    !listMatrixAccountIds(cfg).includes(accountId) ||
    !account.enabled ||
    !account.configured ||
    !getMatrixThreadBindingManager(accountId)
  ) {
    throw new Error("Explicit configured Matrix account must be running");
  }
  // All accounts share the room fence: a second bot cannot seize a source room.
  const existing = () => {
    const rows = listAllBindings().filter(
      (row) => row.parentConversationId === roomId || row.conversationId === roomId,
    );
    if (!rows.length) return undefined;
    const row = rows[0];
    if (!row) throw new Error("Room binding disappeared during native bootstrap");
    if (
      rows.length !== 1 ||
      row.accountId !== accountId ||
      row.agentId !== agentId ||
      row.boundBy !== "session-projection" ||
      row.externalSource ||
      row.sourceReplyAuthorization ||
      !parseAgentSessionKey(row.targetSessionKey)?.rest.startsWith("matrix:") ||
      row.environment !== environment ||
      row.projectedConversationId !== conversationId ||
      row.parentConversationId !== roomId ||
      !row.conversationId.startsWith("$")
    ) {
      throw new Error("Room already has a different or source-backed owner");
    }
    return getMatrixProjectionStatus(roomId, accountId);
  };
  const persistExisting = async () => {
    const manager = getMatrixThreadBindingManager(accountId);
    if (!manager) throw new Error("Matrix account stopped during native registration");
    // A prior adapter bind may have updated memory before its disk write failed.
    // Never turn that retry into a successful but non-durable registration.
    await manager.persist();
    const result = existing();
    if (!result) throw new Error("Native conversation binding was not persisted");
    return result;
  };
  return bootstrapQueue.enqueue(roomId, async () => {
    return withResolvedMatrixSendClient({ cfg, accountId }, async (client) => {
      if (!(await client.getJoinedRooms()).includes(roomId)) {
        throw new Error("Configured Matrix bot must already be joined to the room");
      }
      const saved = existing();
      if (saved) return persistExisting();
      const senderId = await client.getUserId();
      const resolve = (threadId?: string) => {
        // Fi canonical conversations are provisioned room-channel bindings. A
        // registered thread then wins independently of a sender's DM heuristic.
        const result = resolveMatrixInboundRoute({
          cfg,
          accountId,
          roomId,
          senderId,
          isDirectMessage: false,
          threadId,
          resolveAgentRoute,
        });
        if (
          !result.bindingOwnerAvailable ||
          result.configuredBinding ||
          result.runtimeBindingId ||
          result.route.agentId !== agentId
        ) {
          throw new Error("Native Matrix route does not match the requested owner");
        }
        return result.route;
      };
      resolve();
      const transactionId = `projection-bootstrap:${createHash("sha256")
        .update(JSON.stringify([accountId, roomId, environment, conversationId]))
        .digest("hex")}`;
      const root = await client.sendEvent(
        roomId,
        "m.room.message",
        {
          msgtype: "m.notice",
          body: "Conversation ready",
          "ai.cellect.conversation.bootstrap": { version: 2 },
        },
        transactionId,
      );
      if (!root.startsWith("$") || root.length > 255) {
        throw new Error("Matrix did not return a valid native thread root");
      }
      if (
        resolveBindingKey({ accountId, conversationId: root, parentConversationId: roomId })
          .length > 256
      ) {
        throw new Error("Native binding exceeds the canonical identity limit");
      }
      const raced = existing();
      if (raced) return persistExisting();
      const route = resolve(root);
      await getSessionBindingService().bind({
        targetSessionKey: route.sessionKey,
        targetKind: "session",
        conversation: {
          channel: "matrix",
          accountId,
          conversationId: root,
          parentConversationId: roomId,
        },
        placement: "current",
        metadata: {
          agentId,
          environment,
          projectedConversationId: conversationId,
          boundBy: "session-projection",
          introText: false,
          idleTimeoutMs: 0,
          maxAgeMs: 0,
        },
      });
      return persistExisting();
    });
  });
}
