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
  /** Process-local host-prepended text. Never inferred from payload JSON or persisted. */
  readonly synthesizedPrefix?: string;
  /** Withhold the host prefix even if a modifying hook fails or times out.
   * The returned release closes only this caller's hold, never another policy's. */
  readonly deferSynthesizedPrefix?: () => () => void;
}
const synthesizedPrefixes = new WeakMap<object, string>();
const withheldPrefixes = new WeakMap<object, string>();
const prefixHolds = new WeakMap<ReplyPublication, Set<object>>();
/** Core normalization records only a prefix it actually prepended. */
export function recordReplyPublicationPrefix(payload: object, prefix: string): void {
  synthesizedPrefixes.set(payload, prefix);
}
/** An already normalized payload must not regain a withheld prefix on another pass. */
export function isReplyPublicationPrefixWithheld(payload: object, prefix: string): boolean {
  return withheldPrefixes.get(payload) === prefix;
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
  if (!record) return undefined;
  const { synthesizedPrefix: _prefix, deferSynthesizedPrefix: _defer, ...stored } = record;
  return Object.freeze({
    ...stored,
    ...(requiredReceipts.has(record) ? { receiptRequired: true as const } : {}),
  });
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
  const prefix = synthesizedPrefixes.get(params.payload);
  const holds =
    (previous?.synthesizedPrefix === prefix && previous && prefixHolds.get(previous)) ||
    new Set<object>();
  let identity = identities.get(params.payload);
  if (!identity) {
    // Browser-safe: this module ships in browser bundles, so use the
    // WebCrypto global instead of node:crypto.
    identity = { publicationId: globalThis.crypto.randomUUID(), publishedAtMs: Date.now() };
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
    ...(prefix !== undefined
      ? {
          synthesizedPrefix: prefix,
          deferSynthesizedPrefix: () => {
            const hold = {};
            holds.add(hold);
            return () => {
              holds.delete(hold);
            };
          },
        }
      : {}),
  });
  prefixHolds.set(record, holds);
  if (previous && requiredReceipts.has(previous)) requiredReceipts.add(record);
  records.set(event, record);
  records.set(params.payload, record);
  return record;
}
/** Keep host-generated addressing outside arbitrary plugin text transforms. */
export function detachReplyPublicationPrefix(payload: ReplyPayload): ReplyPayload {
  const record = records.get(payload);
  const prefix = record?.synthesizedPrefix;
  if (
    !record ||
    !prefix ||
    isReplyPublicationPrefixWithheld(payload, prefix) ||
    !payload.text?.startsWith(`${prefix} `)
  )
    return payload;
  const result = { ...payload, text: payload.text.slice(prefix.length + 1) };
  copyReplyPublication(payload, result);
  return result;
}
/** Final host decision after hooks, including fail-open timeout/error paths. */
export function finishReplyPublicationPrefix(payload: ReplyPayload): ReplyPayload {
  const record = records.get(payload);
  const prefix = record?.synthesizedPrefix;
  if (!record || !prefix) return payload;
  if (prefixHolds.get(record)?.size) {
    withheldPrefixes.set(payload, prefix);
    return payload;
  }
  if (!payload.text) return payload;
  const result = { ...payload, text: `${prefix} ${payload.text}` };
  copyReplyPublication(payload, result);
  return result;
}
/** SDK read-only capability: exact host hook object only, never a token/id lookup. */
export function resolveReplyPublication(event: unknown): ReplyPublication | undefined {
  return event && typeof event === "object" ? records.get(event) : undefined;
}
/** Host isolation creates a fresh event for each plugin without losing custody. */
export function copyReplyPublication(source: object, target: object): void {
  const record = records.get(source);
  const prefix = synthesizedPrefixes.get(source) ?? record?.synthesizedPrefix;
  if (prefix !== undefined) synthesizedPrefixes.set(target, prefix);
  const withheld = withheldPrefixes.get(source);
  if (withheld !== undefined) withheldPrefixes.set(target, withheld);
  if (record) {
    records.set(target, record);
    identities.set(target, record);
  }
}
