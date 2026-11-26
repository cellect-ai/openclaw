import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelMessageSendTextContext } from "../../channels/message/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.test-support.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import {
  boundedCronCompletionRetention,
  drainMatrixReconnect,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import type { DeliverFn } from "./delivery-queue-recovery.js";
import { loadCompletedDeliveryReceipt } from "./delivery-queue-storage.js";
import { installDeliveryQueueTmpDirHooks } from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

describe("exact Matrix delivery queue reconciliation", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let tmpDir: string;

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });

  beforeEach(() => {
    tmpDir = fixtures.tmpDir();
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it.each([
    ["required", false],
    ["best_effort", false],
    ["required", true],
  ] as const)(
    "settles one exact Matrix %s send (provider handoff aborted: %s)",
    async (queuePolicy, abortBeforeDispatch) => {
      process.env.OPENCLAW_STATE_DIR = tmpDir;
      const deliveryIntentId = `cron-direct-delivery:v1:exact-${queuePolicy}-completion`;
      const messageId = `exact-${queuePolicy}-message`;
      const reconcileUnknownSend = vi.fn();
      const sendText = vi.fn(async (ctx: ChannelMessageSendTextContext) => {
        expect(ctx.deliveryQueueId).toBe(deliveryIntentId);
        await ctx.onPlatformSendDispatch?.();
        return {
          messageId,
          receipt: createMessageReceiptFromOutboundResults({
            results: [{ channel: "matrix", messageId }],
            kind: "text",
          }),
        };
      });
      if (abortBeforeDispatch) {
        sendText.mockRejectedValueOnce(
          new PlatformMessageNotDispatchedError("pre-wire abort", {
            cause: new DOMException("This operation was aborted", "AbortError"),
            retryable: true,
          }),
        );
      }
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "matrix",
            source: "test",
            plugin: {
              ...createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
              message: {
                id: "matrix",
                durableFinal: {
                  capabilities: { text: true, reconcileUnknownSend: true },
                  reconcileUnknownSendKinds: { text: true },
                  reconcileUnknownSend,
                },
                send: { text: sendText },
              },
            },
          },
        ]),
      );
      const params = {
        cfg: {} as OpenClawConfig,
        channel: "matrix" as const,
        to: "!room:example",
        payloads: [{ text: "send exactly once with durable platform identity" }],
        queuePolicy,
        ...(queuePolicy === "best_effort" ? { bestEffort: true } : {}),
        deliveryIntentId,
        completionRetention: boundedCronCompletionRetention,
        reusePendingDeliveryIntent: true,
        requireUnknownSendReconciliation: true,
      };

      if (abortBeforeDispatch) {
        await expect(deliverOutboundPayloads(params)).rejects.toThrow("pre-wire abort");
        expect(
          getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
        ).toBe("pending");
        await drainMatrixReconnect({ deliver: deliverOutboundPayloads, stateDir: tmpDir });
      } else {
        await expect(deliverOutboundPayloads(params)).resolves.toMatchObject([{ messageId }]);
      }
      const attempts = abortBeforeDispatch ? 2 : 1;
      expect(sendText).toHaveBeenCalledTimes(attempts);
      expect(reconcileUnknownSend).not.toHaveBeenCalled();
      expect(
        getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
      ).toBe("completed");
      await expect(loadCompletedDeliveryReceipt(deliveryIntentId, tmpDir)).resolves.toEqual({
        platformMessageId: messageId,
      });
      await expect(deliverOutboundPayloads(params)).resolves.toEqual([]);
      expect(sendText).toHaveBeenCalledTimes(attempts);

      const recoveryDeliver = vi.fn<DeliverFn>(async () => []);
      await drainMatrixReconnect({ deliver: recoveryDeliver, stateDir: tmpDir });
      expect(recoveryDeliver).not.toHaveBeenCalled();
      expect(sendText).toHaveBeenCalledTimes(attempts);
    },
  );
});
