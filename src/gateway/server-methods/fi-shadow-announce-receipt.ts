import { createHash, randomUUID } from "node:crypto";
import type { FiShadowAnnounceResult } from "../../../packages/gateway-protocol/src/index.js";
import { createCorePluginStateKeyedStore } from "../../plugin-state/plugin-state-store.js";

// Native state-directory ownership scopes this namespace to the gateway/tenant.
// V1 stores only payload hashes and bounded descriptive results, never child data.
// Unknown intent survives restart and is never TTL/capacity evicted into retry permission.
type Receipt = {
  version: 1;
  fingerprint: string;
  attempt: string;
  state: "unknown" | "completed";
  result?: FiShadowAnnounceResult;
};
const receipts = () =>
  createCorePluginStateKeyedStore<Receipt>({
    ownerId: "core:fi-shadow-announce",
    namespace: "receipts-v1",
    retention: "retained",
  });
const receiptKey = (key: string) => createHash("sha256").update(key).digest("hex");

export async function readFiShadowAnnounceReceipt(key: string, fingerprint: string) {
  const receipt = await receipts().lookup(receiptKey(key));
  if (!receipt) {
    return undefined;
  }
  if (receipt.version !== 1 || receipt.fingerprint !== fingerprint) {
    return { state: "mismatch" as const };
  }
  if (
    receipt.state === "completed" &&
    typeof receipt.attempt === "string" &&
    receipt.attempt.length > 0 &&
    receipt.result &&
    ["steered", "direct", "none"].includes(receipt.result.path) &&
    (receipt.result.deliveredAt === undefined ||
      (Number.isFinite(receipt.result.deliveredAt) && receipt.result.deliveredAt >= 0))
  ) {
    return { state: "completed" as const, result: receipt.result };
  }
  return { state: "unknown" as const };
}

/** Atomic intent admission precedes native execution; a crash never grants a new attempt. */
export async function claimFiShadowAnnounceReceipt(key: string, fingerprint: string) {
  const store = receipts();
  const hashedKey = receiptKey(key);
  const attempt = randomUUID();
  if (
    !(await store.registerIfAbsent(hashedKey, {
      version: 1,
      fingerprint,
      attempt,
      state: "unknown",
    }))
  ) {
    return undefined;
  }
  const observed = await store.observe(hashedKey);
  if (observed.value?.attempt !== attempt || observed.value.fingerprint !== fingerprint) {
    throw new Error("Shadow announcement receipt ownership changed");
  }
  const finish = async (result: FiShadowAnnounceResult | undefined) => {
    const changed = await store.compareAndApply(
      hashedKey,
      observed.comparison,
      result
        ? {
            operation: "update",
            action: "set",
            value: { version: 1, fingerprint, attempt, state: "completed", result },
          }
        : { operation: "delete", action: "delete" },
    );
    if (changed.status !== "applied") {
      throw new Error("Shadow announcement receipt changed");
    }
  };
  return {
    complete: (result: FiShadowAnnounceResult) => finish(result),
    /** Only a native proven non-admission/retryable disposition may release this intent. */
    releaseRetryable: () => finish(undefined),
  };
}
