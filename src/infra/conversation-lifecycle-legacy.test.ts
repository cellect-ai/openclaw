import { expect, it } from "vitest";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { isLegacySettledLifecycleObligation } from "./conversation-lifecycle-legacy.worker.js";
import { prepareConversationLifecycleWrite } from "./conversation-lifecycle-persistence.js";
import { readLifecycleResultReceipt } from "./conversation-lifecycle-receipt.js";
import { identity, QUEUE } from "./conversation-lifecycle.reducer.js";
import { upsertDeliveryQueueEntryInDatabase } from "./delivery-queue-sqlite.kernel.js";
import { captureDeliveryQueueStateContext } from "./delivery-queue-state-context.js";
import { executeDeliveryQueueOperation } from "./delivery-queue-worker-store.js";

it.each([
  "legacy",
  "current receipt",
  "pending",
  "corrupt JSON",
  "payload ID mismatch",
  "ack mismatch",
  "retention mismatch",
  "receipt mismatch",
  "SQL metadata mismatch",
  "unexpected payload field",
  "generation mismatch",
  "binding mismatch",
] as const)("recognizes only the exact settled legacy lifecycle obligation: %s", async (mode) =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir, env }) => {
    const generation = "stored-older-generation";
    const bindingId = "stored-binding";
    const runId = "stored-run";
    const id = identity(bindingId, runId, generation);
    const now = Date.now();
    // Exact 97613fc writer output, not a current lifecycle producer fixture.
    const tombstone = {
      id,
      enqueuedAt: now,
      retryCount: 0,
      acknowledgedAt: now,
      completionRetention: { idPrefix: "lifecycle:", maxAgeMs: 2592000000, maxEntries: 100000 },
      recoveryState: "completed_bounded",
    };
    const payload = {
      ...tombstone,
      ...(mode === "payload ID mismatch" ? { id: "lifecycle:foreign" } : {}),
      ...(mode === "ack mismatch" ? { acknowledgedAt: now - 1 } : {}),
      ...(mode === "retention mismatch"
        ? { completionRetention: { ...tombstone.completionRetention, maxEntries: 1 } }
        : {}),
      ...(mode === "unexpected payload field" ? { resultEventId: "$unproven" } : {}),
      ...(mode === "current receipt" || mode === "receipt mismatch"
        ? {
            completionReceipt: {
              platformMessageId: mode === "current receipt" ? "$final" : "$other",
            },
          }
        : {}),
    };
    const raw = mode === "corrupt JSON" ? "{" : JSON.stringify(payload);
    const database = openOpenClawStateDatabase({ env });
    const sqlite = requireNativeSqliteDatabase(database.db);
    runOpenClawStateWriteTransaction(
      (owned) => {
        upsertDeliveryQueueEntryInDatabase(
          {
            queueName: QUEUE,
            entry: tombstone,
            status: mode === "pending" ? "pending" : "completed",
          },
          owned,
        );
        sqlite
          .prepare(
            "UPDATE delivery_queue_entries SET entry_json = ? WHERE queue_name = ? AND id = ?",
          )
          .run(raw, QUEUE, id);
        if (mode === "SQL metadata mismatch") {
          sqlite
            .prepare(
              "UPDATE delivery_queue_entries SET last_error = ? WHERE queue_name = ? AND id = ?",
            )
            .run("not the shipped completed state", QUEUE, id);
        }
      },
      { database, env },
    );
    const context = captureDeliveryQueueStateContext(stateDir);
    const write = () =>
      prepareConversationLifecycleWrite({
        context,
        stateDir,
        command: {
          type: "deliveryQueue.lifecycleNoteResult",
          input: {
            transportId: "new-transport",
            runId,
            generation: mode === "generation mismatch" ? "successor-generation" : generation,
            bindingId: mode === "binding mismatch" ? "successor-binding" : bindingId,
            resultEventId: "$final",
            signals: true,
            now,
          },
        },
        assertCurrent: () => {},
        readReceipt: readLifecycleResultReceipt,
      })();
    if (mode === "legacy" || mode === "current receipt") {
      await expect(write()).resolves.toEqual(mode === "legacy" ? { legacySettled: true } : {});
      await expect(write()).resolves.toEqual(mode === "legacy" ? { legacySettled: true } : {});
      await expect(
        executeDeliveryQueueOperation(context, stateDir, {
          type: "deliveryQueue.lifecycleRead",
          input: {},
        }),
      ).resolves.toEqual([]);
    } else {
      await expect(write()).rejects.toThrow(
        /receipt is missing or disagrees|no durable lifecycle owner/,
      );
    }
    const after = sqlite
      .prepare(
        "SELECT entry_json, status FROM delivery_queue_entries WHERE queue_name = ? AND id = ?",
      )
      .get(QUEUE, id);
    expect(after).toMatchObject({
      entry_json: raw,
      status: mode === "pending" ? "pending" : "completed",
    });
  }),
);

it("does not treat missing legacy receipt as a physical result or accept a missing acknowledgement", () => {
  const id = identity("binding", "run", "generation");
  const value = {
    id,
    enqueuedAt: 42,
    retryCount: 0,
    completionRetention: { idPrefix: "lifecycle:", maxAgeMs: 2592000000, maxEntries: 100000 },
    recoveryState: "completed_bounded",
  };
  expect(isLegacySettledLifecycleObligation(value, id)).toBe(false);
  expect(isLegacySettledLifecycleObligation({ ...value, acknowledgedAt: 42 }, id)).toBe(true);
  expect(readLifecycleResultReceipt({ legacySettled: true })).toEqual({ legacySettled: true });
  expect(() =>
    readLifecycleResultReceipt({ legacySettled: true, roomId: "!wrong:synthetic" }),
  ).toThrow("Invalid lifecycle result commit receipt");
});
