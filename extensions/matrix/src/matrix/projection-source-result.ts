// Reference-only durable rendezvous. Neither prose nor public hook IDs confer custody.
import { createHash } from "node:crypto";
import {
  registerReplyPublicationReceiptListener,
  resolveReplyPublication,
  requireReplyPublicationReceipt,
} from "openclaw/plugin-sdk/reply-runtime";
import { getMatrixRuntime } from "../runtime.js";
import {
  resolveMatrixProjectionRun,
  noteMatrixProjectionFinalResult,
} from "./projection-lifecycle.js";
import { resolveMatrixReplyPublication } from "./projection-publication.js";

type Reference = {
  version: 2;
  publicationId: string;
  publishedAtMs: number;
  runId: string;
  generation: string;
  bindingId: string;
  roomId: string;
  environment: string;
  conversationId: string;
  sourceAccountId: string;
  sourceConversationId: string;
  sourceMessageId?: string;
};
function store() {
  return getMatrixRuntime().state.openBlobStore<Record<string, never>>({
    namespace: "projection-source-results-v2",
    maxEntries: 10_000,
    maxBytesPerEntry: 4096,
    maxBytesPerNamespace: 40 * 1024 * 1024,
    overflowPolicy: "reject-new",
    defaultTtlMs: 30 * 24 * 60 * 60 * 1000,
  });
}
function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function encode(value: Reference) {
  return new TextEncoder().encode(JSON.stringify(value));
}
function decode(bytes: Uint8Array): Reference {
  const value = JSON.parse(new TextDecoder().decode(bytes)) as Reference;
  if (
    value.version !== 2 ||
    !value.runId ||
    !value.generation ||
    !value.bindingId ||
    !value.publicationId ||
    !value.roomId.startsWith("!") ||
    !Number.isSafeInteger(value.publishedAtMs)
  )
    throw new Error("invalid private source-result reference");
  return value;
}
/** Awaited by the actual host before source dispatch: never infer final from source history. */
export async function prepareMatrixSourceResult(event: unknown): Promise<void> {
  const host = resolveReplyPublication(event);
  if (host?.kind !== "final" || host.channel !== "slack" || !host.runId || !host.sessionKey) return;
  const owner = resolveMatrixProjectionRun(host.runId, host.sessionKey);
  if (!owner) return;
  const service = await import("openclaw/plugin-sdk/conversation-binding-runtime");
  for (const target of owner.bindings) {
    const binding = service.getSessionBindingService().resolveByConversation({
      channel: "matrix",
      accountId: target.accountId,
      conversationId: target.threadRootEventId,
      parentConversationId: target.roomId,
    });
    const source = binding?.metadata?.externalSource as { channelId?: unknown } | undefined;
    if (
      binding?.bindingId !== target.bindingId ||
      !binding.metadata?.sourceReplyAuthorization ||
      typeof source?.channelId !== "string"
    )
      continue;
    const publication = resolveMatrixReplyPublication(
      event,
      target.accountId,
      target.roomId,
      target.threadRootEventId,
    );
    if (!publication) continue;
    // Hook failures cannot relinquish source custody: require the durable receipt
    // before attempting the owning reference write, so missing storage blocks ACK.
    requireReplyPublicationReceipt(event);
    const reference: Reference = {
      version: 2,
      publicationId: host.publicationId,
      publishedAtMs: host.publishedAtMs,
      runId: host.runId,
      generation: owner.generation,
      bindingId: target.bindingId,
      roomId: target.roomId,
      environment: target.environment,
      conversationId: target.conversationId,
      sourceAccountId: host.accountId ?? "default",
      sourceConversationId: source.channelId,
    };
    const storage = store(),
      key = `pending-${host.publicationId}-${digest(target.bindingId)}`;
    await storage.deleteExpired();
    if (!(await storage.registerIfAbsent(key, encode(reference), {}))) {
      const prior = await storage.lookup(key);
      if (!prior || JSON.stringify(decode(prior.bytes)) !== JSON.stringify(reference))
        throw new Error("conflicting source-result ownership");
    }
  }
}
export function startMatrixSourceResultReceipts() {
  return registerReplyPublicationReceiptListener(async (host, receipt) => {
    if (host.kind !== "final" || receipt.channel !== "slack") return;
    let matched = false;
    const storage = store();
    for (const entry of await storage.entries()) {
      if (!entry.key.startsWith(`pending-${host.publicationId}-`)) continue;
      const stored = await storage.lookup(entry.key);
      if (!stored) continue;
      const reference = decode(stored.bytes);
      if (
        reference.sourceAccountId !== receipt.accountId ||
        reference.sourceConversationId !== receipt.conversationId
      )
        continue;
      matched = true;
      const accepted = { ...reference, sourceMessageId: receipt.messageId };
      const key = `accepted-${digest(`${reference.bindingId}\0${receipt.messageId}`)}`;
      if (!(await storage.registerIfAbsent(key, encode(accepted), {}))) {
        const prior = await storage.lookup(key);
        if (!prior || JSON.stringify(decode(prior.bytes)) !== JSON.stringify(accepted))
          throw new Error("conflicting source-result receipt");
      }
    }
    if (host.receiptRequired && !matched)
      throw new Error(
        "required source-result ownership reference unavailable; preserving producer custody",
      );
  });
}
/** Called only after the complete corresponding native Matrix publication is accepted. */
export async function noteMatrixSourceSnapshotResult(
  bindingId: string,
  sourceMessageId: string,
  roomId: string,
  resultEventId: string,
): Promise<void> {
  const entry = await store().lookup(`accepted-${digest(`${bindingId}\0${sourceMessageId}`)}`);
  if (!entry) return;
  const reference = decode(entry.bytes);
  if (
    reference.bindingId !== bindingId ||
    reference.sourceMessageId !== sourceMessageId ||
    reference.roomId !== roomId ||
    !resultEventId.startsWith("$")
  )
    return;
  const storage = store(),
    key = `result-${digest(`${bindingId}\0${sourceMessageId}`)}`;
  await storage.registerIfAbsent(
    key,
    new TextEncoder().encode(JSON.stringify({ resultEventId })),
    {},
  );
  const first = await storage.lookup(key);
  if (!first) throw new Error("source-result rendezvous disappeared");
  const accepted = JSON.parse(new TextDecoder().decode(first.bytes)) as { resultEventId?: unknown };
  if (typeof accepted.resultEventId !== "string" || !accepted.resultEventId.startsWith("$"))
    throw new Error("invalid source-result rendezvous");
  noteMatrixProjectionFinalResult({
    runId: reference.runId,
    generation: reference.generation,
    bindingId,
    resultEventId: accepted.resultEventId,
  });
}
