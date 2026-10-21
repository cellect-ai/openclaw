import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { resolveAgentRoute, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import type { CoreConfig } from "../types.js";
import { resolveMatrixAccountConfig } from "./account-config.js";
import { listMatrixAccountIds } from "./accounts.js";
import { resolveMatrixInboundRoute } from "./monitor/route.js";
import { withResolvedMatrixSendClient } from "./send/client.js";
import {
  listAllBindings,
  getMatrixThreadBindingManager,
  toSessionBindingRecord,
} from "./thread-bindings-shared.js";

type LifecycleHandle = ReturnType<
  OpenClawPluginApi["runtime"]["events"]["registerConversationLifecycleTransport"]
>;
let activeLifecycle: LifecycleHandle | undefined;

export function resolveMatrixProjectionRun(runId: string, sessionKey: string) {
  return activeLifecycle?.resolveRun(runId, sessionKey);
}

export function noteMatrixProjectionFinalResult(
  result: Parameters<LifecycleHandle["noteResult"]>[0],
) {
  activeLifecycle?.noteResult(result);
}

export function startMatrixProjectionLifecycle(api: OpenClawPluginApi) {
  const handle = api.runtime.events.registerConversationLifecycleTransport({
    transportId: "matrix-conversation-v2",
    resolveBindings: (owner) => {
      const direct = getSessionBindingService().listBySession(owner.sessionKey);
      // Native rooms keep one durable conversation identity. A seated bot uses
      // its own execution session/account, but publishes under that same identity.
      // Derive participants from the real route so restart needs no second store.
      const cfg = (api.runtime.config.current?.() ?? api.config) as CoreConfig;
      const rows = listAllBindings();
      const native = rows.flatMap((row) => {
        const roomId = row.parentConversationId;
        if (
          !roomId ||
          row.boundBy !== "session-projection" ||
          row.externalSource ||
          row.sourceReplyAuthorization ||
          !row.conversationId.startsWith("$") ||
          !parseAgentSessionKey(row.targetSessionKey)?.rest.startsWith("matrix:") ||
          // Native bootstrap admits exactly one binding per room, across accounts.
          rows.some(
            (other) =>
              other !== row &&
              (other.parentConversationId === roomId || other.conversationId === roomId),
          )
        )
          return [];
        const accounts = listMatrixAccountIds(cfg).filter((accountId) => {
          if (
            cfg.channels?.matrix?.enabled === false ||
            resolveMatrixAccountConfig({ cfg, accountId }).enabled === false ||
            !getMatrixThreadBindingManager(accountId)
          )
            return false;
          const resolved = resolveMatrixInboundRoute({
            cfg,
            accountId,
            roomId,
            senderId: "",
            isDirectMessage: false,
            threadId: row.conversationId,
            resolveAgentRoute,
          });
          return (
            resolved.bindingOwnerAvailable &&
            resolved.route.matchedBy !== "default" &&
            !resolved.pluginId &&
            !resolved.configuredBinding &&
            !resolved.runtimeBindingId &&
            resolved.route.sessionKey === owner.sessionKey &&
            resolved.route.agentId === owner.agentId
          );
        });
        const accountId = accounts[0];
        if (accounts.length !== 1 || !accountId) return [];
        const binding = toSessionBindingRecord(row, { idleTimeoutMs: 0, maxAgeMs: 0 });
        return [
          {
            ...binding,
            targetSessionKey: owner.sessionKey,
            conversation: { ...binding.conversation, accountId },
            metadata: { ...binding.metadata, agentId: owner.agentId },
          },
        ];
      });
      return [...direct, ...native].flatMap((binding) => {
        const metadata = binding.metadata;
        const roomId = binding.conversation.parentConversationId;
        if (
          binding.conversation.channel !== "matrix" ||
          !roomId ||
          typeof metadata?.environment !== "string" ||
          !metadata.environment ||
          typeof metadata.projectedConversationId !== "string" ||
          !metadata.projectedConversationId ||
          // listBySession already selected this Slack/Matrix owner. A
          // source-authorized bind can omit agentId; skip only a mismatch.
          (Boolean(metadata.agentId) && metadata.agentId !== owner.agentId)
        )
          return [];
        return [
          {
            environment: metadata.environment,
            conversationId: metadata.projectedConversationId,
            roomId,
            bindingId: binding.bindingId,
            accountId: binding.conversation.accountId,
            threadRootEventId: binding.conversation.conversationId,
            sessionKey: owner.sessionKey,
            agentId: owner.agentId,
          },
        ];
      });
    },
    publish: async (binding, event, transactionId) => {
      await withResolvedMatrixSendClient(
        {
          cfg: (api.runtime.config.current?.() ?? api.config) as CoreConfig,
          accountId: binding.accountId,
        },
        async (client) => {
          await client.sendEvent(
            binding.roomId,
            "m.cellect.conversation.lifecycle",
            { ...event },
            transactionId,
          );
        },
      );
    },
    // Decision cards are recorded and sent only while the core switch for them
    // is on; this is the Matrix half of that path, a card in the run's thread.
    publishDecision: async (binding, content, transactionId) => {
      await withResolvedMatrixSendClient(
        {
          // SAFETY: This is the same host runtime config used as CoreConfig by lifecycle sends above.
          cfg: (api.runtime.config.current?.() ?? api.config) as CoreConfig,
          accountId: binding.accountId,
        },
        async (client) => {
          await client.sendEvent(binding.roomId, "m.room.message", content, transactionId);
        },
      );
    },
    isDestinationGone: (error) => {
      const refusal = error as { errcode?: unknown; data?: { errcode?: unknown } } | null;
      const errcode = refusal?.errcode ?? refusal?.data?.errcode;
      return errcode === "M_FORBIDDEN" || errcode === "M_NOT_FOUND";
    },
    onError: (error, detail) => {
      // Do not log raw transport errors (URLs, tokens, or private event data).
      // A bounded error class still distinguishes SQLite contention from stale
      // invocation authority and wire failures instead of hiding the cause.
      const name =
        error instanceof Error && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(error.name)
          ? error.name
          : "unknown";
      const reason =
        error instanceof Error && error.message === "Channel read authority is no longer active."
          ? "channel_read_closed"
          : name;
      // Room ids locate the failing destination; no event content is logged.
      if (detail?.reason === "room_parked") {
        api.logger.warn(
          `matrix: lifecycle room parked, the homeserver refused the send room=${detail.roomId}`,
        );
        return;
      }
      if (detail?.reason === "row_stuck") {
        api.logger.warn(
          `matrix: lifecycle row set aside and still failing, later rows proceed failures=${detail.failures} room=${detail.roomId}`,
        );
        return;
      }
      if (detail?.reason === "status_abandoned") {
        api.logger.warn(
          `matrix: lifecycle status abandoned after a month undelivered room=${detail.roomId}`,
        );
        return;
      }
      if (detail?.reason === "terminal_after_interrupted") {
        api.logger.warn(
          `matrix: lifecycle run finished after it was published interrupted room=${detail.roomId}`,
        );
        return;
      }
      if (detail?.reason === "backlog_capped") {
        api.logger.warn(
          `matrix: lifecycle backlog capped, superseded run states are shed room=${detail.roomId}`,
        );
        return;
      }
      api.logger.warn(
        `matrix: lifecycle publication remains in durable custody (${reason})${
          detail ? ` room=${detail.roomId} attempt=${detail.failures}` : ""
        }`,
      );
    },
  });
  activeLifecycle = handle;
  return {
    stop: () => {
      if (activeLifecycle === handle) activeLifecycle = undefined;
      handle.stop();
    },
  };
}
