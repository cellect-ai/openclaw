import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/core";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  normalizeOptionalString,
  asNonArrayRecord,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CoreConfig } from "../types.js";
import {
  READ_ONLY_SOURCE_HISTORY_NOTICE,
  SOURCE_HISTORY_SYNCHRONIZED_NOTICE,
} from "./binding-notice.js";
import { ProjectionError, projectionFailure } from "./projection-error.js";
import {
  SOURCE_AUTHORIZED_PROJECTION,
  resolveProjectionReplyUpgrade,
} from "./projection-reply-authorization.js";
import { resolveDetachedProjectionSource } from "./projection-source.js";
import {
  findProjectionBinding,
  MATRIX_SESSION_PROJECTION_BOUND_BY,
  resolveProjectionTarget,
  type ProjectionTarget,
} from "./projection-target.js";
import { sendMessageMatrix } from "./send.js";
import { withResolvedMatrixSendClient } from "./send/client.js";
import { projectInitialMessage, type ProjectionRole } from "./session-projection-delivery.js";
import { maintainExistingProjectionSnapshot } from "./session-projection-refresh.js";
import {
  reconcileMatrixProjectionSnapshot,
  sourceProjectionSnapshotDigest,
  type SourceProjectionSnapshot,
  parseSourceProjectionSnapshot,
} from "./session-projection-snapshot.js";
import { getMatrixThreadBindingManager, toSessionBindingRecord } from "./thread-bindings-shared.js";

export { MATRIX_SESSION_PROJECTION_BOUND_BY } from "./projection-target.js";
export { MATRIX_SESSION_PROJECTION_CONTENT_KEY } from "./session-projection-snapshot.js";

export { listReadOnlyMatrixSessionProjections } from "./projection-source.js";

export {
  handleMatrixSessionProjectionMessageReceived,
  handleMatrixSessionProjectionReplyPayloadSending,
} from "./session-projection-delivery.js";

const projectionCreationQueue = new KeyedAsyncQueue();

function clean(value: unknown): string {
  return normalizeOptionalString(value) ?? "";
}

