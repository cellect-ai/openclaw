// Reference-only durable rendezvous. Neither prose nor public hook IDs confer custody.
import { createHash } from "node:crypto";
import {
  registerReplyPublicationReceiptListener,
  resolveReplyPublication,
  requireReplyPublicationReceipt,
  readNativeFinalDeliveryReceipt,
  retainNativeFinalDeliveryReceipt,
  releaseNativeFinalDeliveryReceipt,
  registerNativeFinalDeliveryListener,
  retireNativeFinalDelivery,
  type NativeFinalDeliveryReference,
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
  nativeFinal?: NativeFinalDeliveryReference;
  notification?: { scope: NotificationPublicationScope };
};
function store(runtime: Pick<PluginRuntime, "state"> = getMatrixRuntime()) {
  return runtime.state.openBlobStore<Record<string, never>>({
    namespace: "projection-source-results-v2",
    maxEntries: 10_000,
    maxBytesPerEntry: 4096,
    maxBytesPerNamespace: 40 * 1024 * 1024,
    overflowPolicy: "reject-new",
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
  if (value.nativeFinal !== undefined) {
    const native = value.nativeFinal;
    if (
      !native ||
      [
        native.storePath,
        native.sessionKey,
        native.sessionId,
        native.intentId,
        native.deliveryId,
        native.sourceRunId,
        native.sourceGeneration,
      ].some((field) => typeof field !== "string" || !field.trim()) ||
      (native.agentId !== undefined && typeof native.agentId !== "string") ||
      native.sourceRunId !== value.runId ||
      native.sourceGeneration !== value.generation
    ) {
      throw new Error("invalid native final delivery correlation");
    }
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
    const nativeFinal = host.nativeFinal;
    if (
      !nativeFinal ||
      nativeFinal.sourceRunId !== host.runId ||
      nativeFinal.sourceGeneration !== owner.generation ||
      nativeFinal.sessionKey !== host.sessionKey
    )
      throw new Error("Matrix source final has no exact native delivery plan");
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
      nativeFinal,
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
    await retainNativeFinalDeliveryReceipt(nativeFinal, nativeConsumer(reference));
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
  const stopNative = registerNativeFinalDeliveryListener(async (plan) => {
    await reconcileMatrixNativeFinalResults(runtime, plan);
  });
  const stopReceipts = registerReplyPublicationReceiptListener(async (host, receipt) => {
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
  return () => {
    stopNative();
    stopReceipts();
  };
}

/** Startup/reconnect recovery rechecks durable native receipts, never missed wakeup history. */
export async function reconcileMatrixNativeFinalResults(
  runtime: Pick<PluginRuntime, "state">,
  selected?: Omit<NativeFinalDeliveryReference, "deliveryId">,
): Promise<void> {
  const storage = store(runtime);
  const errors: unknown[] = [];
  for (const entry of await storage.entries()) {
    if (!entry.key.startsWith("accepted-") && !entry.key.startsWith("pending-")) continue;
    try {
      const item = await storage.lookup(entry.key);
      if (!item) continue;
      const reference = decode(item.bytes);
      if (!reference.nativeFinal || (selected && !sameNativePlan(reference.nativeFinal, selected)))
        continue;
      if (reference.sourceMessageId) await joinNativeResult(reference, storage);
      else await completeNativePlan(reference, storage);
    } catch (error) {
      // Keep the unresolved reference durable and still replay independent receipts.
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Native final receipt replay failed");
}

/** Exact persisted lifecycle source selects recovery; native intent CAS fences further appends. */
export async function retireMatrixSourceFinalPlans(
  runtime: Pick<PluginRuntime, "state">,
  source: {
    runId: string;
    generation: string;
    sessionId: string;
    binding: { bindingId: string; sessionKey: string; agentId: string; roomId: string };
  },
  assertRetired: () => void,
): Promise<void> {
  const storage = store(runtime);
  const seen = new Set<string>();
  for (const item of await storage.entries()) {
    if (!item.key.startsWith("pending-")) continue;
    const stored = await storage.lookup(item.key);
    if (!stored) continue;
    const reference = decode(stored.bytes);
    const plan = reference.nativeFinal;
    if (
      !plan ||
      reference.runId !== source.runId ||
      reference.generation !== source.generation ||
      reference.bindingId !== source.binding.bindingId ||
      reference.roomId !== source.binding.roomId ||
      plan.sessionId !== source.sessionId ||
      plan.sessionKey !== source.binding.sessionKey ||
      plan.agentId !== source.binding.agentId ||
      seen.has(plan.intentId)
    )
      continue;
    assertRetired();
    seen.add(plan.intentId);
    await retireNativeFinalDelivery(plan, nativeConsumer(reference), assertRetired);
  }
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
    reference ? undefined : { ttlMs: 30 * 24 * 60 * 60 * 1000 },
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
  if (first.expiresAt !== undefined) await storage.register(first.key, first.bytes, {});
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
  await storage.registerIfAbsent(
    sourceJoinKey(reference),
    new TextEncoder().encode(JSON.stringify({ resultEventId: accepted.resultEventId })),
    {},
  );
  await completeNativePlan(reference, storage);
}

function nativeConsumer(reference: Reference) {
  return digest(`${reference.bindingId}\0${reference.generation}`);
}
function sourceJoinKey(reference: Reference) {
  return `joined-${reference.publicationId}-${digest(reference.bindingId)}`;
}
function sameNativePlan(
  a: NativeFinalDeliveryReference,
  b: Omit<NativeFinalDeliveryReference, "deliveryId">,
) {
  return (
    a.agentId === b.agentId &&
    a.storePath === b.storePath &&
    a.sessionKey === b.sessionKey &&
    a.sessionId === b.sessionId &&
    a.intentId === b.intentId &&
    a.sourceRunId === b.sourceRunId &&
    a.sourceGeneration === b.sourceGeneration
  );
}
async function completeNativePlan(
  reference: Reference,
  storage: ReturnType<typeof store>,
): Promise<void> {
  const plan = reference.nativeFinal;
  if (!plan) return; // Old per-publication records cannot assert native run finality.
  const consumer = nativeConsumer(reference);
  const key = `plan-joined-${digest(`${plan.sessionId}\0${plan.intentId}\0${consumer}`)}`;
  const priorJoin = await storage.lookup(key);
  if (priorJoin) {
    const joined = JSON.parse(new TextDecoder().decode(priorJoin.bytes)) as {
      resultEventId?: unknown;
      suppressed?: unknown;
    };
    if (
      !(
        typeof joined.resultEventId === "string" &&
        joined.resultEventId.startsWith("$") &&
        joined.suppressed === undefined
      ) &&
      !(joined.suppressed === true && joined.resultEventId === undefined)
    )
      throw new Error("Invalid native final plan join");
    await acknowledgeCompletedPlan(reference, storage, key);
    return;
  }
  const completed = await readNativeFinalDeliveryReceipt(plan, {
    channel: "slack",
    to: reference.sourceConversationId,
    accountId: reference.sourceAccountId,
  });
  if (!completed || !completed.projectionConsumers.includes(consumer)) return;
  if (
    completed.context?.channel !== "slack" ||
    (completed.context.accountId && completed.context.accountId !== reference.sourceAccountId)
  ) {
    throw new Error("Native final plan has different source placement");
  }
  let finalEventId: string | undefined;
  for (const member of completed.deliveries) {
    if (member.state === "suppressed") continue;
    if (
      member.state !== "delivered" ||
      !member.receipt?.finalPlatformMessageId ||
      member.receipt.resultCount < 1
    )
      return;
    const accepted = await storage.lookup(
      `accepted-${digest(`${reference.bindingId}\0${member.receipt.finalPlatformMessageId}`)}`,
    );
    if (!accepted) return;
    const source = decode(accepted.bytes);
    if (
      !source.nativeFinal ||
      !sameNativePlan(source.nativeFinal, plan) ||
      source.nativeFinal.deliveryId !== member.id ||
      source.bindingId !== reference.bindingId ||
      source.generation !== reference.generation ||
      source.roomId !== reference.roomId ||
      source.sourceAccountId !== reference.sourceAccountId ||
      source.sourceConversationId !== reference.sourceConversationId
    ) {
      throw new Error("Native final member does not match its accepted source receipt");
    }
    const joined = await storage.lookup(sourceJoinKey(source));
    if (!joined) return;
    const result = JSON.parse(new TextDecoder().decode(joined.bytes)) as {
      resultEventId?: unknown;
    };
    if (typeof result.resultEventId !== "string" || !result.resultEventId.startsWith("$"))
      throw new Error("Invalid native final member result");
    finalEventId = result.resultEventId;
  }
  // A closed all-suppressed plan has no physical debt or terminal result to invent.
  if (finalEventId)
    await noteMatrixProjectionFinalResult({
      runId: reference.runId,
      generation: reference.generation,
      bindingId: reference.bindingId,
      resultEventId: finalEventId,
    });
  await storage.registerIfAbsent(
    key,
    new TextEncoder().encode(
      JSON.stringify(finalEventId ? { resultEventId: finalEventId } : { suppressed: true }),
    ),
    {},
  );
  await acknowledgeCompletedPlan(reference, storage, key);
}

async function acknowledgeCompletedPlan(
  reference: Reference,
  storage: ReturnType<typeof store>,
  key: string,
): Promise<void> {
  const plan = reference.nativeFinal!;
  const consumer = nativeConsumer(reference);
  // Native debt is released before any supporting reference gains an expiry.
  // A crash before release leaves the durable joined marker and source proof intact.
  await releaseNativeFinalDeliveryReceipt(plan, consumer);
  const settledTtlMs = 30 * 24 * 60 * 60 * 1000;
  // Only the durable lifecycle join above acknowledges this projection debt.
  // Keep settled source receipts available for exact at-least-once outbox replay.
  for (const itemInfo of await storage.entries()) {
    if (!itemInfo.key.startsWith("accepted-") && !itemInfo.key.startsWith("pending-")) continue;
    const item = await storage.lookup(itemInfo.key);
    if (!item) continue;
    const source = decode(item.bytes);
    if (
      !source.nativeFinal ||
      !sameNativePlan(source.nativeFinal, plan) ||
      nativeConsumer(source) !== consumer
    )
      continue;
    for (const sourceKey of [
      itemInfo.key,
      sourceJoinKey(source),
      ...(source.sourceMessageId
        ? [nativeResultKey(source.bindingId, source.sourceMessageId, source.roomId)]
        : []),
    ]) {
      const record = await storage.lookup(sourceKey);
      if (record) await storage.register(sourceKey, record.bytes, {}, { ttlMs: settledTtlMs });
    }
  }
  const joined = await storage.lookup(key);
  if (joined) await storage.register(key, joined.bytes, {}, { ttlMs: settledTtlMs });
}
