import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { lifecycleWriteFingerprint } from "./conversation-lifecycle-receipt.js";
import type { DeliveryQueueStateContext } from "./delivery-queue-state-context.js";
import { executeDeliveryQueueOperation } from "./delivery-queue-worker-store.js";
import type { DeliveryQueueWorkerOperations } from "./delivery-queue.worker-contract.js";
import type { SqliteWorkerCommand } from "./sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "./sqlite-worker-operation-settlement.js";

type LifecycleWrite = "deliveryQueue.lifecycleRecord" | "deliveryQueue.lifecycleNoteResult";

/** Native result loss is reconciled through the writer's private commit/settlement port. */
export function prepareConversationLifecycleWrite<Key extends LifecycleWrite, Output>(params: {
  context: DeliveryQueueStateContext;
  stateDir?: string;
  command: SqliteWorkerCommand<DeliveryQueueWorkerOperations> & {
    type: Key;
    input: DeliveryQueueWorkerOperations[Key]["input"];
  };
  assertCurrent: () => void;
  readReceipt: (value: unknown) => Output;
}): () => Promise<Output> {
  const command = structuredClone(params.command);
  const fingerprint = lifecycleWriteFingerprint(command.input);
  let unreconciled: Error | undefined;
  let completed: { value: Output } | undefined;
  return async () => {
    if (unreconciled) throw unreconciled;
    params.assertCurrent();
    if (completed) return completed.value;
    let retained:
      | { operation: RetainedWorkerTransactionAdmission; admission: SqliteWorkerOperationAdmission }
      | undefined;
    const result = await executeDeliveryQueueOperation(params.context, params.stateDir, command, {
      createAdmission: (operation) => {
        const admission = createSqliteWorkerOperationAdmission((_, grant) => {
          params.assertCurrent();
          grant();
        });
        retained = { operation, admission };
        return { admission, nativeLocations: [] };
      },
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (!retained) {
      if (!result.ok) throw result.error;
      throw new Error("Lifecycle write has no native settlement owner");
    }
    const outcome = await retained.operation.settled;
    const committed = retained.admission.committed;
    if (committed) {
      const facts = committed.facts;
      if (!isRecord(facts) || facts.kind !== command.type || facts.fingerprint !== fingerprint) {
        unreconciled = new Error("Lifecycle commit receipt disagrees with its captured occurrence");
        throw unreconciled;
      }
      try {
        completed = { value: params.readReceipt(facts.result) };
        return completed.value;
      } catch (cause) {
        unreconciled = new Error("Lifecycle committed receipt could not be installed", { cause });
        throw unreconciled;
      }
    }
    if (outcome.kind === "unknown") {
      if (!retained.operation.nativeStopped) {
        unreconciled = new Error(
          "Lifecycle native outcome is unknown; retry requires native retirement evidence",
        );
        throw unreconciled;
      }
      // The canonical owner, not a timer or host assumption, proves that the
      // prior transaction can no longer commit before an exact replay begins.
      try {
        await retained.operation.nativeStopped;
      } catch (cause) {
        unreconciled = new Error("Lifecycle native retirement could not be proven", { cause });
        throw unreconciled;
      }
    }
    if (!result.ok) throw result.error;
    throw new Error("Lifecycle write finished without a matching committed receipt");
  };
}
