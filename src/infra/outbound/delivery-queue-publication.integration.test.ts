import { describe, expect, it, vi } from "vitest";
import {
  bindReplyPublication,
  copyReplyPublication,
  registerReplyPublicationReceiptListener,
  requireReplyPublicationReceipt,
} from "../../auto-reply/reply-publication.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { captureDeliveryQueueStateContext } from "../delivery-queue-sqlite.js";
import { updateDeliveryQueueEntryInDatabase } from "../delivery-queue-sqlite.kernel.js";
import { executeDeliveryQueueOperation } from "../delivery-queue-worker-store.js";
import { ackDeliveryInDatabase } from "./delivery-queue-ack.kernel.js";
import {
  captureDeliveryPublicationEvidence,
  capturePayloadPublicationEvidence,
} from "./delivery-queue-publication-evidence.js";
import {
  DeliveryPublicationPendingError,
  flushDeliveryPublications,
} from "./delivery-queue-publication.js";
import { OUTBOUND_PUBLICATION_QUEUE_NAME } from "./delivery-queue-publication.types.js";
import { recoverPendingDeliveries, type DeliverFn } from "./delivery-queue-recovery.js";
import {
  ackDelivery,
  claimDeliveryPlatformSendAttempt,
  enqueueDelivery,
  loadPendingDelivery,
  markDeliveryPlatformSendAttemptStarted,
} from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";
import { createUnmodifiedPreparedOutboundBatch } from "./prepared-batch.js";

const destination = { channel: "slack", to: "channel:C1", accountId: "source" };
const results = [
  {
    channel: "slack",
    messageId: "first",
    receipt: {
      primaryPlatformMessageId: "first",
      platformMessageIds: ["first", "last"],
      parts: [
        { platformMessageId: "first", kind: "text" as const, index: 0 },
        { platformMessageId: "last", kind: "text" as const, index: 1 },
      ],
      sentAt: 1,
    },
  },
];

