// Reference-only durable rendezvous. Neither prose nor public hook IDs confer custody.
import { createHash } from "node:crypto";
import {
  registerReplyPublicationReceiptListener,
  resolveReplyPublication,
  requireReplyPublicationReceipt,
} from "openclaw/plugin-sdk/reply-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { getMatrixRuntime } from "../runtime.js";
import {
  resolveNotificationPublicationClient,
  type NotificationPublicationScope,
} from "./notification-publication-client.js";
import {
  resolveMatrixProjectionRun,
  noteMatrixProjectionFinalResult,
} from "./projection-lifecycle.js";
import {
  resolveMatrixReplyPublication,
  sourcePublicationAccountId,
} from "./projection-publication.js";
import { parseProjectionExternalSource } from "./projection-source.js";

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
  notification?: { scope: NotificationPublicationScope };
};
function store(runtime: Pick<PluginRuntime, "state"> = getMatrixRuntime()) {
  return runtime.state.openBlobStore<Record<string, never>>({
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
  ) {
    throw new Error("invalid private source-result reference");
  }
  if (
    value.notification !== undefined &&
    (!value.notification ||
      !value.notification.scope ||
      typeof value.notification.scope !== "object" ||
      !Array.isArray(value.notification.scope.source_actor_ids) ||
      value.notification.scope.source_actor_ids.length > 32 ||
      value.notification.scope.source_actor_ids.some(
        (actor) => typeof actor !== "string" || !/^[UW][A-Z0-9]{8,20}$/.test(actor),
      ))
  ) {
    throw new Error("invalid private notification-publication reference");
  }
  return value;
}
/** Awaited by the actual host before source dispatch: never infer final from source history. */
export async function prepareMatrixSourceResult(event: unknown): Promise<void> {
  const host = resolveReplyPublication(event);
  if (host?.kind !== "final" || host.channel !== "slack" || !host.runId || !host.sessionKey) {
    return;
  }
  const owner = resolveMatrixProjectionRun(host.runId, host.sessionKey);
  if (!owner) {
    return;
  }
  const client = resolveNotificationPublicationClient();
  // Acquire before the first await. The host retains this decision on hook
  // failure/timeout even when private readiness or storage never responds.
  if (client.status !== "disabled" && /<[@!]/.test(host.synthesizedPrefix ?? "")) {
    host.deferSynthesizedPrefix?.();
  }
  if (client.status === "invalid") {
    requireReplyPublicationReceipt(event);
    throw new Error("notification publication producer configuration unavailable");
  }
  const actorIds = [
    ...new Set(
      Array.from(
        host.synthesizedPrefix?.matchAll(/<@([UW][A-Z0-9]{8,20})>/g) ?? [],
        (match) => match[1]!,
      ),
    ),
  ].toSorted();
  if (client.status === "ready") {
    requireReplyPublicationReceipt(event);
  }
  if (actorIds.length > 32) {
    throw new Error("notification publication recipient bound exceeded");
  }
  if (
    client.status === "ready" &&
    /<[@!]/.test((host.synthesizedPrefix ?? "").replaceAll(/<@[UW][A-Z0-9]{8,20}>/g, ""))
  ) {
    throw new Error("notification publication recipient cohort unavailable");
  }
  const service = await import("openclaw/plugin-sdk/conversation-binding-runtime");
  for (const target of owner.bindings) {
    const binding = service.getSessionBindingService().resolveByConversation({
      channel: "matrix",
      accountId: target.accountId,
      conversationId: target.threadRootEventId,
      parentConversationId: target.roomId,
    });
    const source = binding?.metadata?.externalSource as { channelId?: unknown } | undefined;
    const canonicalSource = parseProjectionExternalSource(binding?.metadata?.externalSource);
    const coordinatesNotifications =
      client.status === "ready" && canonicalSource?.provider === "slack";
    if (
      binding?.bindingId !== target.bindingId ||
      (!binding.metadata?.sourceReplyAuthorization && !coordinatesNotifications) ||
      typeof source?.channelId !== "string"
    ) {
      continue;
    }
    const publication = resolveMatrixReplyPublication(
      event,
      target.accountId,
      target.roomId,
      target.threadRootEventId,
    );
    if (!publication) {
      continue;
    }
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
      ...(coordinatesNotifications && canonicalSource
        ? {
            notification: {
              scope: {
                environment: target.environment,
                publication_id: host.publicationId,
                room_id: target.roomId,
                conversation_id: target.conversationId,
                binding_id: target.bindingId,
                run_id: host.runId,
                generation: owner.generation,
                provider: "slack",
                source_account_id: sourcePublicationAccountId(binding.metadata, target.accountId),
                source_workspace_id: canonicalSource.workspaceId,
                source_conversation_id: canonicalSource.channelId,
                source_root_message_id: canonicalSource.rootMessageId,
                source_actor_ids: actorIds,
                published_at_ms: host.publishedAtMs,
              },
            },
          }
        : {}),
    };
    const storage = store(),
      key = `pending-${host.publicationId}-${digest(target.bindingId)}`;
    await storage.deleteExpired();
    if (!(await storage.registerIfAbsent(key, encode(reference), {}))) {
      const prior = await storage.lookup(key);
      if (!prior || JSON.stringify(decode(prior.bytes)) !== JSON.stringify(reference)) {
        throw new Error("conflicting source-result ownership");
      }
    }
    if (reference.notification && client.status === "ready") {
      for (const actor of actorIds.length ? actorIds : [undefined]) {
        await client.prepare(reference.notification.scope, actor);
      }
    }
  }
  // A source reservation is exclusion, never permission to interrupt. The
  // origin-only policy remains unresolved, so no synthesized mention is released.
}
export function startMatrixSourceResultReceipts(runtime: Pick<PluginRuntime, "state">) {
  return registerReplyPublicationReceiptListener(async (host, receipt) => {
    if (host.kind !== "final" || receipt.channel !== "slack") {
      return;
    }
    let matched = false;
    // Slack receipts arrive outside Matrix's plugin invocation scope. Keep the
    // exact Matrix instance's state capability captured at registration.
    const storage = store(runtime);
    for (const entry of await storage.entries()) {
      if (!entry.key.startsWith(`pending-${host.publicationId}-`)) {
        continue;
      }
      const stored = await storage.lookup(entry.key);
      if (!stored) {
        continue;
      }
      const reference = decode(stored.bytes);
      if (
        reference.sourceAccountId !== receipt.accountId ||
        reference.sourceConversationId !== receipt.conversationId
      ) {
        continue;
      }
      matched = true;
      const accepted = { ...reference, sourceMessageId: receipt.messageId };
      const key = `accepted-${digest(`${reference.bindingId}\0${receipt.messageId}`)}`;
      if (!(await storage.registerIfAbsent(key, encode(accepted), {}))) {
        const prior = await storage.lookup(key);
        if (!prior || JSON.stringify(decode(prior.bytes)) !== JSON.stringify(accepted)) {
          throw new Error("conflicting source-result receipt");
        }
      }
      // The native copy may have been accepted while Slack's POST response
      // was still in flight. Either receipt can complete the same rendezvous.
      await joinNativeResult(accepted, storage);
    }
    if (host.receiptRequired && !matched) {
      throw new Error(
        "required source-result ownership reference unavailable; preserving producer custody",
      );
    }
  });
}
/** Called only after the complete corresponding native Matrix publication is accepted. */
export async function noteMatrixSourceSnapshotResult(
  bindingId: string,
  sourceMessageId: string,
  roomId: string,
  resultEventId: string,
): Promise<void> {
  if (!bindingId || !sourceMessageId || !roomId.startsWith("!") || !resultEventId.startsWith("$")) {
    return;
  }
  const storage = store();
  const entry = await storage.lookup(`accepted-${digest(`${bindingId}\0${sourceMessageId}`)}`);
  const reference = entry ? decode(entry.bytes) : undefined;
  if (
    reference &&
    (reference.bindingId !== bindingId ||
      reference.sourceMessageId !== sourceMessageId ||
      reference.roomId !== roomId)
  ) {
    return;
  }
  const key = nativeResultKey(bindingId, sourceMessageId, roomId);
  // Deployed legacy result keys were written only after a matching source
  // receipt. Preserve their first event when that owning receipt still exists.
  const legacy = reference
    ? await storage.lookup(`result-${digest(`${bindingId}\0${sourceMessageId}`)}`)
    : undefined;
  const frozen = legacy
    ? (JSON.parse(new TextDecoder().decode(legacy.bytes)) as { resultEventId: unknown })
    : { resultEventId };
  if (typeof frozen.resultEventId !== "string" || !frozen.resultEventId.startsWith("$")) {
    throw new Error("invalid source-result rendezvous");
  }
  await storage.deleteExpired();
  await storage.registerIfAbsent(
    key,
    new TextEncoder().encode(JSON.stringify({ roomId, resultEventId: frozen.resultEventId })),
    {},
  );
  if (reference) {
    await joinNativeResult(reference, storage);
  }
}

