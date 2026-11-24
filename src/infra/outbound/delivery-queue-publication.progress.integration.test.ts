import { expect, it, vi } from "vitest";
import {
  bindReplyPublication,
  registerReplyPublicationReceiptListener,
  requireReplyPublicationReceipt,
} from "../../auto-reply/reply-publication.js";
import type { ChannelMessageSendTextContext } from "../../channels/message/types.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";
import {
  installRecoveryHooks,
  seedDeliverySession,
} from "./delivery-completion.shard-test-support.js";
import { enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import { loadPendingDeliveries } from "./delivery-queue.test-helpers.js";
import { createUnmodifiedPreparedOutboundBatch } from "./prepared-batch.js";

const fixtures = installRecoveryHooks(false);
async function seedNativeFinal() {
  const { scope, entry } = await seedDeliverySession(fixtures.tmpDir(), {
    pendingFinalDelivery: {
      kind: "transport-only",
      createdAt: 1,
      intentId: "native-final-intent",
      sourceRunId: "run",
      sourceGeneration: "native-generation",
      dispatchState: "open",
      context: { channel: "matrix", to: "!room:example", accountId: "default" },
      deliveries: [{ id: "native-final-member", state: "prepared" }],
    },
  });
  return {
    scope,
    completion: {
      kind: "pending-final" as const,
      agentId: "main",
      storePath: scope.storePath,
      sessionKey: scope.sessionKey,
      sessionId: entry.sessionId,
      intentId: "native-final-intent",
      deliveryId: "native-final-member",
    },
  };
}
it.each(
  (["live", "recovery"] as const).flatMap((mode) =>
    ["$first", "$last"].map((primaryId) => ({ mode, primaryId })),
  ),
)(
  "captures a distinct final aggregate after progress before mutable observers ($mode, $primaryId)",
  async ({ mode, primaryId }) => {
    const payload = { text: "synthetic final answer" };
    const publication = bindReplyPublication(
      {},
      { payload, kind: "final", channel: "matrix", sessionKey: "session", runId: "run" },
    );
    requireReplyPublicationReceipt(payload);
    const send = vi.fn(async (context: ChannelMessageSendTextContext) => {
      await context.onDeliveryResult?.({
        messageId: "$first",
        receipt: {
          primaryPlatformMessageId: "$first",
          platformMessageIds: ["$first"],
          parts: [{ platformMessageId: "$first", kind: "text", index: 0 }],
          sentAt: 1,
        },
      });
      await context.onDeliveryResult?.({
        messageId: "$last",
        receipt: {
          primaryPlatformMessageId: "$last",
          platformMessageIds: ["$last"],
          parts: [{ platformMessageId: "$last", kind: "text", index: 0 }],
          sentAt: 2,
        },
      });
      // Native core replaces both progress objects with this distinct hook-bearing receipt.
      return {
        messageId: "$first",
        receipt: {
          primaryPlatformMessageId: primaryId,
          platformMessageIds: ["$first", "$last"],
          parts: [
            { platformMessageId: "$first", kind: "text" as const, index: 0 },
            { platformMessageId: "$last", kind: "text" as const, index: 1 },
          ],
          sentAt: 2,
        },
      };
    });
    const plugin = createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest });
    plugin.message = { send: { text: send }, durableFinal: { capabilities: { text: true } } };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "matrix", source: "test", plugin }]));
    const accepted = vi.fn(async () => {});
    const release = registerReplyPublicationReceiptListener(accepted);
    const nativeSend: typeof fixtures.deliver = (params) =>
      fixtures.deliver({
        ...params,
        onDeliveryResult: async (result) => {
          await params.onDeliveryResult?.(result);
          // The caller cannot replace accepted provider evidence after the core capture.
          result.receipt!.platformMessageIds = ["$observer"];
          result.receipt!.parts[0]!.platformMessageId = "$observer";
        },
        onPayloadDeliveryOutcome: (outcome) => {
          params.onPayloadDeliveryOutcome?.(outcome);
          if (outcome.status !== "sent") return;
          for (const result of outcome.results) {
            result.messageId = "$observer";
            result.receipt!.primaryPlatformMessageId = "$observer";
            result.receipt!.platformMessageIds = ["$observer-a", "$observer-b", "$observer-c"];
            result.receipt!.parts = result.receipt!.platformMessageIds.map(
              (platformMessageId, index) => ({
                platformMessageId,
                kind: "text",
                index,
              }),
            );
          }
        },
      });
    const native = await seedNativeFinal();
    const params = {
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      accountId: "default",
      payloads: [payload],
      runId: "run",
      session: { key: native.scope.sessionKey, agentId: "main" },
      deliveryCompletion: native.completion,
      queuePolicy: "required" as const,
      preparedBatch: { ...createUnmodifiedPreparedOutboundBatch([payload]), runId: "run" },
    };
    try {
      if (mode === "live") await nativeSend(params);
      else {
        await enqueueDeliveryOnce(params, "progress-aggregate-final", fixtures.tmpDir());
        await fixtures.recover(nativeSend);
      }
      expect(accepted).toHaveBeenCalledExactlyOnceWith(
        { ...publication, receiptRequired: true },
        expect.objectContaining({ messageId: "$last", conversationId: "!room:example" }),
      );
      expect(await loadPendingDeliveries(fixtures.tmpDir())).toEqual([]);
      const nativeEntry = await readSessionEntryReadOnlyInWorker(native.scope);
      expect(nativeEntry?.pendingFinalDelivery?.deliveries).toEqual([
        {
          id: "native-final-member",
          state: "delivered",
          receipt: {
            platformMessageId: primaryId,
            finalPlatformMessageId: "$last",
            resultCount: 2,
          },
        },
      ]);
      await fixtures.recover(nativeSend);
      expect(send).toHaveBeenCalledTimes(1);
      expect(accepted).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
  },
);

