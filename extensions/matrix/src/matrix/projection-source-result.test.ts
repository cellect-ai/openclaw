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
}));
vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
  resolveReplyPublication: m.host,
  registerReplyPublicationReceiptListener: m.subscribe,
  requireReplyPublicationReceipt: m.requireReceipt,
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
};
let stateDir = "",
  stop: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
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
      defaultTtlMs: 30 * 24 * 60 * 60 * 1000,
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
    const other = { ...host, publicationId: "different-publication", runId: "different-run" };
    m.host.mockReturnValue(other);
    await prepareMatrixSourceResult({});
    await expect(listener()(other, receipt)).rejects.toThrow("conflicting");
  });
});