function nativeResultKey(bindingId: string, sourceMessageId: string, roomId: string) {
  return `native-${digest(`${bindingId}\0${sourceMessageId}\0${roomId}`)}`;
}
async function joinNativeResult(reference: Reference, storage: ReturnType<typeof store>) {
  if (!reference.sourceMessageId) {
    return;
  }
  const first =
    (await storage.lookup(
      nativeResultKey(reference.bindingId, reference.sourceMessageId, reference.roomId),
    )) ??
    (await storage.lookup(
      `result-${digest(`${reference.bindingId}\0${reference.sourceMessageId}`)}`,
    ));
  if (!first) {
    return;
  }
  const accepted = JSON.parse(new TextDecoder().decode(first.bytes)) as {
    roomId?: unknown;
    resultEventId?: unknown;
  };
  if (
    (accepted.roomId !== undefined && accepted.roomId !== reference.roomId) ||
    typeof accepted.resultEventId !== "string" ||
    !accepted.resultEventId.startsWith("$")
  ) {
    throw new Error("invalid source-result rendezvous");
  }
  if (reference.notification) {
    const client = resolveNotificationPublicationClient();
    if (client.status !== "ready") {
      throw new Error("notification publication producer unavailable during acceptance");
    }
    // An earlier prepare may have failed while the ordinary source reply was
    // accepted. Retry its exact frozen identity before acknowledging the join.
    let prepared = false;
    const actors = reference.notification.scope.source_actor_ids;
    for (const actor of actors.length ? actors : [undefined]) {
      const proof = await client.prepare(reference.notification.scope, actor);
      prepared ||= proof.prepared;
    }
    // A known denial has no recipient obligation or prepared bridge context.
    // Unavailable evidence throws above; it must never be treated as denial.
    if (prepared) {
      await client.accepted(
        reference.notification.scope,
        reference.sourceMessageId,
        accepted.resultEventId,
      );
    }
  }
  noteMatrixProjectionFinalResult({
    runId: reference.runId,
    generation: reference.generation,
    bindingId: reference.bindingId,
    resultEventId: accepted.resultEventId,
  });
}
