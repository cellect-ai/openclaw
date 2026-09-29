import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindReplyPublication,
  registerReplyPublicationReceiptListener,
  requireReplyPublicationReceipt,
} from "../../auto-reply/reply-publication.js";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import { enqueueDelivery } from "./delivery-queue-storage.js";
import {
  installDeliveryQueueTmpDirHooks,
  setQueuedEntryState,
  loadPendingDeliveries,
  createRecoveryLog,
  asDeliverFn,
} from "./delivery-queue.test-helpers.js";
import { createUnmodifiedPreparedOutboundBatch } from "./prepared-batch.js";
const m = vi.hoisted(() => ({ adapter: vi.fn(), sleep: vi.fn(async () => {}) }));
vi.mock("./channel-resolution.js", () => ({ resolveOutboundChannelMessageAdapter: m.adapter }));
vi.mock("../../utils/sleep.js", () => ({ sleep: m.sleep }));
describe("source final publication unknown-send recovery", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  beforeEach(() => {
    m.adapter.mockReset();
    m.sleep.mockClear();
  });
  async function queued() {
    const payload = { text: "actual final" };
    const publication = bindReplyPublication(
      {},
      {
        payload,
        kind: "final",
        channel: "slack",
        sessionKey: "session",
        runId: "run",
        context: { accountId: "source" },
      },
    );
    requireReplyPublicationReceipt(payload);
    const preparedBatch = { ...createUnmodifiedPreparedOutboundBatch([payload]), runId: "run" };
    const id = await enqueueDelivery(
      {
        channel: "slack",
        to: "channel:C1",
        accountId: "source",
        session: { key: "session", agentId: "agent" },
        preparedBatch,
        queuePolicy: "required",
        requireUnknownSendReconciliation: true,
      },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, {
      retryCount: 0,
      platformSendStartedAt: Date.now(),
      recoveryState: "unknown_after_send",
    });
    return { id, publication };
  }
  function reconciled() {
    m.adapter.mockReturnValue({
      durableFinal: {
        capabilities: { reconcileUnknownSend: true },
        reconcileUnknownSend: vi.fn(async () => ({
          status: "sent",
          messageId: "1.000001",
          receipt: {
            primaryPlatformMessageId: "1.000001",
            platformMessageIds: ["1.000001", "1.000002"],
            parts: [
              { platformMessageId: "1.000001", kind: "text", index: 0 },
              { platformMessageId: "1.000002", kind: "text", index: 1 },
            ],
            sentAt: Date.now(),
          },
        })),
      },
    });
  }
  it("persists exact frozen owner receipt before ACK and selects actual final provider part", async () => {
    const { publication } = await queued();
    reconciled();
    const receipt = vi.fn(async () => {
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(1);
    });
    const stop = registerReplyPublicationReceiptListener(receipt);
    try {
      const deliver = vi.fn(async () => []);
      const result = await recoverPendingDeliveries({
        cfg: {},
        stateDir: tmpDir(),
        log: createRecoveryLog(),
        deliver: asDeliverFn(deliver),
      });
      expect(result.recovered).toBe(1);
      expect(deliver).not.toHaveBeenCalled();
      expect(receipt).toHaveBeenCalledWith(
        { ...publication, receiptRequired: true },
        { channel: "slack", accountId: "source", conversationId: "C1", messageId: "1.000002" },
      );
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    } finally {
      stop();
    }
  });
  it("retains ambiguous custody if durable owner receipt storage fails, without blind resend", async () => {
    await queued();
    reconciled();
    const receipt = vi.fn(async () => {
      throw new Error("private journal unavailable");
    });
    const stop = registerReplyPublicationReceiptListener(receipt);
    try {
      const deliver = vi.fn(async () => []);
      await recoverPendingDeliveries({
        cfg: {},
        stateDir: tmpDir(),
        log: createRecoveryLog(),
        deliver: asDeliverFn(deliver),
      });
      expect(deliver).not.toHaveBeenCalled();
      expect(receipt).toHaveBeenCalledTimes(1);
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(1);
    } finally {
      stop();
    }
  });
  it("retains unsupported source final custody as explicit needs_review, without ACK or blind resend", async () => {
    await queued();
    m.adapter.mockReturnValue({ durableFinal: { capabilities: { reconcileUnknownSend: false } } });
    const deliver = vi.fn(async () => []);
    await recoverPendingDeliveries({
      cfg: {},
      stateDir: tmpDir(),
      log: createRecoveryLog(),
      deliver: asDeliverFn(deliver),
    });
    expect(deliver).not.toHaveBeenCalled();
    const retained = await loadPendingDeliveries(tmpDir());
    expect(retained).toHaveLength(1);
    expect(expectDefined(retained[0], "retained delivery").lastError).toContain("needs_review");
  });
});