describe("canonical ACK publication projection custody", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  const context = () => captureDeliveryQueueStateContext(tmpDir());
  const projections = () =>
    executeDeliveryQueueOperation(context(), tmpDir(), {
      type: "deliveryQueue.loadPublications",
      input: {},
    });
  async function queued() {
    const payload = { text: "final answer" };
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
    const id = await enqueueDelivery(
      {
        ...destination,
        session: { key: "session", agentId: "main" },
        preparedBatch: { ...createUnmodifiedPreparedOutboundBatch([payload]), runId: "run" },
        queuePolicy: "required",
      },
      tmpDir(),
    );
    const evidence = captureDeliveryPublicationEvidence(results, destination)!;
    return {
      id,
      publication,
      options: {
        publicationEvidence: evidence,
        completionReceipt: { platformMessageId: evidence.platformMessageId },
      },
    };
  }

  async function queuedBatch(sharedPublication = false, wrongSuppressedOwner = false) {
    const payloads = [{ text: "first final" }, { text: "second final" }];
    payloads.forEach((payload, index) => {
      if (sharedPublication && index === 1) copyReplyPublication(payloads[0]!, payload);
      else
        bindReplyPublication(
          {},
          {
            payload,
            kind: "final",
            channel: "slack",
            sessionKey: wrongSuppressedOwner && index === 1 ? "unrelated-session" : "session",
            runId: "run",
            context: { accountId: "source" },
          },
        );
      requireReplyPublicationReceipt(payload);
    });
    const batch = createUnmodifiedPreparedOutboundBatch(payloads);
    // Source index zero was policy-suppressed; accepted-array offsets are not identities.
    batch.sourcePayloadCount = 3;
    batch.entries.forEach((part) => {
      part.sourceIndex += 1;
    });
    batch.entries.unshift({
      sourceIndex: 0,
      status: "suppressed",
      reason: "cancelled_by_reply_payload_sending_hook",
    });
    const id = await enqueueDelivery(
      {
        ...destination,
        session: { key: "session", agentId: "main" },
        preparedBatch: { ...batch, runId: "run" },
        queuePolicy: "required",
      },
      tmpDir(),
    );
    const evidence = ["first-event", "second-event"].map((messageId, index) => ({
      sourceIndex: index + 1,
      evidence: captureDeliveryPublicationEvidence([{ channel: "slack", messageId }], destination)!,
    }));
    return { id, evidence };
  }

  it.each([false, true])(
    "commits exact per-payload receipts after batch ACK (shared publication %s)",
    async (shared) => {
      const { id, evidence } = await queuedBatch(shared);
      await executeDeliveryQueueOperation(context(), tmpDir(), {
        type: "deliveryQueue.ack",
        input: { id, stateDir: tmpDir(), options: { publicationEvidenceByPayload: evidence } },
      });
      expect(await loadPendingDelivery(id, tmpDir())).toBeNull();
      const stored = (await projections()).map((entry) => JSON.parse(entry.projectionJson));
      expect(stored).toHaveLength(shared ? 1 : 2);
      expect(stored.map((entry) => entry.receipt.messageId)).toEqual(
        shared ? ["second-event"] : ["first-event", "second-event"],
      );
      if (shared) {
        expect(stored[0].evidence.platformMessageIds).toEqual(["first-event", "second-event"]);
        expect(stored[0].evidence).toMatchObject({
          primaryPlatformMessageId: "second-event",
          resultCount: 2,
        });
      } else {
        expect(stored.map((entry) => entry.evidence.resultCount)).toEqual([1, 1]);
      }
    },
  );

  it("does not manufacture grouped primary/count evidence for a legacy part", async () => {
    const { id, evidence } = await queuedBatch(true);
    const {
      primaryPlatformMessageId: _primary,
      resultCount: _count,
      ...legacyEvidence
    } = evidence[0]!.evidence;
    evidence[0]!.evidence = legacyEvidence;
    await executeDeliveryQueueOperation(context(), tmpDir(), {
      type: "deliveryQueue.ack",
      input: { id, stateDir: tmpDir(), options: { publicationEvidenceByPayload: evidence } },
    });
    const rows = await projections();
    expect(rows).toHaveLength(1);
    const stored = JSON.parse(rows[0]!.projectionJson);
    expect(stored.evidence.platformMessageIds).toEqual(["first-event", "second-event"]);
    expect(stored.evidence.primaryPlatformMessageId).toBeUndefined();
    expect(stored.evidence.resultCount).toBeUndefined();
  });

  it("ACKs a mixed runtime-suppressed suffix without inventing its physical publication", async () => {
    const { id, evidence } = await queuedBatch();
    await executeDeliveryQueueOperation(context(), tmpDir(), {
      type: "deliveryQueue.ack",
      input: {
        id,
        stateDir: tmpDir(),
        options: {
          publicationEvidenceByPayload: [evidence[0]!],
          publicationSuppressionsByPayload: [
            { sourceIndex: 0, reason: "cancelled_by_reply_payload_sending_hook" },
            { sourceIndex: 2, reason: "adapter_returned_no_send" },
          ],
        },
      },
    });
    expect(await loadPendingDelivery(id, tmpDir())).toBeNull();
    const rows = (await projections()).map((row) => JSON.parse(row.projectionJson));
    expect(rows.map((row) => [row.sourceIndex, row.receipt.messageId])).toEqual([
      [1, "first-event"],
    ]);
  });

  it("does not let explicit suppression bypass the prepared publication's session owner", async () => {
    const { id, evidence } = await queuedBatch(false, true);
    await expect(
      executeDeliveryQueueOperation(context(), tmpDir(), {
        type: "deliveryQueue.ack",
        input: {
          id,
          stateDir: tmpDir(),
          options: {
            publicationEvidenceByPayload: [evidence[0]!],
            publicationSuppressionsByPayload: [
              { sourceIndex: 2, reason: "adapter_returned_no_send" },
            ],
          },
        },
      }),
    ).rejects.toThrow("does not match its durable owner");
    expect(await loadPendingDelivery(id, tmpDir())).not.toBeNull();
    expect(await projections()).toEqual([]);
  });

  it.each(["missing", "duplicate", "foreign", "conflict", "unknown", "prepared-mismatch"] as const)(
    "does not ACK %s source suppression custody",
    async (kind) => {
      const { id, evidence } = await queuedBatch();
      const valid = { sourceIndex: 2, reason: "adapter_returned_no_send" as const };
      const suppressions =
        kind === "missing"
          ? []
          : kind === "duplicate"
            ? [valid, valid]
            : kind === "foreign"
              ? [{ ...valid, sourceIndex: 9 }]
              : kind === "conflict"
                ? [valid, { ...valid, sourceIndex: 1 }]
                : kind === "unknown"
                  ? [{ ...valid, reason: "adapter_returned_no_identity" as never }]
                  : [valid, { sourceIndex: 0, reason: "adapter_returned_no_send" as const }];
      await expect(
        executeDeliveryQueueOperation(context(), tmpDir(), {
          type: "deliveryQueue.ack",
          input: {
            id,
            stateDir: tmpDir(),
            options: {
              publicationEvidenceByPayload: [evidence[0]!],
              publicationSuppressionsByPayload: suppressions,
            },
          },
        }),
      ).rejects.toThrow(/publication/);
      expect(await loadPendingDelivery(id, tmpDir())).not.toBeNull();
      expect(await projections()).toEqual([]);
    },
  );

  it("replays a batch in source order and retains its suffix after an earlier projection fails", async () => {
    const { id, evidence } = await queuedBatch();
    await executeDeliveryQueueOperation(context(), tmpDir(), {
      type: "deliveryQueue.ack",
      input: { id, stateDir: tmpDir(), options: { publicationEvidenceByPayload: evidence } },
    });
    // Force native timestamp ordering opposite to source ordering; no UUID luck.
    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() },
    });
    const entries = await projections();
    runOpenClawStateWriteTransaction(
      (db) => {
        for (const entry of entries) {
          updateDeliveryQueueEntryInDatabase(
            db,
            OUTBOUND_PUBLICATION_QUEUE_NAME,
            entry.id,
            (current) => {
              current.enqueuedAt = 100 - entry.sourceIndex;
              return current;
            },
          );
        }
      },
      { database },
      { operationLabel: "reverse projection timestamp fixture" },
    );
    const attempted: string[] = [];
    let failFirst = true;
    const sibling = await queued();
    await executeDeliveryQueueOperation(context(), tmpDir(), {
      type: "deliveryQueue.ack",
      input: { id: sibling.id, stateDir: tmpDir(), options: sibling.options },
    });
    const release = registerReplyPublicationReceiptListener(async (_publication, receipt) => {
      attempted.push(receipt.messageId);
      if (failFirst && receipt.messageId === "first-event")
        throw new Error("first projection unavailable");
    });
    try {
      await expect(flushDeliveryPublications({ stateDir: tmpDir() })).rejects.toBeInstanceOf(
        DeliveryPublicationPendingError,
      );
      expect(attempted).toEqual(["first-event", "last"]);
      expect(await projections()).toHaveLength(2);
      failFirst = false;
      await flushDeliveryPublications({ stateDir: tmpDir(), deliveryId: id });
      expect(attempted).toEqual(["first-event", "last", "first-event", "second-event"]);
      expect(await projections()).toEqual([]);
    } finally {
      release();
    }
  });

  it.each(["mismatch", "duplicate", "missing", "negative"] as const)(
    "retains the entire delivery before projection when source ordering is %s",
    async (fault) => {
      const { id, evidence } = await queuedBatch();
      await executeDeliveryQueueOperation(context(), tmpDir(), {
        type: "deliveryQueue.ack",
        input: { id, stateDir: tmpDir(), options: { publicationEvidenceByPayload: evidence } },
      });
      const [first] = await projections();
      const database = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() },
      });
      updateDeliveryQueueEntryInDatabase(
        database,
        OUTBOUND_PUBLICATION_QUEUE_NAME,
        first!.id,
        (current) => {
          const projection = JSON.parse(first!.projectionJson);
          const sourceIndex =
            fault === "duplicate"
              ? 2
              : fault === "negative"
                ? -1
                : fault === "missing"
                  ? undefined
                  : 100;
          if (fault !== "mismatch") projection.sourceIndex = sourceIndex;
          return { ...current, sourceIndex, projectionJson: JSON.stringify(projection) };
        },
      );
      const before = await projections();
      const accepted = vi.fn(async () => {});
      const release = registerReplyPublicationReceiptListener(accepted);
      try {
        await expect(flushDeliveryPublications({ stateDir: tmpDir() })).rejects.toBeInstanceOf(
          DeliveryPublicationPendingError,
        );
        expect(accepted).not.toHaveBeenCalled();
        expect(await projections()).toEqual(before);
      } finally {
        release();
      }
    },
  );

  it.each([
    "aggregate-only",
    "missing",
    "duplicate",
    "suppressed-index",
    "wrong-destination",
  ] as const)("retains the entire batch without publishing when evidence is %s", async (fault) => {
    const { id, evidence } = await queuedBatch();
    if (fault === "missing") evidence.pop();
    if (fault === "duplicate") evidence.push(evidence[0]!);
    if (fault === "suppressed-index") evidence[0]!.sourceIndex = 0;
    if (fault === "wrong-destination")
      evidence[1]!.evidence = {
        ...evidence[1]!.evidence,
        destination: { ...destination, to: "channel:OTHER" },
      };
    await expect(
      executeDeliveryQueueOperation(context(), tmpDir(), {
        type: "deliveryQueue.ack",
        input: {
          id,
          stateDir: tmpDir(),
          options:
            fault === "aggregate-only"
              ? { publicationEvidence: evidence[0]!.evidence }
              : { publicationEvidenceByPayload: evidence },
        },
      }),
    ).rejects.toThrow(/publication/i);
    expect(await loadPendingDelivery(id, tmpDir())).not.toBeNull();
    expect(await projections()).toEqual([]);
  });

  it("retains captured physical evidence when observer hooks mutate their result", () => {
    const result = { channel: "slack" as const, messageId: "provider-event" };
    const captured = new WeakMap([
      [result, captureDeliveryPublicationEvidence([result], destination)!],
    ]);
    result.messageId = "observer-replacement";
    expect(
      capturePayloadPublicationEvidence(
        { index: 3, status: "sent", results: [result] },
        destination,
        captured,
      ),
    ).toMatchObject({ sourceIndex: 3, evidence: { platformMessageId: "provider-event" } });
    expect(
      capturePayloadPublicationEvidence(
        { index: 3, status: "sent", results: [{ ...result }] },
        destination,
        captured,
      ),
    ).toBeUndefined();
  });

  it("rolls publication custody back with a failed canonical ACK transaction", async () => {
    const { id, options } = await queued();
    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() },
    });
    expect(() =>
      runOpenClawStateWriteTransaction(
        (db) => {
          ackDeliveryInDatabase(db, id, tmpDir(), options);
          throw new Error("injected rollback after ACK mutation");
        },
        { database },
        { operationLabel: "publication rollback fixture" },
      ),
    ).toThrow("injected rollback");
    expect(await loadPendingDelivery(id, tmpDir())).not.toBeNull();
    expect(await projections()).toEqual([]);
  });

  it("recovers a crash after ACK using the last physical receipt without a provider resend", async () => {
    const { id, publication, options } = await queued();
    await executeDeliveryQueueOperation(context(), tmpDir(), {
      type: "deliveryQueue.ack",
      input: { id, stateDir: tmpDir(), options },
    });
    expect(await loadPendingDelivery(id, tmpDir())).toBeNull();
    expect(await projections()).toHaveLength(1);
    const accepted = vi.fn(async () => {
      expect(await loadPendingDelivery(id, tmpDir())).toBeNull();
    });
    const release = registerReplyPublicationReceiptListener(accepted);
    const deliver = vi.fn(async () => []);
    try {
      await recoverPendingDeliveries({
        cfg: {},
        stateDir: tmpDir(),
        log: createRecoveryLog(),
        deliver,
      });
      expect(accepted).toHaveBeenCalledWith(
        { ...publication, receiptRequired: true },
        {
          channel: "slack",
          accountId: "source",
          conversationId: "C1",
          messageId: "last",
        },
      );
      expect(deliver).not.toHaveBeenCalled();
      expect(await projections()).toEqual([]);
    } finally {
      release();
    }
  });

  it("retains failed required listener work after ACK and retries only that projection", async () => {
    const { id, options } = await queued();
    const listener = vi.fn(async () => {
      throw new Error("journal unavailable");
    });
    const release = registerReplyPublicationReceiptListener(listener);
    try {
      await expect(ackDelivery(id, tmpDir(), options)).rejects.toBeInstanceOf(
        DeliveryPublicationPendingError,
      );
    } finally {
      release();
    }
    expect(await loadPendingDelivery(id, tmpDir())).toBeNull();
    expect(await projections()).toHaveLength(1);
    const accepted = vi.fn(async () => {});
    const releaseSuccess = registerReplyPublicationReceiptListener(accepted);
    try {
      await flushDeliveryPublications({ stateDir: tmpDir() });
      await flushDeliveryPublications({ stateDir: tmpDir() });
      expect(accepted).toHaveBeenCalledOnce();
      expect(await projections()).toEqual([]);
    } finally {
      releaseSuccess();
    }
  });

  it("propagates publication debt through the native delivery wrapper without reporting a send failure", async () => {
    const { id, options } = await queued();
    const log = createRecoveryLog();
    const deliver = vi.fn<DeliverFn>(async (params) => {
      await params.onDeliveryResult?.(results[0]!);
      const owner = params.deliveryQueueOwner;
      if (!owner) throw new Error("Native recovery owner is required");
      try {
        await owner.ack(options);
      } catch (error) {
        throw owner.project(error, { results, stage: "queue" });
      }
      return results;
    });
    await expect(
      recoverPendingDeliveries({ cfg: {}, stateDir: tmpDir(), log, deliver }),
    ).rejects.toBeInstanceOf(DeliveryPublicationPendingError);
    expect(deliver).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
    expect(await loadPendingDelivery(id, tmpDir())).toBeNull();
    expect(await projections()).toHaveLength(1);
  });

  it("keeps required publication custody when its lifecycle listener is not ready", async () => {
    const { id, options } = await queued();
    await expect(ackDelivery(id, tmpDir(), options)).rejects.toBeInstanceOf(
      DeliveryPublicationPendingError,
    );
    expect(await loadPendingDelivery(id, tmpDir())).toBeNull();
    expect(await projections()).toHaveLength(1);
    const accepted = vi.fn(async () => {});
    const release = registerReplyPublicationReceiptListener(accepted);
    try {
      await flushDeliveryPublications({ stateDir: tmpDir() });
      expect(accepted).toHaveBeenCalledOnce();
      expect(await projections()).toEqual([]);
    } finally {
      release();
    }
  });

  it("cannot settle a replacement provider attempt or publish its predecessor receipt", async () => {
    const { id, options } = await queued();
    const first = await claimDeliveryPlatformSendAttempt(id, tmpDir());
    await markDeliveryPlatformSendAttemptStarted(id, tmpDir(), undefined, first!);
    const started = (await loadPendingDelivery(id, tmpDir()))!.platformSendStartedAt;
    const replacement = await claimDeliveryPlatformSendAttempt(id, tmpDir(), started, first!);
    expect(replacement).toBeTruthy();
    await expect(
      ackDelivery(id, tmpDir(), { ...options, expectedPlatformSendAttemptId: first }),
    ).rejects.toThrow("claim was lost");
    expect(await projections()).toEqual([]);
    expect(await loadPendingDelivery(id, tmpDir())).not.toBeNull();
  });

  it.each(["to", "channel", "accountId"] as const)(
    "rejects evidence from another %s before canonical ACK",
    async (field) => {
      const { id, options } = await queued();
      options.publicationEvidence = {
        ...options.publicationEvidence,
        destination: { ...options.publicationEvidence.destination, [field]: "other" },
      };
      await expect(ackDelivery(id, tmpDir(), options)).rejects.toThrow("durable owner");
      expect(await loadPendingDelivery(id, tmpDir())).not.toBeNull();
      expect(await projections()).toEqual([]);
    },
  );

  it("rejects mixed physical recipient evidence even when the requested route matches", () => {
    expect(() =>
      captureDeliveryPublicationEvidence(
        [
          ...results,
          {
            channel: "slack",
            messageId: "elsewhere",
            target: { kind: "channel", id: "channel:C2" },
          },
        ],
        destination,
      ),
    ).toThrow("contradictory destination");
  });

  it("retains malformed durable publication evidence instead of accepting the listener's no-op", async () => {
    const { id, options } = await queued();
    await executeDeliveryQueueOperation(context(), tmpDir(), {
      type: "deliveryQueue.ack",
      input: { id, stateDir: tmpDir(), options },
    });
    const [entry] = await projections();
    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() },
    });
    updateDeliveryQueueEntryInDatabase(
      database,
      OUTBOUND_PUBLICATION_QUEUE_NAME,
      entry!.id,
      (current) => {
        const projection = JSON.parse(entry!.projectionJson);
        projection.publication.kind = "block";
        return { ...current, projectionJson: JSON.stringify(projection) };
      },
    );
    const accepted = vi.fn(async () => {});
    const release = registerReplyPublicationReceiptListener(accepted);
    try {
      await expect(flushDeliveryPublications({ stateDir: tmpDir() })).rejects.toBeInstanceOf(
        DeliveryPublicationPendingError,
      );
      expect(accepted).not.toHaveBeenCalled();
      expect(await projections()).toHaveLength(1);
    } finally {
      release();
    }
  });

  it("does not finish projection custody for another frozen receipt", async () => {
    const { id, options } = await queued();
    await executeDeliveryQueueOperation(context(), tmpDir(), {
      type: "deliveryQueue.ack",
      input: { id, stateDir: tmpDir(), options },
    });
    const [entry] = await projections();
    expect(
      await executeDeliveryQueueOperation(context(), tmpDir(), {
        type: "deliveryQueue.finishPublication",
        input: { id: entry!.id, projectionJson: entry!.projectionJson + " " },
      }),
    ).toBe(false);
    expect(await projections()).toHaveLength(1);
  });
});
