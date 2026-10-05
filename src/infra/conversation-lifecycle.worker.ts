import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { LifecycleObligation } from "./conversation-lifecycle.js";
import { loadDeliveryQueueEntryInDatabase } from "./delivery-queue-sqlite-bound.js";
import {
  completeDeliveryQueueEntryInDatabase,
  loadDeliveryQueueEntriesInDatabase,
  upsertDeliveryQueueEntryInDatabase,
} from "./delivery-queue-sqlite.kernel.js";
import type { DeliveryQueueWorkerOperations } from "./delivery-queue.worker-contract.js";
import type { SqliteWorkerCommand } from "./sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";

const QUEUE = "conversation-lifecycle-v2";
type Commands = Pick<
  DeliveryQueueWorkerOperations,
  "deliveryQueue.lifecycleRead" | "deliveryQueue.lifecycleAck" | "deliveryQueue.lifecycleRecover"
>;

export function executeConversationLifecycleCommand(
  command: SqliteWorkerCommand<Commands>,
  options: { database: OpenClawStateDatabase; env: NodeJS.ProcessEnv },
): Commands[keyof Commands]["output"] {
  const read = (database: OpenClawStateDatabase, id: string) =>
    loadDeliveryQueueEntryInDatabase(database, QUEUE, id, "pending") as LifecycleObligation | null;
  if (command.type === "deliveryQueue.lifecycleRead") {
    return command.input.id
      ? [read(options.database, command.input.id)].filter(
          (row): row is LifecycleObligation => !!row,
        )
      : (loadDeliveryQueueEntriesInDatabase(
          options.database,
          QUEUE,
          "pending",
        ) as LifecycleObligation[]);
  }
  return runOpenClawStateWriteTransaction(
    (database) => {
      const row = read(database, command.input.id);
      if (!row) return;
      if (command.type === "deliveryQueue.lifecycleRecover") {
        if (JSON.stringify(row) !== command.input.expected) return;
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        upsertDeliveryQueueEntryInDatabase(
          { queueName: QUEUE, entry: command.input.replacement },
          database,
        );
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        return;
      }
      // Re-read under the same write transaction: a terminal transition appended
      // during transport I/O must survive acknowledgement of its predecessor.
      row.pending = row.pending.filter((event) => event.revision > command.input.revision);
      if (
        row.pending.length === 0 &&
        row.resultEventId &&
        ["completed", "failed", "cancelled", "interrupted", "unknown"].includes(row.state)
      ) {
        completeDeliveryQueueEntryInDatabase(database, QUEUE, row.id);
        return;
      }
      upsertDeliveryQueueEntryInDatabase({ queueName: QUEUE, entry: row }, database);
      return row;
    },
    options,
    { operationLabel: "settle conversation lifecycle publication" },
  );
}
