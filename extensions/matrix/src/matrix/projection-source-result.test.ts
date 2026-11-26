import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginBlobStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMatrixRuntime } from "../runtime.js";
import { installMatrixTestRuntime } from "../test-runtime.js";
import {
  prepareMatrixSourceResult,
  startMatrixSourceResultReceipts,
  noteMatrixSourceSnapshotResult,
  reconcileMatrixNativeFinalResults,
  retireMatrixSourceFinalPlans,
} from "./projection-source-result.js";
const m = vi.hoisted(() => ({
  host: vi.fn(),
  owner: vi.fn(),
  note: vi.fn(),
  binding: vi.fn(),
  subscribe: vi.fn(),
  publication: vi.fn(),
  client: vi.fn(),
  prepare: vi.fn(),
  accepted: vi.fn(),
  hold: vi.fn(),
  release: vi.fn(),
  requireReceipt: vi.fn(),
  nativeReceipt: vi.fn(),
  retainNative: vi.fn(),
  releaseNative: vi.fn(),
  nativeSubscribe: vi.fn(),
  retireNative: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
  resolveReplyPublication: m.host,
  registerReplyPublicationReceiptListener: m.subscribe,
  requireReplyPublicationReceipt: m.requireReceipt,
  readNativeFinalDeliveryReceipt: m.nativeReceipt,
  retainNativeFinalDeliveryReceipt: m.retainNative,
  releaseNativeFinalDeliveryReceipt: m.releaseNative,
  registerNativeFinalDeliveryListener: m.nativeSubscribe,
  retireNativeFinalDelivery: m.retireNative,
}));
vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", () => ({
  getSessionBindingService: () => ({ resolveByConversation: m.binding }),
}));
vi.mock("./projection-lifecycle.js", () => ({
  resolveMatrixProjectionRun: m.owner,
  noteMatrixProjectionFinalResult: m.note,
}));
vi.mock("./projection-publication.js", () => ({
  resolveMatrixReplyPublication: m.publication,
  sourcePublicationAccountId: () => "projection-account",
}));
vi.mock("./notification-publication-client.js", () => ({
  resolveNotificationPublicationClient: m.client,
}));
const target = {
  environment: "test",
  conversationId: "conversation",
  roomId: "!room",
  bindingId: "binding",
  accountId: "matrix",
  threadRootEventId: "$root",
};
const host = {
  version: 2,
  publicationId: "publication",
  publishedAtMs: 1000,
  kind: "final",
  channel: "slack",
  sessionKey: "session",
  runId: "run",
  accountId: "source",
  nativeFinal: {
    agentId: "main",
    storePath: "/synthetic/agent.sqlite",
    sessionKey: "session",
    sessionId: "native-session",
    intentId: "native-intent",
    deliveryId: "native-first",
    sourceRunId: "run",
    sourceGeneration: "owning-opaque-uuid",
  },
};
let nativeTo = "C1";
const consumers = new Set<string>();
let stateDir = "",
  stop: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  nativeTo = "C1";
  consumers.clear();
  m.nativeSubscribe.mockReturnValue(vi.fn());
  m.retainNative.mockImplementation(async (_plan, consumer) => {
    consumers.add(consumer);
  });
  m.releaseNative.mockResolvedValue(undefined);
  m.retireNative.mockResolvedValue(undefined);
  m.nativeReceipt.mockImplementation(async (plan) => ({
    ...plan,
    completedAt: Date.now(),
    context: { channel: "slack", to: nativeTo, accountId: "source" },
    projectionConsumers: [...consumers],
    deliveries: [
      {
        id: "native-first",
        state: "delivered",
        receipt: {
          platformMessageId: "1.000001",
          finalPlatformMessageId: "1.000001",
          resultCount: 1,
        },
      },
    ],
  }));
  m.client.mockReturnValue({ status: "disabled" });
  m.prepare.mockResolvedValue({ prepared: true, reservedRoute: "mobile", originPermit: false });
  m.accepted.mockResolvedValue(undefined);
  m.hold.mockReturnValue(m.release);
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-source-result-"));
  installMatrixTestRuntime({ stateDir });
  m.host.mockReturnValue(host);
  m.owner.mockReturnValue({ generation: "owning-opaque-uuid", bindings: [target] });
  m.binding.mockReturnValue({
    bindingId: "binding",
    metadata: { sourceReplyAuthorization: "reviewed", externalSource: { channelId: "C1" } },
  });
  m.publication.mockReturnValue({});
  m.subscribe.mockImplementation(() => vi.fn());
  stop = startMatrixSourceResultReceipts(getMatrixRuntime());
});
afterEach(() => {
  stop?.();
  resetPluginBlobStoreForTests({ closeDatabase: false });
  fs.rmSync(stateDir, { recursive: true, force: true });
});
const receipt = {
  channel: "slack",
  accountId: "source",
  conversationId: "C1",
  messageId: "1.000001",
};
const listener = () => {
  const subscription = m.subscribe.mock.calls[0];
  if (!subscription) {
    throw new Error("Expected source receipt subscription");
  }
  return subscription[0] as (
    publication: typeof host & { receiptRequired?: true },
    accepted: typeof receipt,
  ) => Promise<void>;
};
describe("durable exact source-result rendezvous", () => {
  function enableNotificationRouting() {
    nativeTo = "C12345678";
    m.client.mockReturnValue({ status: "ready", prepare: m.prepare, accepted: m.accepted });
    m.host.mockReturnValue({
      ...host,
      publicationId: "12345678-1234-4234-8234-123456789abc",
      synthesizedPrefix: "<@U12345678>",
      deferSynthesizedPrefix: m.hold,
    });
    m.binding.mockReturnValue({
      bindingId: target.bindingId,
      metadata: {
        boundBy: "session-projection-read-only",
        externalSource: {
          provider: "slack",
          workspaceId: "T12345678",
          channelId: "C12345678",
          rootMessageId: "1.000000",
        },
      },
    });
  }

  it("withholds synchronously and prepares a read-only source without reverse-write permission", async () => {
    enableNotificationRouting();
    const pending = prepareMatrixSourceResult({});
    expect(m.hold).toHaveBeenCalledOnce();
    expect(m.requireReceipt).toHaveBeenCalledOnce();
    await pending;
    expect(m.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        publication_id: "12345678-1234-4234-8234-123456789abc",
        published_at_ms: host.publishedAtMs,
        source_account_id: "projection-account",
        source_workspace_id: "T12345678",
        source_conversation_id: "C12345678",
        source_root_message_id: "1.000000",
        source_actor_ids: ["U12345678"],
        binding_id: target.bindingId,
        generation: "owning-opaque-uuid",
      }),
      "U12345678",
    );
    expect(m.release).not.toHaveBeenCalled();
  });

  it("prepares a positive empty cohort without withholding an ordinary label", async () => {
    enableNotificationRouting();
    m.host.mockReturnValue({
      ...host,
      publicationId: "12345678-1234-4234-8234-123456789abc",
      synthesizedPrefix: "Agent",
      deferSynthesizedPrefix: m.hold,
    });
    await prepareMatrixSourceResult({});
    expect(m.hold).not.toHaveBeenCalled();
    expect(m.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ source_actor_ids: [] }),
      undefined,
    );
  });

  it("joins an earlier native result when the provider receipt arrives after a restart", async () => {
    enableNotificationRouting();
    await noteMatrixSourceSnapshotResult("binding", receipt.messageId, "!room", "$native-first");
    expect(m.note).not.toHaveBeenCalled();
    resetPluginBlobStoreForTests({ closeDatabase: false });
    installMatrixTestRuntime({ stateDir });
    await prepareMatrixSourceResult({});
    await listener()(m.host.mock.results[0]?.value, { ...receipt, conversationId: "C12345678" });
    expect(m.accepted).toHaveBeenCalledWith(
      expect.objectContaining({ source_actor_ids: ["U12345678"] }),
      receipt.messageId,
      "$native-first",
    );
    expect(m.note).toHaveBeenCalledWith(
      expect.objectContaining({ resultEventId: "$native-first" }),
    );
  });

  it("does not let an unmatched native candidate from another room poison the result", async () => {
    enableNotificationRouting();
    await prepareMatrixSourceResult({});
    await noteMatrixSourceSnapshotResult("binding", receipt.messageId, "!other-room", "$foreign");
    await noteMatrixSourceSnapshotResult("binding", receipt.messageId, "!room", "$correct");
    await listener()(m.host.mock.results[0]?.value, { ...receipt, conversationId: "C12345678" });
    expect(m.accepted).toHaveBeenCalledWith(expect.anything(), receipt.messageId, "$correct");
    expect(m.note).toHaveBeenCalledWith(expect.objectContaining({ resultEventId: "$correct" }));
  });

  it("does not invent a prepared bridge context for an invalid source", async () => {
    enableNotificationRouting();
    m.prepare.mockResolvedValue({ prepared: false, reservedRoute: "unknown", originPermit: false });
    await prepareMatrixSourceResult({});
    await listener()(m.host.mock.results[0]?.value, { ...receipt, conversationId: "C12345678" });
    await noteMatrixSourceSnapshotResult("binding", receipt.messageId, "!room", "$snapshot");
    expect(m.prepare).toHaveBeenCalledTimes(2);
    expect(m.accepted).not.toHaveBeenCalled();
    expect(m.release).not.toHaveBeenCalled();
    expect(m.note).toHaveBeenCalledWith(expect.objectContaining({ resultEventId: "$snapshot" }));
  });

  it("joins a verified source even when every addressed recipient has no eligible route", async () => {
    enableNotificationRouting();
    m.prepare.mockResolvedValue({ prepared: true, reservedRoute: "unknown", originPermit: false });
    await prepareMatrixSourceResult({});
    await listener()(m.host.mock.results[0]?.value, { ...receipt, conversationId: "C12345678" });
    await noteMatrixSourceSnapshotResult("binding", receipt.messageId, "!room", "$snapshot");
    expect(m.accepted).toHaveBeenCalledWith(
      expect.objectContaining({ source_actor_ids: ["U12345678"] }),
      receipt.messageId,
      "$snapshot",
    );
    expect(m.release).not.toHaveBeenCalled();
    expect(m.note).toHaveBeenCalledWith(expect.objectContaining({ resultEventId: "$snapshot" }));
  });

  it("retains frozen custody after failed prepare and retries it before native result acknowledgment", async () => {
    enableNotificationRouting();
    m.prepare.mockRejectedValueOnce(new Error("authority unavailable"));
    await expect(prepareMatrixSourceResult({})).rejects.toThrow("authority unavailable");
    expect(m.release).not.toHaveBeenCalled();
    const admittedHost = m.host.mock.results[0]?.value;
    await listener()(admittedHost, { ...receipt, conversationId: "C12345678" });
    m.accepted.mockRejectedValueOnce(new Error("accepted native result still unavailable"));
    await expect(
      noteMatrixSourceSnapshotResult("binding", receipt.messageId, "!room", "$snapshot"),
    ).rejects.toThrow("still unavailable");
    expect(m.note).not.toHaveBeenCalled();
    await noteMatrixSourceSnapshotResult("binding", receipt.messageId, "!room", "$later-snapshot");
    expect(m.accepted).toHaveBeenLastCalledWith(
      expect.objectContaining({
        publication_id: "12345678-1234-4234-8234-123456789abc",
        published_at_ms: host.publishedAtMs,
      }),
      receipt.messageId,
      "$snapshot",
    );
    expect(m.note).toHaveBeenCalledWith(expect.objectContaining({ resultEventId: "$snapshot" }));
  });

  it("does not acknowledge a required source receipt whose ownership write was unavailable", async () => {
    await expect(listener()({ ...host, receiptRequired: true }, receipt)).rejects.toThrow(
      "preserving producer custody",
    );
    expect(m.note).not.toHaveBeenCalled();
  });
  it("rejects public claims, premature snapshot, foreign account/channel and unowned run", async () => {
    m.host.mockReturnValueOnce(undefined);
    await prepareMatrixSourceResult({ runId: "run", publicationId: "publication" });
    await noteMatrixSourceSnapshotResult("binding", receipt.messageId, "!room", "$snapshot");
    expect(m.note).not.toHaveBeenCalled();
    await prepareMatrixSourceResult({});
    await listener()(host, { ...receipt, accountId: "foreign" });
    await listener()(host, { ...receipt, conversationId: "foreign" });
    await noteMatrixSourceSnapshotResult("binding", receipt.messageId, "!room", "$snapshot");
    expect(m.note).not.toHaveBeenCalled();
    m.owner.mockReturnValueOnce(undefined);
    await prepareMatrixSourceResult({});
  });
  it("requires actual receipt then complete matching Matrix accepted event", async () => {
    await prepareMatrixSourceResult({});
    await listener()(host, receipt);
    await noteMatrixSourceSnapshotResult("foreign", receipt.messageId, "!room", "$snapshot");
    await noteMatrixSourceSnapshotResult("binding", receipt.messageId, "!wrong", "$snapshot");
    expect(m.note).not.toHaveBeenCalled();
    await noteMatrixSourceSnapshotResult("binding", receipt.messageId, "!room", "$snapshot");
    expect(m.note).toHaveBeenCalledWith({
      runId: "run",
      generation: "owning-opaque-uuid",
      bindingId: "binding",
      resultEventId: "$snapshot",
    });
  });
  it("accepts a Slack receipt outside the Matrix plugin invocation after source delivery", async () => {
    await prepareMatrixSourceResult({});
    const runtime = getMatrixRuntime();
    const slot = createPluginRuntimeStore({
      pluginId: "matrix",
      errorMessage: "Matrix runtime not initialized",
    });
    slot.clearRuntime();
    try {
      await expect(listener()(host, receipt)).resolves.toBeUndefined();
    } finally {
      slot.setRuntime(runtime);
    }
  });
  it("replays reference custody after restart without resolving a live run or reading prose", async () => {
    await prepareMatrixSourceResult({});
    await listener()(host, receipt);
    resetPluginBlobStoreForTests({ closeDatabase: false });
    installMatrixTestRuntime({ stateDir });
    m.owner.mockReturnValue(undefined);
    m.host.mockReturnValue(undefined);
    await noteMatrixSourceSnapshotResult("binding", receipt.messageId, "!room", "$accepted");
    await noteMatrixSourceSnapshotResult("binding", receipt.messageId, "!room", "$later-edit");
    expect(m.note).toHaveBeenLastCalledWith({
      runId: "run",
      generation: "owning-opaque-uuid",
      bindingId: "binding",
      resultEventId: "$accepted",
    });
    const storage = getMatrixRuntime().state.openBlobStore({
      namespace: "projection-source-results-v2",
      maxEntries: 10_000,
      maxBytesPerEntry: 4096,
      maxBytesPerNamespace: 40 * 1024 * 1024,
      overflowPolicy: "reject-new",
    });
    for (const entry of await storage.entries()) {
      const stored = await storage.lookup(entry.key);
      const json = new TextDecoder().decode(stored!.bytes);
      expect(json).not.toMatch(/"(?:text|content|payload|token)"/);
    }
  });
  it("fails closed if a provider message receipt conflicts with another owning final", async () => {
    await prepareMatrixSourceResult({});
    await listener()(host, receipt);
    const other = {
      ...host,
      publicationId: "different-publication",
      runId: "different-run",
      nativeFinal: { ...host.nativeFinal, sourceRunId: "different-run" },
    };
    m.host.mockReturnValue(other);
    await prepareMatrixSourceResult({});
    await expect(listener()(other, receipt)).rejects.toThrow("conflicting");
  });
  it("waits for native closure of two finals, preserves both joins, and notes only the last physical result", async () => {
    m.nativeReceipt.mockResolvedValue(undefined);
    await prepareMatrixSourceResult({});
    await listener()(host, receipt);
    await noteMatrixSourceSnapshotResult("binding", receipt.messageId, "!room", "$first");
    const second = {
      ...host,
      publicationId: "second",
      nativeFinal: { ...host.nativeFinal, deliveryId: "native-last" },
    };
    m.host.mockReturnValue(second);
    await prepareMatrixSourceResult({});
    await listener()(second, { ...receipt, messageId: "2.000002" });
    await noteMatrixSourceSnapshotResult("binding", "2.000002", "!room", "$last");
    expect(m.note).not.toHaveBeenCalled();
    m.nativeReceipt.mockResolvedValue({
      ...host.nativeFinal,
      completedAt: Date.now(),
      context: { channel: "slack", to: "C1", accountId: "source" },
      projectionConsumers: [...consumers],
      deliveries: [
        {
          id: "native-first",
          state: "delivered",
          receipt: {
            platformMessageId: "1.000000",
            finalPlatformMessageId: receipt.messageId,
            resultCount: 2,
          },
        },
        {
          id: "native-last",
          state: "delivered",
          receipt: {
            platformMessageId: "2.000001",
            finalPlatformMessageId: "2.000002",
            resultCount: 2,
          },
        },
      ],
    });
    resetPluginBlobStoreForTests({ closeDatabase: false });
    installMatrixTestRuntime({ stateDir });
    await reconcileMatrixNativeFinalResults(getMatrixRuntime());
    await reconcileMatrixNativeFinalResults(getMatrixRuntime());
    expect(m.note).toHaveBeenCalledTimes(1);
    expect(m.note).toHaveBeenCalledWith(expect.objectContaining({ resultEventId: "$last" }));
    expect(m.releaseNative).toHaveBeenCalled();
  });
  it("uses the last delivered member before a suppressed suffix", async () => {
    const original = m.nativeReceipt.getMockImplementation()!;
    m.nativeReceipt.mockImplementation(async (plan) => ({
      ...(await original(plan)),
      deliveries: [
        {
          id: "native-first",
          state: "delivered",
          receipt: {
            platformMessageId: receipt.messageId,
            finalPlatformMessageId: receipt.messageId,
            resultCount: 1,
          },
        },
        { id: "suppressed-suffix", state: "suppressed" },
      ],
    }));
    await prepareMatrixSourceResult({});
    await listener()(host, receipt);
    await noteMatrixSourceSnapshotResult("binding", receipt.messageId, "!room", "$answer");
    expect(m.note).toHaveBeenCalledWith(expect.objectContaining({ resultEventId: "$answer" }));
  });
  it("releases a closed all-suppressed plan without inventing a physical terminal", async () => {
    const original = m.nativeReceipt.getMockImplementation()!;
    m.nativeReceipt.mockImplementation(async (plan) => ({
      ...(await original(plan)),
      deliveries: [{ id: "native-first", state: "suppressed" }],
    }));
    await prepareMatrixSourceResult({});
    await reconcileMatrixNativeFinalResults(getMatrixRuntime());
    expect(m.note).not.toHaveBeenCalled();
    expect(m.releaseNative).toHaveBeenCalled();
  });
  it("replays a later valid receipt while retaining and reporting an unproven source placement", async () => {
    const mismatch = new Error("Native final receipt has different source placement");
    const validPlan = { ...host.nativeFinal, intentId: "valid-intent" };
    const original = m.nativeReceipt.getMockImplementation()!;
    m.nativeReceipt.mockImplementation(async (plan, source) => {
      if (plan.intentId === host.nativeFinal.intentId) throw mismatch;
      return {
        ...(await original(plan, source)),
        deliveries: [{ id: "native-first", state: "suppressed" }],
      };
    });
    await prepareMatrixSourceResult({});
    m.host.mockReturnValue({ ...host, publicationId: "publication-z", nativeFinal: validPlan });
    await prepareMatrixSourceResult({});

    await expect(reconcileMatrixNativeFinalResults(getMatrixRuntime())).rejects.toBe(mismatch);
    expect(m.nativeReceipt.mock.calls.map(([plan]) => plan.intentId)).toEqual([
      host.nativeFinal.intentId,
      validPlan.intentId,
    ]);
    expect(m.releaseNative).toHaveBeenCalledTimes(1);
    expect(m.releaseNative).toHaveBeenCalledWith(validPlan, expect.any(String));
    expect(m.note).not.toHaveBeenCalled();

    m.nativeReceipt.mockClear();
    await expect(reconcileMatrixNativeFinalResults(getMatrixRuntime())).rejects.toBe(mismatch);
    expect(m.nativeReceipt).toHaveBeenCalledTimes(1);
  });
  it.each(["queued", "unknown", "missing-final-receipt"])(
    "does not substitute a source ACK for native %s custody",
    async (state) => {
      const original = m.nativeReceipt.getMockImplementation()!;
      m.nativeReceipt.mockImplementation(async (plan) => ({
        ...(await original(plan)),
        deliveries: [
          {
            id: "native-first",
            state: state === "missing-final-receipt" ? "delivered" : state,
            receipt: { platformMessageId: receipt.messageId, resultCount: 1 },
          },
        ],
      }));
      await prepareMatrixSourceResult({});
      await listener()(host, receipt);
      await noteMatrixSourceSnapshotResult("binding", receipt.messageId, "!room", "$answer");
      expect(m.note).not.toHaveBeenCalled();
      expect(m.releaseNative).not.toHaveBeenCalled();
    },
  );
  it("keeps incomplete source custody beyond the old TTL and does not treat missing native receipt as success", async () => {
    m.nativeReceipt.mockResolvedValue(undefined);
    await prepareMatrixSourceResult({});
    await listener()(host, receipt);
    await noteMatrixSourceSnapshotResult("binding", receipt.messageId, "!room", "$answer");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 24 * 60 * 60 * 1000);
    try {
      resetPluginBlobStoreForTests({ closeDatabase: false });
      installMatrixTestRuntime({ stateDir });
      await reconcileMatrixNativeFinalResults(getMatrixRuntime());
      expect(m.nativeReceipt).toHaveBeenCalled();
      expect(m.note).not.toHaveBeenCalled();
      expect(m.releaseNative).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
  it("retains joined proof beyond TTL when native consumer release fails and retries after restart", async () => {
    await prepareMatrixSourceResult({});
    await listener()(host, receipt);
    m.releaseNative.mockRejectedValue(new Error("native release unavailable"));
    await expect(
      noteMatrixSourceSnapshotResult("binding", receipt.messageId, "!room", "$answer"),
    ).rejects.toThrow("native release unavailable");
    expect(m.note).toHaveBeenCalledTimes(1);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 24 * 60 * 60 * 1000);
    try {
      resetPluginBlobStoreForTests({ closeDatabase: false });
      installMatrixTestRuntime({ stateDir });
      m.releaseNative.mockResolvedValue(undefined);
      m.releaseNative.mockClear();
      await reconcileMatrixNativeFinalResults(getMatrixRuntime());
      expect(m.releaseNative).toHaveBeenCalled();
      expect(m.note).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });
  it("retires only the exact durable lifecycle source and binding", async () => {
    await prepareMatrixSourceResult({});
    const source = {
      runId: "run",
      generation: "owning-opaque-uuid",
      sessionId: "native-session",
      binding: { bindingId: "binding", sessionKey: "session", agentId: "main", roomId: "!room" },
    };
    const assertRetired = vi.fn();
    await retireMatrixSourceFinalPlans(
      getMatrixRuntime(),
      { ...source, binding: { ...source.binding, bindingId: "foreign" } },
      assertRetired,
    );
    await retireMatrixSourceFinalPlans(
      getMatrixRuntime(),
      { ...source, sessionId: "replacement" },
      assertRetired,
    );
    expect(m.retireNative).not.toHaveBeenCalled();
    await retireMatrixSourceFinalPlans(getMatrixRuntime(), source, assertRetired);
    expect(m.retireNative).toHaveBeenCalledWith(
      host.nativeFinal,
      expect.any(String),
      assertRetired,
    );
  });
});
