import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginBlobStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
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
}));
vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
  resolveReplyPublication: m.host,
  registerReplyPublicationReceiptListener: m.subscribe,
  requireReplyPublicationReceipt: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", () => ({
  getSessionBindingService: () => ({ resolveByConversation: m.binding }),
}));
vi.mock("./projection-lifecycle.js", () => ({
  resolveMatrixProjectionRun: m.owner,
  noteMatrixProjectionFinalResult: m.note,
}));
vi.mock("./projection-publication.js", () => ({ resolveMatrixReplyPublication: m.publication }));
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
  stop = startMatrixSourceResultReceipts();
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
  if (!subscription) throw new Error("Expected source receipt subscription");
  return subscription[0] as (
    publication: typeof host & { receiptRequired?: true },
    accepted: typeof receipt,
  ) => Promise<void>;
};
describe("durable exact source-result rendezvous", () => {
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
