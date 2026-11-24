import { expect, it, vi } from "vitest";
import {
  bindReplyPublication,
  registerReplyPublicationReceiptListener,
  requireReplyPublicationReceipt,
} from "../../auto-reply/reply-publication.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";
import { installRecoveryHooks } from "./delivery-completion.shard-test-support.js";
import { flushDeliveryPublications } from "./delivery-queue-publication.js";
import { loadPendingDeliveries } from "./delivery-queue.test-helpers.js";
import { createUnmodifiedPreparedOutboundBatch } from "./prepared-batch.js";

const fixtures = installRecoveryHooks(false);
it.each([false, true])(
  "an observer cannot change whole-batch suppression authority (native no-send %s)",
  async (nativeNoSend) => {
    const payload = { text: "synthetic final" };
    bindReplyPublication(
      {},
      { payload, kind: "final", channel: "matrix", sessionKey: "session", runId: "run" },
    );
    requireReplyPublicationReceipt(payload);
    const send = vi.fn(async () => ({
      messageId: "",
      ...(nativeNoSend ? { outcome: "not_sent" as const } : {}),
      receipt: { platformMessageIds: [], parts: [], sentAt: 1 },
    }));
    const plugin = createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest });
    plugin.message = { send: { text: send }, durableFinal: { capabilities: { text: true } } };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "matrix", source: "test", plugin }]));
    const accepted = vi.fn(async () => {});
    const stop = registerReplyPublicationReceiptListener(accepted);
    try {
      const delivered = fixtures.deliver({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        accountId: "default",
        session: { key: "session", agentId: "main" },
        payloads: [payload],
        preparedBatch: { ...createUnmodifiedPreparedOutboundBatch([payload]), runId: "run" },
        queuePolicy: "required",
        onPayloadDeliveryOutcome: (outcome) => {
          if (outcome.status === "suppressed") {
            outcome.reason = nativeNoSend
              ? "adapter_returned_no_identity"
              : "adapter_returned_no_send";
            if (nativeNoSend) outcome.index = 99;
          }
        },
      });
      await expect(delivered).resolves.toEqual([]);
      const pending = await loadPendingDeliveries(fixtures.tmpDir());
      expect(pending).toEqual(
        nativeNoSend ? [] : [expect.objectContaining({ recoveryState: "unknown_after_send" })],
      );
      await flushDeliveryPublications({ stateDir: fixtures.tmpDir() });
      expect(await loadPendingDeliveries(fixtures.tmpDir())).toEqual(pending);
      expect(accepted).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  },
);
