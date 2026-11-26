import { describe, expect, it, vi } from "vitest";
import { normalizeSlackMessagingTarget } from "../../../extensions/slack/api.js";
import {
  bindReplyPublication,
  registerReplyPublicationReceiptListener,
  requireReplyPublicationReceipt,
} from "../../auto-reply/reply-publication.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureDeliveryQueueStateContext } from "../delivery-queue-sqlite.js";
import { updateDeliveryQueueEntryInDatabase } from "../delivery-queue-sqlite.kernel.js";
import { executeDeliveryQueueOperation } from "../delivery-queue-worker-store.js";
import { outboundDeliveryQueueName } from "./delivery-queue-namespaces.js";
import { captureDeliveryPublicationEvidence } from "./delivery-queue-publication-evidence.js";
import { recoverPendingDeliveries, type DeliverFn } from "./delivery-queue-recovery.js";
import { enqueueDelivery, loadPendingDelivery } from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";
import { createUnmodifiedPreparedOutboundBatch } from "./prepared-batch.js";

// The native host setup installs a Slack stub without a target normalizer;
// the state worker independently loads the bundled Slack registry.
describe("admission-owned publication route across native worker registries", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  const context = () => captureDeliveryQueueStateContext(tmpDir());
  async function queued() {
    const destination = { channel: "slack", to: "channel:C1", accountId: "source" };
    const payload = { text: "final" };
    bindReplyPublication(
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
    const id = await enqueueDelivery(
      {
        ...destination,
        session: { key: "session", agentId: "main" },
        preparedBatch: { ...createUnmodifiedPreparedOutboundBatch([payload]), runId: "run" },
        queuePolicy: "required",
      },
      tmpDir(),
    );
    const evidence = captureDeliveryPublicationEvidence(
      [{ channel: "slack", messageId: "event" }],
      destination,
    );
    if (!evidence) throw new Error("Native provider evidence required");
    const entry = await loadPendingDelivery(id, tmpDir());
    if (!entry?.publicationOwner) throw new Error("Native admission owner required");
    return { id, entry, evidence };
  }
  const projections = () =>
    executeDeliveryQueueOperation(context(), tmpDir(), {
      type: "deliveryQueue.loadPublications",
      input: {},
    });

  it("ACKs the frozen host route and replays its publication despite a different bundled worker normalizer", async () => {
    const { id, entry, evidence } = await queued();
    expect(evidence.normalizedTarget).toBe("channel:C1");
    expect(normalizeSlackMessagingTarget(entry.to)).toBe("channel:c1");
    expect(entry.publicationOwner?.normalizedTarget).toBe(evidence.normalizedTarget);
    await executeDeliveryQueueOperation(context(), tmpDir(), {
      type: "deliveryQueue.ack",
      input: { id, stateDir: tmpDir(), options: { publicationEvidence: evidence } },
    });
    expect(await loadPendingDelivery(id, tmpDir())).toBeNull();
    expect(await projections()).toHaveLength(1);
    const accepted = vi.fn(async () => {});
    const release = registerReplyPublicationReceiptListener(accepted);
    const deliver = vi.fn(async () => []);
    try {
      await recoverPendingDeliveries({
        cfg: {},
        stateDir: tmpDir(),
        log: createRecoveryLog(),
        deliver,
      });
      expect(accepted).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ runId: "run" }),
        expect.objectContaining({ messageId: "event", conversationId: "C1" }),
      );
      expect(deliver).not.toHaveBeenCalled();
      expect(await projections()).toEqual([]);
    } finally {
      release();
    }
  });

  it("recovers a pending frozen host route through the native owner ACK without worker renormalization", async () => {
    const { id, entry, evidence } = await queued();
    expect(entry.publicationOwner?.normalizedTarget).not.toBe(
      normalizeSlackMessagingTarget(entry.to),
    );
    const accepted = vi.fn(async () => {});
    const release = registerReplyPublicationReceiptListener(accepted);
    const deliver = vi.fn<DeliverFn>(async (params) => {
      const result = { channel: "slack", messageId: "event" };
      await params.onDeliveryResult?.(result);
      if (!params.deliveryQueueOwner) throw new Error("Native recovery owner required");
      await params.deliveryQueueOwner.ack({ publicationEvidence: evidence });
      return [result];
    });
    try {
      await recoverPendingDeliveries({
        cfg: {},
        stateDir: tmpDir(),
        log: createRecoveryLog(),
        deliver,
      });
      expect(deliver).toHaveBeenCalledOnce();
      expect(accepted).toHaveBeenCalledOnce();
      expect(await loadPendingDelivery(id, tmpDir())).toBeNull();
      expect(await projections()).toEqual([]);
    } finally {
      release();
    }
  });

  it.each([
    "missing",
    "normalized-target",
    "raw-route",
    "account",
    "agent",
    "thread",
    "caller-evidence",
  ] as const)(
    "retains %s custody without accepting caller evidence or resending",
    async (fault) => {
      const { id, entry, evidence } = await queued();
      const fact = entry.publicationOwner;
      if (!fact) throw new Error("Admission fact required");
      const forgedEvidence =
        fault === "normalized-target" || fault === "caller-evidence"
          ? { ...evidence, normalizedTarget: "channel:other" }
          : evidence;
      if (fault !== "caller-evidence") {
        const database = openOpenClawStateDatabase({
          env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() },
        });
        updateDeliveryQueueEntryInDatabase(
          database,
          outboundDeliveryQueueName(entry),
          id,
          (current) => ({
            ...current,
            ...(fault === "missing" ? { publicationOwner: undefined } : {}),
            ...(fault === "normalized-target"
              ? { publicationOwner: { ...fact, normalizedTarget: "channel:other" } }
              : {}),
            ...(fault === "raw-route" ? { to: "channel:other" } : {}),
            ...(fault === "account" ? { accountId: "other" } : {}),
            ...(fault === "agent" ? { session: { ...entry.session!, agentId: "other" } } : {}),
            ...(fault === "thread" ? { threadId: "other" } : {}),
          }),
        );
      }
      const before = await loadPendingDelivery(id, tmpDir());
      await expect(
        executeDeliveryQueueOperation(context(), tmpDir(), {
          type: "deliveryQueue.ack",
          input: { id, stateDir: tmpDir(), options: { publicationEvidence: forgedEvidence } },
        }),
      ).rejects.toThrow(/publication/i);
      expect(await loadPendingDelivery(id, tmpDir())).toEqual(before);
      expect(await projections()).toEqual([]);
      // Caller-evidence corruption does not damage the durable owner's ability to
      // recover. The other cases have unproven stored custody and cannot resend.
      if (fault === "caller-evidence") return;
      const deliver = vi.fn(async () => []);
      const accepted = vi.fn(async () => {});
      const release = registerReplyPublicationReceiptListener(accepted);
      try {
        const summary = await recoverPendingDeliveries({
          cfg: {},
          stateDir: tmpDir(),
          log: createRecoveryLog(),
          deliver,
        });
        expect(summary.failed).toBe(1);
        expect(deliver).not.toHaveBeenCalled();
        expect(accepted).not.toHaveBeenCalled();
        expect(await loadPendingDelivery(id, tmpDir())).toEqual(before);
      } finally {
        release();
      }
    },
  );
});
