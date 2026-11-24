import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  createCorePluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "../../plugin-state/plugin-state-store.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  claimFiShadowAnnounceReceipt,
  readFiShadowAnnounceReceipt,
} from "./fi-shadow-announce-receipt.js";

it("admits one native receipt across concurrent senders and rejects mismatched payloads", async () => {
  await withOpenClawTestState({ label: "shadow-receipt-concurrent" }, async () => {
    const claims = await Promise.all([
      claimFiShadowAnnounceReceipt("key", "first"),
      claimFiShadowAnnounceReceipt("key", "first"),
      claimFiShadowAnnounceReceipt("key", "other"),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const first = await readFiShadowAnnounceReceipt("key", "first");
    const other = await readFiShadowAnnounceReceipt("key", "other");
    expect([first?.state, other?.state].toSorted()).toEqual(["mismatch", "unknown"]);
  });
});

it("retains a crash after intent before effect across native store close/reopen", async () => {
  await withOpenClawTestState({ label: "shadow-receipt-crash" }, async () => {
    expect(await claimFiShadowAnnounceReceipt("key", "payload")).toBeDefined();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    expect(await readFiShadowAnnounceReceipt("key", "payload")).toEqual({ state: "unknown" });
    expect(await claimFiShadowAnnounceReceipt("key", "payload")).toBeUndefined();
    expect(await readFiShadowAnnounceReceipt("key", "changed")).toEqual({ state: "mismatch" });
  });
});

it("persists completed results and releases only a proven retryable attempt", async () => {
  await withOpenClawTestState({ label: "shadow-receipt-terminal" }, async () => {
    const retryable = await claimFiShadowAnnounceReceipt("retry", "payload");
    expect(retryable).toBeDefined();
    await retryable!.releaseRetryable();
    const next = await claimFiShadowAnnounceReceipt("retry", "payload");
    expect(next).toBeDefined();
    await next!.complete({ path: "steered", deliveredAt: 7 });
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    expect(await readFiShadowAnnounceReceipt("retry", "payload")).toEqual({
      state: "completed",
      result: { path: "steered", deliveredAt: 7 },
    });
    expect(await claimFiShadowAnnounceReceipt("retry", "payload")).toBeUndefined();
  });
});

it("an old receipt cannot clear or overwrite a replacement native row", async () => {
  await withOpenClawTestState({ label: "shadow-receipt-cas" }, async () => {
    const first = await claimFiShadowAnnounceReceipt("key", "payload");
    const store = createCorePluginStateKeyedStore({
      ownerId: "core:fi-shadow-announce",
      namespace: "receipts-v1",
      retention: "retained",
    });
    const key = createHash("sha256").update("key").digest("hex");
    const replacement = { version: 1, fingerprint: "payload", attempt: "other", state: "unknown" };
    await store.register(key, replacement);
    await expect(first!.releaseRetryable()).rejects.toThrow("receipt changed");
    await expect(first!.complete({ path: "direct" })).rejects.toThrow("receipt changed");
    expect(await store.lookup(key)).toEqual(replacement);
  });
});

it("native state-directory ownership does not leak receipts into another tenant", async () => {
  await withOpenClawTestState({ label: "shadow-receipt-tenant-a" }, async () => {
    await claimFiShadowAnnounceReceipt("shared-key", "payload");
  });
  await withOpenClawTestState({ label: "shadow-receipt-tenant-b" }, async () => {
    expect(await readFiShadowAnnounceReceipt("shared-key", "payload")).toBeUndefined();
    expect(await claimFiShadowAnnounceReceipt("shared-key", "payload")).toBeDefined();
  });
});
