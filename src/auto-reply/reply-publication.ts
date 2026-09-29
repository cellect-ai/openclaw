import { randomUUID } from "node:crypto";
import type { ReplyPayload } from "./reply-payload.js";
import type { ReplyDispatchKind } from "./reply/reply-dispatcher.types.js";

export interface ReplyPublication {
  readonly version: 2;
  readonly publicationId: string;
  readonly publishedAtMs: number;
  readonly kind: ReplyDispatchKind;
  readonly channel?: string;
  readonly sessionKey?: string;
  readonly runId?: string;
  readonly accountId?: string;
  readonly receiptRequired?: true;
}
const identities = new WeakMap<object, { publicationId: string; publishedAtMs: number }>();
const records = new WeakMap<object, ReplyPublication>();
const requiredReceipts = new WeakSet<ReplyPublication>();
/** An operational consumer can require custody only for this exact host publication. */
export function requireReplyPublicationReceipt(value: unknown): void {
  const record = resolveReplyPublication(value);
  if (record) requiredReceipts.add(record);
}
export function isReplyPublicationReceiptRequired(value: unknown): boolean {
  const record = resolveReplyPublication(value);
  return !!record && requiredReceipts.has(record);
}
export function preparedReplyPublication(value: unknown): ReplyPublication | undefined {
  const record = resolveReplyPublication(value);
  return record && requiredReceipts.has(record)
    ? Object.freeze({ ...record, receiptRequired: true as const })
    : record;
}
export interface ReplyPublicationReceipt {
  readonly channel: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly messageId: string;
}
const receiptListeners = new Set<
  (publication: ReplyPublication, receipt: ReplyPublicationReceipt) => Promise<void>
>();
/** Trusted channel sender calls only after the provider accepted this exact host payload. */
export async function emitReplyPublicationAccepted(
  payload: object,
  receipt: ReplyPublicationReceipt,
): Promise<void> {
  const publication = records.get(payload);
  if (!publication) return;
  await emitStoredReplyPublicationAccepted(publication, receipt);
}
/** Core-private prepared queue reference, never exposed as an SDK JSON custody setter. */
export async function emitStoredReplyPublicationAccepted(
  publication: ReplyPublication,
  receipt: ReplyPublicationReceipt,
): Promise<void> {
  if (
    publication.version !== 2 ||
    !/^[a-f0-9-]{36}$/i.test(publication.publicationId) ||
    !Number.isSafeInteger(publication.publishedAtMs) ||
    publication.kind !== "final" ||
    publication.channel !== receipt.channel ||
    (publication.accountId && publication.accountId !== receipt.accountId) ||
    !receipt.messageId?.trim() ||
    !receipt.conversationId?.trim()
  )
    return;
  const frozen = Object.freeze({ ...receipt });
  const requiredPublication = requiredReceipts.has(publication)
    ? Object.freeze({ ...publication, receiptRequired: true as const })
    : publication;
  if (requiredPublication.receiptRequired && receiptListeners.size === 0)
    throw new Error(
      "required publication receipt listener unavailable; preserving producer custody",
    );
  for (const listener of receiptListeners) await listener(requiredPublication, frozen);
}
export function registerReplyPublicationReceiptListener(
  listener: (publication: ReplyPublication, receipt: ReplyPublicationReceipt) => Promise<void>,
): () => void {
  receiptListeners.add(listener);
  return () => {
    receiptListeners.delete(listener);
  };
}
/** Only core admission can mint this record; copied JSON fields are correlation, not custody. */
export function bindReplyPublication(
  event: object,
  params: {
    payload: ReplyPayload;
    kind: ReplyDispatchKind;
    channel?: string;
    sessionKey?: string;
    runId?: string;
    context?: { accountId?: string };
  },
): ReplyPublication {
  const previous = records.get(params.payload);
  let identity = identities.get(params.payload);
  if (!identity) {
    identity = { publicationId: randomUUID(), publishedAtMs: Date.now() };
    identities.set(params.payload, identity);
  }
  const record = Object.freeze({
    version: 2 as const,
    ...identity,
    kind: params.kind,
    channel: params.channel,
    sessionKey: params.sessionKey,
    runId: params.runId,
    accountId: params.context?.accountId,
  });
  if (previous && requiredReceipts.has(previous)) requiredReceipts.add(record);
  records.set(event, record);
  records.set(params.payload, record);
  return record;
}
/** SDK read-only capability: exact host hook object only, never a token/id lookup. */
export function resolveReplyPublication(event: unknown): ReplyPublication | undefined {
  return event && typeof event === "object" ? records.get(event) : undefined;
}
/** Host isolation creates a fresh event for each plugin without losing custody. */
export function copyReplyPublication(source: object, target: object): void {
  const record = records.get(source);
  if (record) {
    records.set(target, record);
    identities.set(target, record);
  }
}