/** Explicit operator repair for pre-shared history; never an implicit room-policy change. */
export async function rebaseMatrixSessionProjection(params: {
  cfg: CoreConfig;
  targetSessionKey: string;
  roomId: string;
  accountId?: string;
  expectedThreadRootEventId: string;
  sourceSnapshot: unknown;
}) {
  const snapshot = parseSourceProjectionSnapshot(params.sourceSnapshot);
  const target = resolveProjectionTarget(params);
  const { accountId, roomId, targetSessionKey, agentId } = target;
  const previousRootId = clean(params.expectedThreadRootEventId);
  if (!previousRootId.startsWith("$")) {
    throw new ProjectionError("invalid_request", "Expected projection root required");
  }
  return projectionCreationQueue.enqueue(`${accountId}\u0000${roomId}\u0000read-only`, async () => {
    const existing = findProjectionBinding(target, true);
    if (!existing || existing.metadata?.boundBy !== "session-projection-read-only") {
      throw new ProjectionError("readonly_required", "Existing read-only projection required");
    }
    return withResolvedMatrixSendClient(
      { cfg: params.cfg, accountId, timeoutMs: 10_000 },
      async (client) => {
        const base = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}`;
        const visibility = asNonArrayRecord(
          await client.doRequest("GET", `${base}/state/m.room.history_visibility/`),
        );
        if (visibility?.history_visibility !== "shared") {
          throw new ProjectionError(
            "history_policy_missing",
            "Shared history policy required before rebase",
          );
        }
        let root = existing.conversation.conversationId;
        const bindingService = getSessionBindingService();
        if (root !== previousRootId) {
          const event = asNonArrayRecord(
            await client.doRequest("GET", `${base}/event/${encodeURIComponent(root)}`),
          );
          const content = asNonArrayRecord(event?.content);
          const rebase = asNonArrayRecord(content?.["com.openclaw.projection_rebase"]);
          if (rebase?.previousRootId !== previousRootId) {
            throw new ProjectionError("generation_changed", "Projection generation changed");
          }
        } else {
          const sent = await sendMessageMatrix(
            `room:${roomId}`,
            "OpenClaw shared conversation history",
            {
              cfg: params.cfg,
              accountId,
              client,
              deliveryQueueId: `matrix-projection-rebase:${roomId}:${previousRootId}`,
              deliveryPartIndex: 0,
              deliveryPartCount: 1,
              extraContent: { "com.openclaw.projection_rebase": { previousRootId } },
            },
          );
          root = sent.messageId;
          await bindingService.bind({
            targetSessionKey,
            targetKind: "session",
            placement: "current",
            conversation: {
              channel: "matrix",
              accountId,
              conversationId: root,
              parentConversationId: roomId,
            },
            metadata: {
              agentId,
              boundBy: "session-projection-read-only",
              externalSource: existing.metadata?.externalSource,
              introText: READ_ONLY_SOURCE_HISTORY_NOTICE,
              idleTimeoutMs: 0,
              maxAgeMs: 0,
            },
          });
        }
        await reconcileMatrixProjectionSnapshot({
          cfg: params.cfg,
          accountId,
          roomId,
          threadId: root,
          snapshot,
          retireThreadId: previousRootId,
        });
        const obsolete =
          getMatrixThreadBindingManager(accountId)
            ?.listBindings()
            .filter(
              (binding) =>
                binding.parentConversationId === roomId &&
                binding.conversationId === previousRootId &&
                binding.boundBy === "session-projection-read-only",
            ) ?? [];
        for (const record of obsolete) {
          const binding = toSessionBindingRecord(record, { idleTimeoutMs: 0, maxAgeMs: 0 });
          await bindingService.unbind({
            bindingId: binding.bindingId,
            reason: "projection-history-rebased",
          });
        }
        return { status: "existing" as const, accountId, agentId, roomId, threadRootEventId: root };
      },
    );
  });
}

export async function handleMatrixSessionProjectionRebase({
  params,
  respond,
  context,
}: GatewayRequestHandlerOptions) {
  try {
    const result = await rebaseMatrixSessionProjection({
      cfg: context.getRuntimeConfig() as CoreConfig,
      targetSessionKey: clean(params?.targetSessionKey),
      roomId: clean(params?.roomId),
      accountId: clean(params?.accountId) || undefined,
      expectedThreadRootEventId: clean(params?.expectedThreadRootEventId),
      sourceSnapshot: params?.sourceSnapshot,
    });
    respond(true, result);
  } catch (error) {
    const failure = projectionFailure(error);
    respond(false, failure.payload, failure.error);
  }
}

/** Diagnostics must never create, touch, or replay a binding or its messages. */
export function inspectMatrixSessionProjection(params: ProjectionTarget) {
  const target = resolveProjectionTarget(params);
  const binding = findProjectionBinding(target);
  const { accountId, agentId, roomId } = target;
  return binding
    ? {
        status: "existing" as const,
        // Inspection is read-only, but callers that continue a conversation
        // need the immutable identity carried by every canonical publication.
        // Do not make a Matrix reader infer it from mutable display text.
        bindingId: binding.bindingId,
        environment:
          typeof binding.metadata?.environment === "string"
            ? binding.metadata.environment
            : undefined,
        conversationId:
          typeof binding.metadata?.projectedConversationId === "string"
            ? binding.metadata.projectedConversationId
            : undefined,
        accountId,
        agentId,
        roomId,
        threadRootEventId: binding.conversation.conversationId,
      }
    : { status: "missing" as const, accountId, agentId, roomId };
}

export async function createMatrixSessionProjection(params: {
  cfg: CoreConfig;
  channelRuntime?: PluginRuntime["channel"];
  targetSessionKey: string;
  roomId: string;
  environment?: string;
  conversationId?: string;
  sourceActorId?: string;
  accountId?: string;
  label?: string;
  readOnly?: boolean;
  sourceDirect?: boolean;
  sourceDetached?: boolean;
  sourceReplyAuthorization?: string;
  /** Explicit operator/application repair: reconcile a changed complete snapshot into an existing projection. */
  refreshSourceSnapshot?: boolean;
  externalSource?: unknown;
  sourceSnapshot?: SourceProjectionSnapshot;
  initialMessage?: {
    sourceChannel?: string;
    content?: string;
    messageId?: string;
    runId?: string;
    role?: ProjectionRole;
    senderId?: string;
    agentId?: string;
  };
}): Promise<{
  status: "created" | "existing";
  bindingId: string;
  accountId: string;
  agentId: string;
  roomId: string;
  threadRootEventId: string;
  targetSessionKey: string;
  sourceReplyAuthorization?: string;
}> {
  const target = resolveProjectionTarget(params);
  const { targetSessionKey, accountId, agentId, roomId } = target;
  const environment = clean(params.environment);
  const conversationId = clean(params.conversationId);
  if (
    Boolean(environment) !== Boolean(conversationId) ||
    environment.length > 64 ||
    conversationId.length > 255
  ) {
    throw new ProjectionError(
      "invalid_request",
      "Projection environment and conversationId must be supplied together",
    );
  }

  const label = (clean(params.label) || `${agentId} session`).slice(0, 160);
  const externalSource = resolveDetachedProjectionSource({ ...params, targetSessionKey });
  if (params.sourceDetached) {
    parseSourceProjectionSnapshot(params.sourceSnapshot);
  }
  if (params.sourceDirect) {
    if (!/^agent:[^:]+:slack:direct:[uw][a-z0-9]+$/i.test(targetSessionKey)) {
      throw new ProjectionError(
        "invalid_request",
        "Source direct projection requires a canonical Slack DM session",
      );
    }
    parseSourceProjectionSnapshot(params.sourceSnapshot);
  }
  if (
    params.sourceSnapshot &&
    !params.readOnly &&
    !params.sourceDirect &&
    !params.sourceReplyAuthorization
  ) {
    throw new ProjectionError("invalid_request", "Source snapshots require a read-only projection");
  }
  if (params.refreshSourceSnapshot && !params.sourceSnapshot) {
    throw new ProjectionError(
      "snapshot_incomplete",
      "Snapshot refresh requires a complete source snapshot",
    );
  }
  const sourceSnapshotDigest = params.sourceSnapshot
    ? sourceProjectionSnapshotDigest(params.sourceSnapshot)
    : undefined;
  return await projectionCreationQueue.enqueue(
    `${accountId}\u0000${roomId}\u0000${params.readOnly || params.sourceReplyAuthorization ? "read-only" : targetSessionKey}`,
    async () => {
      const bindingService = getSessionBindingService();
      let existing = findProjectionBinding(
        target,
        params.readOnly || Boolean(params.sourceReplyAuthorization),
      );
      let authorizedSource: Awaited<ReturnType<typeof resolveProjectionReplyUpgrade>> | undefined;
      if (params.sourceReplyAuthorization) {
        if (!params.channelRuntime) {
          throw new ProjectionError(
            "source_auth_unavailable",
            "Requested source reply authorization is unavailable",
          );
        }
        authorizedSource = await resolveProjectionReplyUpgrade({
          channelRuntime: params.channelRuntime,
          targetSessionKey,
          externalSource,
          protocol: params.sourceReplyAuthorization,
          readOnly: params.readOnly,
          existing,
        });
        if (
          existing &&
          (existing.metadata?.boundBy !== SOURCE_AUTHORIZED_PROJECTION ||
            existing.metadata?.sourceReplyAuthorization !== params.sourceReplyAuthorization)
        ) {
          existing = await bindingService.bind({
            targetSessionKey,
            targetKind: "session",
            placement: "current",
            conversation: existing.conversation,
            metadata: {
              ...existing.metadata,
              agentId,
              label,
              boundBy: SOURCE_AUTHORIZED_PROJECTION,
              ...authorizedSource,
              // A metadata-only rebind of an existing thread must not re-post
              // the binder's "session active" intro into the transcript.
              introText: false,
              idleTimeoutMs: 0,
              maxAgeMs: 0,
            },
          });
        }
      }
      if (existing && environment) {
        if (
          (existing.metadata?.environment && existing.metadata.environment !== environment) ||
          (existing.metadata?.projectedConversationId &&
            existing.metadata.projectedConversationId !== conversationId)
        ) {
          throw new ProjectionError(
            "ownership_changed",
            "Projection conversation ownership cannot change",
          );
        }
        if (!existing.metadata?.environment) {
          existing = await bindingService.bind({
            targetSessionKey,
            targetKind: "session",
            placement: "current",
            conversation: existing.conversation,
            metadata: {
              ...existing.metadata,
              environment,
              projectedConversationId: conversationId,
              introText: false,
            },
          });
        }
      }
      if (existing && params.sourceActorId) {
        if (
          existing.metadata?.sourceActorId &&
          existing.metadata.sourceActorId !== params.sourceActorId
        ) {
          throw new ProjectionError("ownership_changed", "Projection source actor cannot change");
        }
        if (!existing.metadata?.sourceActorId) {
          existing = await bindingService.bind({
            targetSessionKey,
            targetKind: "session",
            placement: "current",
            conversation: existing.conversation,
            metadata: {
              ...existing.metadata,
              sourceActorId: params.sourceActorId,
              introText: false,
            },
          });
        }
      }
      if (existing) {
        if (
          params.sourceDetached &&
          JSON.stringify(existing.metadata?.externalSource) !== JSON.stringify(externalSource)
        ) {
          throw new ProjectionError("source_changed", "Projection external source cannot change");
        }
        if (
          params.sourceDirect &&
          !params.readOnly &&
          !params.sourceReplyAuthorization &&
          existing.metadata?.boundBy === "session-projection-read-only"
        ) {
          throw new ProjectionError(
            "readonly_conflict",
            "Read-only direct projection cannot become writable",
          );
        }
        if (
          params.sourceDirect &&
          !params.readOnly &&
          !params.sourceReplyAuthorization &&
          existing.metadata?.boundBy !== "session-projection-slack-direct"
        ) {
          existing = await bindingService.bind({
            targetSessionKey,
            targetKind: "session",
            placement: "current",
            conversation: existing.conversation,
            metadata: {
              agentId,
              label,
              boundBy: "session-projection-slack-direct",
              introText: SOURCE_HISTORY_SYNCHRONIZED_NOTICE,
              idleTimeoutMs: 0,
              maxAgeMs: 0,
            },
          });
        }
        if (
          params.readOnly === true &&
          existing.metadata?.boundBy !== "session-projection-read-only"
        ) {
          throw new ProjectionError("readonly_conflict", "Existing projection is writable");
        }
        // Retry callers may race the original hook or arrive after a prior
        // bind. The narrow in-process reservation and durable delivery key
        // make this safe without replaying any earlier transcript.
        await projectInitialMessage({
          cfg: params.cfg,
          targetSessionKey,
          initialMessage: params.initialMessage,
          binding: existing,
        });
        // Routine discovery adopts a checkpoint without replay. An explicit
        // application repair may reconcile changed history into this same root.
        existing = await maintainExistingProjectionSnapshot({
          cfg: params.cfg,
          accountId,
          roomId,
          targetSessionKey,
          existing,
          snapshot: params.sourceSnapshot,
          digest: sourceSnapshotDigest,
          refresh: params.refreshSourceSnapshot,
        });
        return {
          status: "existing" as const,
          bindingId: existing.bindingId,
          environment: existing.metadata?.environment,
          conversationId: existing.metadata?.projectedConversationId,
          accountId,
          agentId,
          roomId,
          threadRootEventId: existing.conversation.conversationId,
          targetSessionKey,
          sourceReplyAuthorization:
            typeof existing.metadata?.sourceReplyAuthorization === "string"
              ? existing.metadata.sourceReplyAuthorization
              : undefined,
        };
      }

      let binding = await bindingService.bind({
        targetSessionKey,
        targetKind: "session",
        conversation: {
          channel: "matrix",
          accountId,
          conversationId: roomId,
        },
        placement: "child",
        metadata: {
          agentId,
          label,
          ...(environment ? { environment, projectedConversationId: conversationId } : {}),
          ...(params.sourceActorId ? { sourceActorId: params.sourceActorId } : {}),
          externalSource: params.sourceDetached ? externalSource : undefined,
          ...(authorizedSource
            ? {
                externalSource: authorizedSource.externalSource,
                sourceAccountId: authorizedSource.sourceAccountId,
              }
            : {}),
          sourceReplyAuthorization: params.sourceReplyAuthorization,
          boundBy: authorizedSource
            ? SOURCE_AUTHORIZED_PROJECTION
            : params.readOnly
              ? "session-projection-read-only"
              : params.sourceDirect
                ? "session-projection-slack-direct"
                : MATRIX_SESSION_PROJECTION_BOUND_BY,
          introText: `OpenClaw session mirror · ${label}`,
          // Session projections follow the canonical session lifecycle, not the
          // shorter subagent-thread defaults used by ordinary Matrix bindings.
          idleTimeoutMs: 0,
          maxAgeMs: 0,
        },
      });

      await projectInitialMessage({
        cfg: params.cfg,
        targetSessionKey,
        initialMessage: params.initialMessage,
        binding,
      });
      if (params.sourceSnapshot) {
        await reconcileMatrixProjectionSnapshot({
          cfg: params.cfg,
          accountId,
          roomId,
          threadId: binding.conversation.conversationId,
          snapshot: params.sourceSnapshot,
        });
        binding = await bindingService.bind({
          targetSessionKey,
          targetKind: "session",
          placement: "current",
          conversation: binding.conversation,
          metadata: {
            ...binding.metadata,
            introText: false,
            sourceSnapshotDigest,
            sourceSnapshotReconciledAtMs: Date.now(),
          },
        });
      }
      return {
        status: "created" as const,
        bindingId: binding.bindingId,
        environment: binding.metadata?.environment,
        conversationId: binding.metadata?.projectedConversationId,
        accountId,
        agentId,
        roomId,
        threadRootEventId: binding.conversation.conversationId,
        targetSessionKey,
        sourceReplyAuthorization: params.sourceReplyAuthorization,
      };
    },
  );
}

export async function handleMatrixSessionProjectionCreate(
  { params, respond, context }: GatewayRequestHandlerOptions,
  channelRuntime: PluginRuntime["channel"],
): Promise<void> {
  try {
    const result = await createMatrixSessionProjection({
      cfg: context.getRuntimeConfig() as CoreConfig,
      channelRuntime,
      targetSessionKey: clean(params?.targetSessionKey),
      roomId: clean(params?.roomId),
      environment: clean(params?.environment) || undefined,
      conversationId: clean(params?.conversationId) || undefined,
      sourceActorId: clean(params?.sourceActorId) || undefined,
      accountId: clean(params?.accountId) || undefined,
      label: clean(params?.label) || undefined,
      readOnly: params?.readOnly === true,
      sourceDirect: params?.sourceDirect === true,
      sourceDetached: params?.sourceDetached === true,
      sourceReplyAuthorization: clean(params?.sourceReplyAuthorization) || undefined,
      refreshSourceSnapshot: params?.refreshSourceSnapshot === true,
      externalSource: params?.externalSource,
      sourceSnapshot: params?.sourceSnapshot as SourceProjectionSnapshot | undefined,
      initialMessage:
        params?.initialMessage && typeof params.initialMessage === "object"
          ? {
              sourceChannel: clean(
                (params.initialMessage as Record<string, unknown>).sourceChannel,
              ),
              content: clean((params.initialMessage as Record<string, unknown>).content),
              messageId: clean((params.initialMessage as Record<string, unknown>).messageId),
              runId: clean((params.initialMessage as Record<string, unknown>).runId),
              role:
                (params.initialMessage as Record<string, unknown>).role === "assistant"
                  ? "assistant"
                  : "user",
              senderId: clean((params.initialMessage as Record<string, unknown>).senderId),
              agentId: clean((params.initialMessage as Record<string, unknown>).agentId),
            }
          : undefined,
    });
    respond(true, result);
  } catch (error) {
    const failure = projectionFailure(error);
    respond(false, failure.payload, failure.error);
  }
}

export function handleMatrixSessionProjectionInspect({
  params,
  respond,
  context,
}: GatewayRequestHandlerOptions): void {
  try {
    respond(
      true,
      inspectMatrixSessionProjection({
        cfg: context.getRuntimeConfig() as CoreConfig,
        targetSessionKey: clean(params?.targetSessionKey),
        roomId: clean(params?.roomId),
        accountId: clean(params?.accountId) || undefined,
      }),
    );
  } catch (error) {
    const failure = projectionFailure(error);
    respond(false, failure.payload, failure.error);
  }
}