it.each(
  (["live", "recovery"] as const).flatMap((mode) =>
    (["adapter_returned_no_identity", "adapter_returned_no_send"] as const).map((reason) => ({
      mode,
      reason,
    })),
  ),
)(
  "retains mixed complete and incomplete physical sends without ACK or resend ($mode, $reason)",
  async ({ mode, reason }) => {
    const final = { text: "complete source final" };
    bindReplyPublication(
      {},
      {
        payload: final,
        kind: "final",
        channel: "matrix",
        sessionKey: "session",
        runId: "run",
      },
    );
    requireReplyPublicationReceipt(final);
    // This later payload has no publication. Its partial physical send still belongs to
    // the canonical batch and must not disappear from the queue's completion decision.
    const trailing = { text: "trailing nonpublication payload" };
    const receipt = (id: string) => ({
      primaryPlatformMessageId: id,
      platformMessageIds: [id],
      parts: [{ platformMessageId: id, kind: "text" as const, index: 0 }],
      sentAt: 1,
    });
    const send = vi.fn(async (context: ChannelMessageSendTextContext) => {
      if (context.text === final.text)
        return { messageId: "$complete", receipt: receipt("$complete") };
      await context.onDeliveryResult?.({
        messageId: "$partial-last",
        receipt: receipt("$partial-last"),
      });
      return {
        messageId: "",
        ...(reason === "adapter_returned_no_send" ? { outcome: "not_sent" as const } : {}),
        receipt: { platformMessageIds: [], parts: [], sentAt: 2 },
      };
    });
    const plugin = createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest });
    plugin.message = { send: { text: send }, durableFinal: { capabilities: { text: true } } };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "matrix", source: "test", plugin }]));
    const accepted = vi.fn(async () => {});
    const release = registerReplyPublicationReceiptListener(accepted);
    const observedIncomplete: string[] = [];
    const nativeSend: typeof fixtures.deliver = (params) =>
      fixtures.deliver({
        ...params,
        onPayloadDeliveryOutcome: (outcome) => {
          params.onPayloadDeliveryOutcome?.(outcome);
          if (outcome.status === "sent" && outcome.incompleteReason) {
            observedIncomplete.push(outcome.incompleteReason);
            // Observer mutation cannot turn physical progress into canonical completion.
            delete outcome.incompleteReason;
          }
        },
      });
    const native = await seedNativeFinal();
    const payloads = [final, trailing];
    const params = {
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      accountId: "default",
      payloads,
      runId: "run",
      session: { key: native.scope.sessionKey, agentId: "main" },
      deliveryCompletion: native.completion,
      queuePolicy: "required" as const,
      retryAmbiguousFinalText: true as const,
      preparedBatch: { ...createUnmodifiedPreparedOutboundBatch(payloads), runId: "run" },
    };
    try {
      if (mode === "live")
        await expect(nativeSend(params)).rejects.toThrow("incomplete physical result");
      else {
        await enqueueDeliveryOnce(params, "mixed-incomplete-physical-result", fixtures.tmpDir());
        expect((await fixtures.recover(nativeSend)).failed).toBe(1);
      }
      expect(observedIncomplete).toEqual([reason]);
      const nativeEntry = await readSessionEntryReadOnlyInWorker(native.scope);
      const member = nativeEntry?.pendingFinalDelivery?.deliveries?.[0];
      expect(member).toBeDefined();
      expect(member!.state).not.toBe("delivered");
      expect(member!.receipt).toBeUndefined();
      expect(send).toHaveBeenCalledTimes(2);
      expect(accepted).not.toHaveBeenCalled();
      expect(await loadPendingDeliveries(fixtures.tmpDir())).toEqual([
        expect.objectContaining({ recoveryState: "unknown_after_send" }),
      ]);
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
      try {
        // Make the row due for recovery. Even with ordinary final retry enabled,
        // incomplete identified sends cannot acquire blind replay authority.
        expect((await fixtures.recover(nativeSend)).failed).toBe(1);
      } finally {
        clock.mockRestore();
      }
      expect(send).toHaveBeenCalledTimes(2);
      expect(accepted).not.toHaveBeenCalled();
      expect(await loadPendingDeliveries(fixtures.tmpDir())).toEqual([
        expect.objectContaining({ recoveryState: "unknown_after_send" }),
      ]);
    } finally {
      release();
    }
  },
);
