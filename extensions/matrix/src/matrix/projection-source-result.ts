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
  notification?: { scope: NotificationPublicationScope; actorIds: string[] };
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
      !Array.isArray(value.notification.actorIds) ||
      value.notification.actorIds.length < 1 ||
      value.notification.actorIds.length > 32 ||
      value.notification.actorIds.some(
        (actor) => typeof actor !== "string" || !/^[UW][A-Z0-9]{8,20}$/.test(actor),
      ) ||
      !value.notification.scope ||
      typeof value.notification.scope !== "object")
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
  const releasePrefix = client.status !== "disabled" ? host.deferSynthesizedPrefix?.() : undefined;
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
  ];
  if (client.status === "ready" && actorIds.length > 0) {
    requireReplyPublicationReceipt(event);
  }
  if (actorIds.length > 32) {
    throw new Error("notification publication recipient bound exceeded");
  }
  let hasNotification = false;
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
      client.status === "ready" && canonicalSource?.provider === "slack" && actorIds.length > 0;
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
                published_at_ms: host.publishedAtMs,
              },
              actorIds,
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
      hasNotification = true;
      for (const actor of reference.notification.actorIds) {
        await client.prepare(reference.notification.scope, actor);
      }
    }
  }
  // Origin-only policy has not been authorized. A route reservation is never
  // permission to interrupt; retain the hold for every coordinated recipient.
  if (!hasNotification && !/<[@!]/.test(host.synthesizedPrefix ?? "")) {
    releasePrefix?.();
  }
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
  const entry = await store().lookup(`accepted-${digest(`${bindingId}\0${sourceMessageId}`)}`);
  if (!entry) {
    return;
  }
  const reference = decode(entry.bytes);
  if (
    reference.bindingId !== bindingId ||
    reference.sourceMessageId !== sourceMessageId ||
    reference.roomId !== roomId ||
    !resultEventId.startsWith("$")
  ) {
    return;
  }
  const storage = store(),
    key = `result-${digest(`${bindingId}\0${sourceMessageId}`)}`;
  await storage.registerIfAbsent(
    key,
    new TextEncoder().encode(JSON.stringify({ resultEventId })),
    {},
  );
  const first = await storage.lookup(key);
  if (!first) {
    throw new Error("source-result rendezvous disappeared");
  }
  const accepted = JSON.parse(new TextDecoder().decode(first.bytes)) as { resultEventId?: unknown };
  if (typeof accepted.resultEventId !== "string" || !accepted.resultEventId.startsWith("$")) {
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
    for (const actor of reference.notification.actorIds) {
      const proof = await client.prepare(reference.notification.scope, actor);
      prepared ||= proof.prepared;
    }
    // A known denial has no recipient obligation or prepared bridge context.
    // Unavailable evidence throws above; it must never be treated as denial.
    if (prepared) {
      await client.accepted(reference.notification.scope, sourceMessageId, accepted.resultEventId);
    }
  }
  noteMatrixProjectionFinalResult({
    runId: reference.runId,
    generation: reference.generation,
    bindingId,
    resultEventId: accepted.resultEventId,
  });
}
