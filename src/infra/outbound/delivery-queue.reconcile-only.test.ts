import { beforeEach, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.js";
import { updateDeliveryQueueEntryInDatabase } from "../delivery-queue-sqlite.kernel.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import {
  decodeOutboundDeliverySnapshot,
  encodeOutboundDeliverySnapshot,
} from "./delivery-queue-projection.js";
import { recoverPendingDeliveries, type DeliverFn } from "./delivery-queue-recovery.js";
import {
  enqueueDeliveryOnce,
  loadPendingDelivery,
  markDeliveryPlatformSendAttemptStarted,
} from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";

const { adapter, reconcile } = vi.hoisted(() => ({ adapter: vi.fn(), reconcile: vi.fn() }));
vi.mock("./channel-resolution.js", () => ({ resolveOutboundChannelMessageAdapter: adapter }));
const { tmpDir } = installDeliveryQueueTmpDirHooks();
beforeEach(() => {
  vi.clearAllMocks();
  adapter.mockResolvedValue({
    durableFinal: { capabilities: { reconcileUnknownSend: true }, reconcileUnknownSend: reconcile },
  });
});
async function enqueue(id: string, policy?: "reconcile_only", parts = 1) {
  await enqueueDeliveryOnce(
    {
      channel: "directchat",
      to: "recipient",
      payloads: Array.from({ length: parts }, (_, index) => ({ text: `frozen report ${index}` })),
      recoveryPolicy: policy,
      completionRetention: { idPrefix: "review:", maxAgeMs: 86_400_000, maxEntries: 100 },
    },
    id,
    tmpDir(),
  );
}
it("round trips an explicit policy and leaves legacy producers unspecified", async () => {
  for (const policy of [undefined, "reconcile_only"] as const) {
    const id = `review:serialization-${policy ?? "legacy"}`;
    await enqueue(id, policy);
    const row = await loadPendingDelivery(id, tmpDir());
    expect(row).toBeDefined();
    expect(
      decodeOutboundDeliverySnapshot(encodeOutboundDeliverySnapshot(row!)).recoveryPolicy,
    ).toBe(policy);
  }
});
it.each(["pending", "send_attempt_started", "unknown_after_send", "partial_unknown"])(
  "does not invoke a provider or its replaying reconciler after restart: %s",
  async (state) => {
    const id = `review:${state}`;
    await enqueue(id, "reconcile_only", state === "partial_unknown" ? 2 : 1);
    if (state !== "pending") {
      updateDeliveryQueueEntryInDatabase(
        openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() } }),
        OUTBOUND_DELIVERY_QUEUE_NAME,
        id,
        (entry) => ({
          ...entry,
          recoveryState: state === "partial_unknown" ? "unknown_after_send" : state,
          platformSendStartedAt: Date.now() - 1000,
        }),
      );
    }
    closeOpenClawStateDatabaseForTest();
    const deliver = vi.fn();
    await recoverPendingDeliveries({
      cfg: {},
      log: createRecoveryLog(),
      deliver,
      stateDir: tmpDir(),
    });
    expect(deliver).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir())).toBe("failed");
  },
);
it("keeps the normal default recovery behavior for other producers", async () => {
  await enqueue("review:legacy-default");
  const deliver = vi.fn<DeliverFn>(async (params) => {
    await params.onPlatformSendDispatch?.();
    await markDeliveryPlatformSendAttemptStarted(
      params.deliveryQueueId!,
      tmpDir(),
      undefined,
      params.deliveryProducerClaimId,
    );
    await params.onPlatformSendStart?.({});
    const result = { channel: "directchat", messageId: "existing-default-behavior" };
    await params.onDeliveryResult?.(result);
    return [result];
  });
  const result = await recoverPendingDeliveries({
    cfg: {},
    log: createRecoveryLog(),
    deliver,
    stateDir: tmpDir(),
  });
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(result.recovered).toBe(1);
});
