import { assert, expect, it, vi } from "vitest";
import { persistPendingFinalDeliveryMarker } from "../../agents/pending-final-delivery-marker.js";
import {
  bindReplyPublication,
  registerReplyPublicationReceiptListener,
  requireReplyPublicationReceipt,
} from "../../auto-reply/reply-publication.js";
import {
  nativeFinalDeliveryReference,
  retainNativeFinalDeliveryReceipt,
} from "../../auto-reply/reply/native-final-delivery.js";
import { resolvePendingFinalDeliveryBatchCompletion } from "../../auto-reply/reply/pending-final-delivery.js";
import type { ChannelMessageSendTextContext } from "../../channels/message/types.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { isOutboundDeliveryError } from "./deliver-types.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";
import {
  installRecoveryHooks,
  seedDeliverySession,
} from "./delivery-completion.shard-test-support.js";
import {
  DeliveryPublicationPendingError,
  findDeliveryPublicationPendingError,
  flushDeliveryPublications,
} from "./delivery-queue-publication.js";
import { enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import { createOutboundPayloadPlan, projectOutboundPayloadPlanForOutbound } from "./payloads.js";
import { createUnmodifiedPreparedOutboundBatch } from "./prepared-batch.js";

const fixtures = installRecoveryHooks(false);
it.each(
  (["live", "recovery", "ack-listener-failure"] as const).flatMap((mode) =>
    (["all-delivered", "mixed", "all-suppressed"] as const)
      .filter((disposition) => mode !== "ack-listener-failure" || disposition !== "all-suppressed")
      .map((disposition) => ({ mode, disposition })),
  ),
)(
  "retains native command members through $mode with $disposition without host clear",
  async ({ mode, disposition }) => {
    const mixed = disposition === "mixed";
    const allSuppressed = disposition === "all-suppressed";
    const { scope, entry } = await seedDeliverySession(fixtures.tmpDir());
    const destination = { channel: "matrix", to: "!original:example", accountId: "default" };
    const raw = [{ text: "first" }, { text: "last" }];
    await persistPendingFinalDeliveryMarker({
      ...scope,
      deliver: true,
      sessionStore: { [scope.sessionKey]: entry },
      sessionEntry: entry,
      suppressVisibleSessionEffects: false,
      sessionReboundDuringRun: false,
      payloads: raw,
      deliveryContext: destination,
      runOwnedSessionId: entry.sessionId,
      sourceRunId: "command-run",
      sourceGeneration: "command-generation",
    });
    const payloads = projectOutboundPayloadPlanForOutbound(createOutboundPayloadPlan(raw));
    const completion = resolvePendingFinalDeliveryBatchCompletion(payloads);
    assert(completion?.memberDeliveryIds?.length === 2);
    for (const payload of payloads) {
      const nativeFinal = nativeFinalDeliveryReference(payload);
      assert(nativeFinal);
      await retainNativeFinalDeliveryReceipt(nativeFinal, "matrix-binding");
      bindReplyPublication(
        {},
        {
          payload,
          kind: "final",
          channel: "matrix",
          sessionKey: scope.sessionKey,
          runId: "command-run",
          nativeFinal,
        },
      );
      requireReplyPublicationReceipt(payload);
    }
    const send = vi.fn(async (context: ChannelMessageSendTextContext) =>
      allSuppressed || (mixed && context.text === "last")
        ? {
            messageId: "",
            outcome: "not_sent" as const,
            receipt: { platformMessageIds: [], parts: [], sentAt: 1 },
          }
        : {
            messageId: `$${context.text}`,
            receipt: {
              primaryPlatformMessageId: `$${context.text}`,
              platformMessageIds: [`$${context.text}`],
              parts: [{ platformMessageId: `$${context.text}`, kind: "text" as const, index: 0 }],
              sentAt: 1,
            },
          },
    );
    const plugin = createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest });
    plugin.message = { send: { text: send }, durableFinal: { capabilities: { text: true } } };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "matrix", source: "test", plugin }]));
    let refuse = mode === "ack-listener-failure";
    const accepted: string[] = [];
    const stop = registerReplyPublicationReceiptListener(async (publication, receipt) => {
      expect(publication.nativeFinal?.intentId).toBe(completion.intentId);
      if (refuse) throw new Error("projection offline after canonical ACK");
      accepted.push(receipt.messageId);
    });
    const params = {
      cfg: {},
      ...destination,
      session: { key: scope.sessionKey, agentId: scope.agentId },
      payloads,
      preparedBatch: { ...createUnmodifiedPreparedOutboundBatch(payloads), runId: "command-run" },
      deliveryCompletion: completion,
      deliveryIntentId: completion.deliveryId,
      queuePolicy: "required" as const,
    };
    try {
      if (mode === "recovery") {
        await enqueueDeliveryOnce(params, completion.deliveryId, fixtures.tmpDir());
        await fixtures.recover(fixtures.deliver);
      } else if (refuse) {
        // The native wrapper carries released send custody; the owed publication is its cause.
        const failure = await fixtures.deliver(params).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(isOutboundDeliveryError(failure) && failure.queueCustody).toBe("released");
        expect(findDeliveryPublicationPendingError(failure)).toBeInstanceOf(
          DeliveryPublicationPendingError,
        );
      } else {
        await fixtures.deliver(params);
      }
      // No command host post-run cleanup has executed: the native worker owns this receipt.
      const restored = await readSessionEntryReadOnlyInWorker(scope);
      expect(restored?.pendingFinalDelivery).toBeUndefined();
      expect(restored?.completedFinalDeliveries?.[0]).toMatchObject({
        sourceRunId: "command-run",
        projectionConsumers: ["matrix-binding"],
        deliveries: [
          allSuppressed
            ? { id: completion.memberDeliveryIds[0], state: "suppressed" }
            : {
                id: completion.memberDeliveryIds[0],
                state: "delivered",
                receipt: { finalPlatformMessageId: "$first" },
              },
          mixed || allSuppressed
            ? { id: completion.memberDeliveryIds[1], state: "suppressed" }
            : {
                id: completion.memberDeliveryIds[1],
                state: "delivered",
                receipt: { finalPlatformMessageId: "$last" },
              },
        ],
      });
      refuse = false;
      await flushDeliveryPublications({ stateDir: fixtures.tmpDir() });
      expect(accepted).toEqual(allSuppressed ? [] : mixed ? ["$first"] : ["$first", "$last"]);
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  },
);
