import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { prepareConversationLifecycleWrite } from "./conversation-lifecycle-persistence.js";
import {
  lifecycleWriteFingerprint,
  readLifecycleRecordReceipt,
} from "./conversation-lifecycle-receipt.js";
import { captureDeliveryQueueStateContext } from "./delivery-queue-state-context.js";
import { executeDeliveryQueueOperation } from "./delivery-queue-worker-store.js";
import type { RetainedWorkerTransactionAdmission } from "./sqlite-worker-operation-settlement.js";

vi.mock("./delivery-queue-worker-store.js", () => ({ executeDeliveryQueueOperation: vi.fn() }));
const result = { rows: [], adopted: true, overtaken: [] };
function prepare(assertCurrent = vi.fn()) {
  return prepareConversationLifecycleWrite({
    context: captureDeliveryQueueStateContext("/synthetic/lifecycle-receipts"),
    stateDir: "/synthetic/lifecycle-receipts",
    command: {
      type: "deliveryQueue.lifecycleRecord",
      input: {
        event: { runId: "run", stream: "lifecycle", seq: 7, ts: 1000, data: { phase: "end" } },
        incomingState: "completed",
        generation: "generation",
        sessionId: "session",
        transportId: "test",
        bindings: [],
        executionOwner: false,
        signals: true,
        cards: false,
        cappedRooms: [],
        interruptedSent: [],
      },
    },
    assertCurrent,
    readReceipt: readLifecycleRecordReceipt,
  });
}
function respond(params: {
  outcome?: RetainedWorkerTransactionAdmission;
  committed?: boolean;
  foreign?: boolean;
}) {
  vi.mocked(executeDeliveryQueueOperation).mockImplementationOnce(
    async (_context, _dir, command, options) => {
      if (!options) throw new Error("expected native admission");
      const owned = options.createAdmission(
        params.outcome ?? { settled: Promise.resolve({ kind: "completed" }) },
      );
      if (params.committed) {
        owned.admission.port.postMessage({
          kind: "native-commit",
          committed: {
            version: 1,
            sequence: 1,
            facts: {
              kind: command.type,
              fingerprint: params.foreign
                ? "other-occurrence"
                : lifecycleWriteFingerprint(command.input),
              result,
            },
          },
          payloadBytes: 0,
        });
        owned.admission.service();
      }
      owned.admission.finish();
      throw new Error("ordinary worker result lost");
    },
  );
}

describe("lifecycle native commit reconciliation", () => {
  beforeEach(() => vi.mocked(executeDeliveryQueueOperation).mockReset());
  it("accepts the exact native commit after ordinary reply loss without replay", async () => {
    respond({ committed: true });
    await expect(prepare()()).resolves.toEqual(result);
    expect(executeDeliveryQueueOperation).toHaveBeenCalledOnce();
  });
  it("refuses a different occurrence's receipt and never retries that unknown custody", async () => {
    respond({ committed: true, foreign: true });
    const persist = prepare();
    await expect(persist()).rejects.toThrow("disagrees");
    await expect(persist()).rejects.toThrow("disagrees");
    expect(executeDeliveryQueueOperation).toHaveBeenCalledOnce();
  });
  it("does not authorize retry without actual native retirement evidence", async () => {
    respond({
      outcome: { settled: Promise.resolve({ kind: "unknown", error: new Error("lost") }) },
    });
    const persist = prepare();
    await expect(persist()).rejects.toThrow("native retirement evidence");
    await expect(persist()).rejects.toThrow("native retirement evidence");
    expect(executeDeliveryQueueOperation).toHaveBeenCalledOnce();
  });
  it("waits for native retirement before an exact input replay", async () => {
    const stopped = createDeferred();
    respond({
      outcome: {
        settled: Promise.resolve({ kind: "unknown", error: new Error("lost") }),
        nativeStopped: stopped.promise,
      },
    });
    const persist = prepare();
    let settled = false;
    const first = persist().catch((error: unknown) => {
      settled = true;
      return error;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    stopped.resolve();
    expect(await first).toBeInstanceOf(Error);
    respond({ committed: true });
    await expect(persist()).resolves.toEqual(result);
    const [firstCall, secondCall] = vi.mocked(executeDeliveryQueueOperation).mock.calls;
    expect(secondCall?.[2]).toEqual(firstCall?.[2]);
  });
});
