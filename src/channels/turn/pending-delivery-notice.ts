import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  readSessionEntryReadOnlyInWorker,
  withSessionEntriesFromStoresInWorker,
} from "../../config/sessions/session-entry-read-runtime.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import { getGatewayLifecycleRuntime } from "../../gateway/server-lifecycle-runtime-context.js";
import { findDeliveryIntentOwner } from "../../infra/outbound/delivery-queue-storage.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.read.js";
import {
  deliveryContextKey,
  normalizeDeliveryContext,
} from "../../utils/delivery-context.shared.js";
import { hasActiveDirectPendingFinalDelivery } from "./direct-delivery-custody.js";

const PENDING_DELIVERY_NOTICE =
  "I couldn’t confirm whether my previous reply reached this chat, so I won’t resend it automatically. Please ask for any missing remainder.";

const MATRIX_NOTICE = "Delivery of an earlier reply could not be confirmed.";

export async function deliverPendingDeliveryNotice(
  sessionKey: string,
  storePath: string,
  agentId?: string,
): Promise<void> {
  const resolvedAgentId = agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  const scope = { agentId: resolvedAgentId, sessionKey, storePath };
  const pending = await withSessionEntriesFromStoresInWorker(
    [
      {
        agentId: resolvedAgentId,
        storePath,
        sessionKeys: [sessionKey],
        projection: "full",
      },
    ],
    ([read]) => {
      const entry = read?.result.entries[0]?.entry;
      const notice = entry?.pendingDeliveryNotice;
      const context = normalizeDeliveryContext(notice?.context);
      const runtime = getGatewayLifecycleRuntime();
      if (
        !entry ||
        !runtime ||
        !notice ||
        notice.state !== "owed" ||
        !context?.channel ||
        !context.to ||
        deliveryContextKey(context) !== deliveryContextKey(deliveryContextFromSession(entry)) ||
        hasActiveDirectPendingFinalDelivery(entry.sessionId, notice.intentId)
      ) {
        return undefined;
      }
      // Start under the reader's FIFO admission: settlement cannot invalidate owed debt first.
      read?.assertCurrent();
      const idempotencyKey = `main-session-restart-recovery:pending-final:${notice.intentId}`;
      const delivery = runtime
        .sendNotice({
          channel: context.channel,
          to: context.to,
          accountId: context.accountId,
          threadId: context.threadId,
          agentId: resolvedAgentId,
          ...(context.channel === "matrix"
            ? {
                text: MATRIX_NOTICE,
                replyDelivery: { triggerEventId: notice.sourceMessageId },
                assertDeliveryCurrent: async () => {
                  const current = await readSessionEntryReadOnlyInWorker({
                    ...scope,
                    projection: "full",
                  });
                  if (
                    current?.sessionId !== entry.sessionId ||
                    current.lifecycleRevision !== entry.lifecycleRevision ||
                    current.pendingDeliveryNotice?.intentId !== notice.intentId ||
                    current.pendingDeliveryNotice.state !== "owed" ||
                    deliveryContextKey(deliveryContextFromSession(current)) !==
                      deliveryContextKey(context)
                  ) {
                    throw new Error("Matrix delivery notice was superseded before publication");
                  }
                },
              }
            : { text: PENDING_DELIVERY_NOTICE }),
          idempotencyKey,
        })
        .catch(() => undefined);
      return { entry, notice, idempotencyKey, delivery, isMatrix: context.channel === "matrix" };
    },
    { ordered: true },
  );
  if (!pending) {
    return;
  }
  const { entry, notice, idempotencyKey } = pending;
  const outcome = await pending.delivery;
  let delivered: boolean;
  if (outcome) {
    delivered = !outcome.suppressed;
  } else {
    const owner = await findDeliveryIntentOwner(idempotencyKey);
    if (owner?.status !== "completed" && owner?.status !== "failed") {
      return;
    }
    delivered = owner.status === "completed";
  }
  if (
    delivered &&
    !pending.isMatrix &&
    !(
      await appendAssistantMessageToSessionTranscript({
        agentId: resolvedAgentId,
        sessionKey,
        storePath,
        expectedSessionId: entry.sessionId,
        expectedLifecycleRevision: entry.lifecycleRevision ?? null,
        text: PENDING_DELIVERY_NOTICE,
        idempotencyKey,
      })
    ).ok
  ) {
    return;
  }
  await updateSessionEntry(
    { agentId: resolvedAgentId, sessionKey, storePath },
    (current) =>
      current.sessionId === entry.sessionId &&
      (current.lifecycleRevision ?? null) === (entry.lifecycleRevision ?? null) &&
      current.pendingDeliveryNotice?.intentId === notice.intentId &&
      current.pendingDeliveryNotice.state !== "acknowledged"
        ? {
            // Retain the terminal fact: queue settlement may replay after this
            // acknowledgment, and one intent must never owe its notice again.
            pendingDeliveryNotice: {
              ...current.pendingDeliveryNotice,
              state: delivered ? "acknowledged" : "unresolved",
            },
            updatedAt: Date.now(),
          }
        : null,
    { skipMaintenance: true, takeCacheOwnership: true },
  );
}
