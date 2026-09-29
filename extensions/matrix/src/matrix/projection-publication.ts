import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { resolveReplyPublication } from "openclaw/plugin-sdk/reply-runtime";
import {
  resolveMatrixProjectionRun,
  noteMatrixProjectionFinalResult,
} from "./projection-lifecycle.js";

export const MATRIX_PROJECTION_CONTENT_KEY = "ai.cellect.projection";
export interface MatrixPublication {
  readonly version: 2;
  readonly environment: string;
  readonly conversationId: string;
  readonly roomId: string;
  readonly bindingId: string;
  readonly origin: {
    readonly provider: string;
    readonly accountId: string;
    readonly messageId: string;
    readonly actorId: string;
    readonly publishedAtMs: number;
    readonly displayName?: string;
  };
  readonly role: "user" | "assistant";
  readonly logicalPartId: string;
  readonly publicationRevision: number;
  readonly runId?: string;
  readonly generation?: string;
  readonly finalResult: boolean;
}
const publications = new WeakSet<object>();
function text(value: unknown, max = 256): value is string {
  return (
    typeof value === "string" &&
    !!value.trim() &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
function sealPublication(value: MatrixPublication): MatrixPublication {
  if (
    !text(value.environment, 64) ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(value.environment) ||
    !text(value.conversationId) ||
    !text(value.bindingId) ||
    !/^!\S{1,254}$/.test(value.roomId) ||
    !text(value.logicalPartId) ||
    !text(value.origin.provider) ||
    !text(value.origin.accountId) ||
    !text(value.origin.messageId) ||
    !text(value.origin.actorId) ||
    !Number.isSafeInteger(value.origin.publishedAtMs) ||
    value.origin.publishedAtMs < 0 ||
    !Number.isSafeInteger(value.publicationRevision) ||
    value.publicationRevision < 1 ||
    Boolean(value.runId) !== Boolean(value.generation)
  )
    throw new Error("invalid trusted Matrix publication");
  const frozen = Object.freeze({ ...value, origin: Object.freeze({ ...value.origin }) });
  publications.add(frozen);
  return frozen;
}
/** Frozen host hook/payload + admitted lifecycle binding, never model channelData. */
export function resolveMatrixReplyPublication(
  value: unknown,
  accountId?: string,
  roomId?: string,
  threadId?: string,
  providerPartIndex = 0,
  finalProviderPart = true,
): MatrixPublication | undefined {
  const host = resolveReplyPublication(value);
  if (!host?.runId || !host.sessionKey || !host.channel || !["block", "final"].includes(host.kind))
    return undefined;
  const owner = resolveMatrixProjectionRun(host.runId, host.sessionKey);
  if (!owner) return undefined;
  const candidates = owner.bindings.filter(
    (binding) =>
      (accountId === undefined || binding.accountId === accountId) &&
      (roomId === undefined || binding.roomId === roomId) &&
      (threadId === undefined || binding.threadRootEventId === threadId),
  );
  if (candidates.length !== 1) return undefined;
  const binding = candidates[0];
  if (!binding) return undefined;
  return sealPublication({
    version: 2,
    environment: binding.environment,
    conversationId: binding.conversationId,
    roomId: binding.roomId,
    bindingId: binding.bindingId,
    origin: {
      provider: host.channel,
      accountId: host.accountId || binding.accountId,
      messageId: host.publicationId,
      actorId: binding.agentId,
      publishedAtMs: host.publishedAtMs,
    },
    role: "assistant",
    logicalPartId: `${host.publicationId}:${providerPartIndex}`,
    publicationRevision: 1,
    runId: host.runId,
    generation: owner.generation,
    finalResult: host.kind === "final" && finalProviderPart,
  });
}
/**
 * `origin.accountId` of a room's source publications: the binding's source
 * account, else its external source workspace, else the Matrix account.
 */
export function sourcePublicationAccountId(
  metadata: Record<string, unknown> | undefined,
  fallback: string,
): string {
  const account = metadata?.sourceAccountId;
  const workspace = (metadata?.externalSource as { workspaceId?: unknown } | undefined)
    ?.workspaceId;
  return text(account) ? account : text(workspace) ? workspace : fallback;
}
/** Authorized source replay caller supplies persisted binding and immutable source facts. */
export function createMatrixSourcePublication(params: {
  bindingId: string;
  roomId: string;
  threadId: string;
  provider: string;
  accountId: string;
  messageId: string;
  actorId: string;
  publishedAtMs: number;
  displayName?: string;
  role: "user" | "assistant";
  publicationRevision?: number;
}): MatrixPublication | undefined {
  const binding = getSessionBindingService().resolveByConversation({
    channel: "matrix",
    accountId: params.accountId,
    conversationId: params.threadId,
    parentConversationId: params.roomId,
  });
  if (
    !binding ||
    binding.bindingId !== params.bindingId ||
    !text(binding.metadata?.environment) ||
    !text(binding.metadata?.projectedConversationId)
  )
    return undefined;
  const providerAccount = sourcePublicationAccountId(binding.metadata, params.accountId);
  return sealPublication({
    version: 2,
    environment: binding.metadata.environment,
    conversationId: binding.metadata.projectedConversationId,
    roomId: params.roomId,
    bindingId: binding.bindingId,
    origin: {
      provider: params.provider,
      accountId: providerAccount,
      messageId: params.messageId,
      actorId: params.actorId,
      publishedAtMs: params.publishedAtMs,
      ...(params.displayName ? { displayName: params.displayName.slice(0, 200) } : {}),
    },
    role: params.role,
    logicalPartId: params.messageId,
    publicationRevision: params.publicationRevision ?? 1,
    finalResult: false,
  });
}
export function matrixPublicationContent(
  publication: MatrixPublication,
  roomId: string,
  partIndex: number,
  partCount: number,
): Record<string, unknown> {
  if (
    !publications.has(publication) ||
    publication.roomId !== roomId ||
    !Number.isSafeInteger(partIndex) ||
    !Number.isSafeInteger(partCount) ||
    partCount < 1 ||
    partCount > 256 ||
    partIndex < 0 ||
    partIndex >= partCount
  )
    throw new Error("untrusted Matrix publication capability");
  const { finalResult: _final, ...wire } = publication;
  return { ...wire, partIndex, partCount, complete: partIndex === partCount - 1 };
}
export function noteMatrixPublicationAccepted(
  publication: MatrixPublication,
  roomId: string,
  eventId: string,
): void {
  if (
    !publications.has(publication) ||
    publication.roomId !== roomId ||
    !publication.finalResult ||
    !publication.runId ||
    !publication.generation ||
    !/^\$\S{1,254}$/.test(eventId)
  )
    return;
  noteMatrixProjectionFinalResult({
    runId: publication.runId,
    generation: publication.generation,
    bindingId: publication.bindingId,
    resultEventId: eventId,
  });
}
