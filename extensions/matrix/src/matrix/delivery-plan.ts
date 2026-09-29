// Matrix-owned event plans reconcile ambiguous sends through native transaction idempotency.
import { createHash } from "node:crypto";
import type {
  ChannelMessageUnknownSendContext,
  ChannelMessageUnknownSendReconciliationResult,
  MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { getMatrixRuntime } from "../runtime.js";
import { noteMatrixProjectionFinalResult } from "./projection-lifecycle.js";
import { resolveMatrixReplyToEventId, resolveMatrixThreadRootId } from "./relations.js";
import type { MatrixClient } from "./sdk.js";
import type { MatrixMessageWireDispatch } from "./sdk/message-wire-dispatch.js";
import { withResolvedMatrixSendClient } from "./send/client.js";
import { createMatrixSendReceipt, type MatrixReceiptEvent } from "./send/receipt.js";
import { resolveMatrixRoomId } from "./send/targets.js";
import type { MatrixOutboundContent } from "./send/types.js";

const DELIVERY_PLAN_VERSION = 1;
const DELIVERY_PLAN_NAMESPACE = "outbound-delivery-plans";
// Recovery exhausts its normal retry schedule within minutes. Keep a one-day
// interruption cushion without retaining terminal message content for a year.
const DELIVERY_PLAN_TTL_MS = 24 * 60 * 60 * 1000;

class MatrixDeliveryPlanInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatrixDeliveryPlanInvariantError";
  }
}

export type MatrixPreparedEvent = {
  transactionId: string;
  receiptKind: MessageReceiptPartKind;
  content: MatrixOutboundContent;
  projectionFinalResult?: { runId: string; generation: string; bindingId: string };
};

type MatrixDeliveryIdentity = {
  queueId: string;
  partIndex: number;
  partCount: number;
};

type MatrixDeliveryPlan = {
  version: typeof DELIVERY_PLAN_VERSION;
  queueId: string;
  accountId: string;
  roomId: string;
  wireEventType: "m.room.message" | "m.room.encrypted";
  endpointPrefix: string;
  transactionScopeId: string;
  partIndex: number;
  partCount: number;
  events: MatrixPreparedEvent[];
};

function createDeliveryPlanStore() {
  return getMatrixRuntime().state.openBlobStore<Record<string, never>>({
    namespace: DELIVERY_PLAN_NAMESPACE,
    maxEntries: 10_000,
    maxBytesPerEntry: 8 * 1024 * 1024,
    maxBytesPerNamespace: 256 * 1024 * 1024,
    overflowPolicy: "reject-new",
    defaultTtlMs: DELIVERY_PLAN_TTL_MS,
  });
}

function requireIndex(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Matrix durable delivery ${label} must be a non-negative integer`);
  }
  return value;
}

function requirePartCount(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) < 1) {
    throw new Error("Matrix durable delivery part count must be a positive integer");
  }
  return value!;
}

function queuePrefix(queueId: string): string {
  const normalized = queueId.trim();
  if (!normalized) {
    throw new Error("Matrix durable delivery requires a queue id");
  }
  return `${createHash("sha256").update(normalized).digest("hex")}.`;
}

function planKey(identity: MatrixDeliveryIdentity): string {
  return `${queuePrefix(identity.queueId)}${requireIndex(identity.partIndex, "part index")}`;
}

function transactionId(identity: MatrixDeliveryIdentity, eventIndex: number): string {
  const digest = createHash("sha256")
    .update(identity.queueId)
    .update("\0")
    .update(String(requireIndex(identity.partIndex, "part index")))
    .update("\0")
    .update(String(requireIndex(eventIndex, "event index")))
    .digest("base64url");
  return `oc_${digest}`;
}

const RECEIPT_KINDS = new Set<MessageReceiptPartKind>([
  "text",
  "media",
  "voice",
  "poll",
  "card",
  "preview",
  "unknown",
]);

function isPlan(value: unknown): value is MatrixDeliveryPlan {
  if (!value || typeof value !== "object") {
    return false;
  }
  const plan = value as Partial<MatrixDeliveryPlan>;
  return (
    plan.version === DELIVERY_PLAN_VERSION &&
    typeof plan.queueId === "string" &&
    Boolean(plan.queueId.trim()) &&
    typeof plan.accountId === "string" &&
    typeof plan.roomId === "string" &&
    Boolean(plan.roomId.trim()) &&
    (plan.wireEventType === "m.room.message" || plan.wireEventType === "m.room.encrypted") &&
    typeof plan.endpointPrefix === "string" &&
    Boolean(plan.endpointPrefix.trim()) &&
    typeof plan.transactionScopeId === "string" &&
    Boolean(plan.transactionScopeId.trim()) &&
    Number.isSafeInteger(plan.partIndex) &&
    (plan.partIndex ?? -1) >= 0 &&
    Number.isSafeInteger(plan.partCount) &&
    (plan.partCount ?? 0) > 0 &&
    (plan.partIndex ?? -1) < (plan.partCount ?? 0) &&
    Array.isArray(plan.events) &&
    plan.events.length > 0 &&
    plan.events.every(
      (event) =>
        event &&
        typeof event === "object" &&
        typeof event.transactionId === "string" &&
        Boolean(event.transactionId.trim()) &&
        RECEIPT_KINDS.has(event.receiptKind) &&
        Boolean(event.content) &&
        typeof event.content === "object",
    )
  );
}

function decodePlan(bytes: Uint8Array): MatrixDeliveryPlan {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new MatrixDeliveryPlanInvariantError("Matrix durable delivery plan is invalid JSON");
  }
  if (!isPlan(value)) {
    throw new MatrixDeliveryPlanInvariantError("Matrix durable delivery plan is invalid");
  }
  return value;
}

function assertPlanIdentity(
  plan: MatrixDeliveryPlan,
  params: {
    identity: MatrixDeliveryIdentity;
    accountId?: string | null;
    roomId: string;
    transactionScopeId: string;
    wireEventType: "m.room.message" | "m.room.encrypted";
  },
): void {
  if (
    plan.queueId !== params.identity.queueId ||
    plan.partIndex !== params.identity.partIndex ||
    plan.partCount !== params.identity.partCount ||
    plan.accountId !== (params.accountId ?? "") ||
    plan.roomId !== params.roomId ||
    plan.transactionScopeId !== params.transactionScopeId ||
    plan.wireEventType !== params.wireEventType
  ) {
    throw new MatrixDeliveryPlanInvariantError(
      "Matrix durable delivery plan no longer matches the active delivery target",
    );
  }
}

function endpointPrefix(dispatch: MatrixMessageWireDispatch): string {
  const encodedTransactionId = encodeURIComponent(dispatch.transactionId);
  if (!dispatch.requestPath.endsWith(encodedTransactionId)) {
    throw new MatrixDeliveryPlanInvariantError(
      "Matrix durable delivery transaction does not match its request path",
    );
  }
  return dispatch.requestPath.slice(0, -encodedTransactionId.length);
}

export function createMatrixPlannedEvents(params: {
  identity: MatrixDeliveryIdentity;
  events: readonly Omit<MatrixPreparedEvent, "transactionId">[];
}): MatrixPreparedEvent[] {
  return params.events.map((event, index) => ({
    ...structuredClone(event),
    transactionId: transactionId(params.identity, index),
  }));
}

export function resolveMatrixDurableDeliveryIdentity(params: {
  queueId?: string;
  partIndex?: number;
  partCount?: number;
}): MatrixDeliveryIdentity | null {
  if (params.queueId === undefined) {
    return null;
  }
  if (params.partIndex === undefined || params.partCount === undefined) {
    throw new Error("Matrix durable delivery requires stable part topology");
  }
  const partIndex = requireIndex(params.partIndex, "part index");
  const partCount = requirePartCount(params.partCount);
  if (partIndex >= partCount) {
    throw new Error("Matrix durable delivery part index must be below the part count");
  }
  return {
    queueId: params.queueId,
    partIndex,
    partCount,
  };
}

export async function loadMatrixDeliveryPlan(params: {
  identity: MatrixDeliveryIdentity;
  accountId?: string | null;
  roomId: string;
  transactionScopeId: string;
  wireEventType: "m.room.message" | "m.room.encrypted";
}): Promise<MatrixDeliveryPlan | null> {
  const entry = await createDeliveryPlanStore().lookup(planKey(params.identity));
  if (!entry) {
    return null;
  }
  const plan = decodePlan(entry.bytes);
  if (planKey(plan) !== planKey(params.identity)) {
    throw new MatrixDeliveryPlanInvariantError("Matrix durable delivery plan key is invalid");
  }
  assertPlanIdentity(plan, params);
  return structuredClone(plan);
}

export async function persistMatrixDeliveryPlan(params: {
  identity: MatrixDeliveryIdentity;
  accountId?: string | null;
  roomId: string;
  transactionScopeId: string;
  wireEventType: "m.room.message" | "m.room.encrypted";
  events: readonly MatrixPreparedEvent[];
  dispatch: MatrixMessageWireDispatch;
}): Promise<MatrixDeliveryPlan> {
  if (params.events.length === 0) {
    throw new Error("Matrix durable delivery plan must contain at least one event");
  }
  if (
    params.dispatch.roomId !== params.roomId ||
    params.dispatch.eventType !== params.wireEventType ||
    !params.events.some((event) => event.transactionId === params.dispatch.transactionId)
  ) {
    throw new MatrixDeliveryPlanInvariantError(
      "Matrix durable delivery was dispatched to an unexpected endpoint",
    );
  }
  const partCount = requirePartCount(params.identity.partCount);
  const events = params.events.map((event, index) => {
    if (event.transactionId !== transactionId(params.identity, index)) {
      throw new MatrixDeliveryPlanInvariantError(
        "Matrix durable delivery plan has an invalid transaction identifier",
      );
    }
    return structuredClone(event);
  });
  const plan: MatrixDeliveryPlan = {
    version: DELIVERY_PLAN_VERSION,
    queueId: params.identity.queueId,
    accountId: params.accountId ?? "",
    roomId: params.roomId,
    wireEventType: params.wireEventType,
    // Matrix idempotency includes the HTTP endpoint. Persist the SDK-selected
    // prefix so an API-route change fails before replay reaches the homeserver.
    endpointPrefix: endpointPrefix(params.dispatch),
    transactionScopeId: params.transactionScopeId,
    partIndex: requireIndex(params.identity.partIndex, "part index"),
    partCount,
    events,
  };
  const store = createDeliveryPlanStore();
  await store.deleteExpired();
  const bytes = new TextEncoder().encode(JSON.stringify(plan));
  if (await store.registerIfAbsent(planKey(params.identity), bytes, {})) {
    return plan;
  }
  const existing = await loadMatrixDeliveryPlan(params);
  if (!existing || JSON.stringify(existing) !== JSON.stringify(plan)) {
    throw new MatrixDeliveryPlanInvariantError(
      "Matrix durable delivery plan no longer matches the prepared event batch",
    );
  }
  return existing;
}

async function loadQueuePlans(queueId: string): Promise<MatrixDeliveryPlan[]> {
  const store = createDeliveryPlanStore();
  const entries = await store.entries();
  const prefix = entries.length > 0 ? queuePrefix(queueId) : "";
  const keys = entries.filter((entry) => entry.key.startsWith(prefix)).map((entry) => entry.key);
  const plans: MatrixDeliveryPlan[] = [];
  for (const key of keys) {
    const entry = await store.lookup(key);
    if (!entry) {
      throw new MatrixDeliveryPlanInvariantError(
        "Matrix durable delivery plan disappeared during reconciliation",
      );
    }
    const plan = decodePlan(entry.bytes);
    if (key !== planKey(plan)) {
      throw new MatrixDeliveryPlanInvariantError("Matrix durable delivery plan key is invalid");
    }
    plans.push(plan);
  }
  return plans;
}

function assertCompletePartTopology(plans: readonly MatrixDeliveryPlan[]): void {
  const partCount = plans[0]?.partCount;
  if (!partCount) {
    throw new MatrixDeliveryPlanInvariantError("Matrix ambiguous delivery has no event plan");
  }
  if (plans.some((plan) => plan.partCount !== partCount)) {
    throw new MatrixDeliveryPlanInvariantError(
      "Matrix durable delivery plan part topology is inconsistent",
    );
  }
  const storedParts = new Set(plans.map((plan) => plan.partIndex));
  if (
    storedParts.size !== partCount ||
    Array.from({ length: partCount }, (_, partIndex) => partIndex).some(
      (partIndex) => !storedParts.has(partIndex),
    )
  ) {
    throw new MatrixDeliveryPlanInvariantError(
      "Matrix ambiguous delivery has an incomplete event plan",
    );
  }
}

async function requireTransactionScope(client: MatrixClient): Promise<string> {
  const scope = (await client.getTransactionScopeId()).trim();
  if (!scope) {
    throw new MatrixDeliveryPlanInvariantError(
      "Matrix durable delivery requires a stable transaction scope",
    );
  }
  return scope;
}

/** Private operator repair replays only an exact frozen, registered publication. */
export async function replayMatrixProjectionPublication(
  cfg: import("../types.js").CoreConfig,
  request: Record<string, unknown>,
) {
  const { getMatrixProjectionStatus } = await import("./projection-source.js");
  const roomId = typeof request.roomId === "string" ? request.roomId : "",
    accountId = typeof request.accountId === "string" ? request.accountId : "";
  const owner = getMatrixProjectionStatus(roomId, accountId);
  if (
    owner.status !== "existing" ||
    owner.environment !== request.environment ||
    owner.conversationId !== request.conversationId ||
    owner.bindingId !== request.bindingId
  )
    throw new MatrixDeliveryPlanInvariantError("unregistered publication replay target");
  const publication = request.publication as Record<string, unknown> | undefined;
  const origin = publication?.origin as Record<string, unknown> | undefined;
  if (
    !publication ||
    !origin ||
    typeof request.publicationKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(request.publicationKey) ||
    !Number.isSafeInteger(request.expectedParts) ||
    (request.expectedParts as number) < 1 ||
    (request.expectedParts as number) > 256
  )
    throw new MatrixDeliveryPlanInvariantError("invalid replay descriptor");
  const plans: MatrixDeliveryPlan[] = [];
  for (const info of await createDeliveryPlanStore().entries()) {
    const entry = await createDeliveryPlanStore().lookup(info.key);
    if (!entry) continue;
    const plan = decodePlan(entry.bytes);
    if (plan.roomId !== roomId || plan.accountId !== accountId) continue;
    const match =
      plan.events.length === request.expectedParts &&
      plan.events.every((event, index) => {
        const wire = event.content["ai.cellect.projection"] as Record<string, unknown> | undefined;
        if (
          !wire ||
          wire.environment !== request.environment ||
          wire.bindingId !== request.bindingId ||
          wire.conversationId !== request.conversationId
        )
          return false;
        const source = wire.origin as Record<string, unknown> | undefined;
        return (
          !!source &&
          ["provider", "accountId", "messageId", "actorId", "publishedAtMs"].every(
            (key) => source[key] === origin[key],
          ) &&
          ["logicalPartId", "publicationRevision", "runId", "generation"].every(
            (key) => wire[key] === publication[key],
          ) &&
          wire.partCount === request.expectedParts &&
          wire.partIndex === index &&
          wire.complete === (index === plan.events.length - 1)
        );
      });
    if (match) plans.push(plan);
  }
  if (plans.length !== 1)
    throw new MatrixDeliveryPlanInvariantError("missing or ambiguous frozen publication plan");
  const plan = plans[0];
  if (!plan) throw new MatrixDeliveryPlanInvariantError("missing frozen publication plan");
  return withResolvedMatrixSendClient({ cfg, accountId }, async (client) => {
    const sender = await client.getUserId();
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          sender,
          origin.provider,
          origin.accountId,
          origin.messageId,
          publication.logicalPartId,
          publication.publicationRevision,
        ]),
      )
      .digest("hex");
    if (key !== request.publicationKey)
      throw new MatrixDeliveryPlanInvariantError("publication replay key mismatch");
    const transactionScopeId = await requireTransactionScope(client),
      wireEventType = await client.getMessageWireEventType(roomId);
    assertPlanIdentity(plan, {
      identity: plan,
      accountId,
      roomId,
      transactionScopeId,
      wireEventType,
    });
    const accepted: string[] = [];
    for (const event of plan.events)
      accepted.push(
        await client.sendMessage(roomId, event.content, event.transactionId, async (dispatch) => {
          await persistMatrixDeliveryPlan({
            identity: plan,
            accountId,
            roomId,
            transactionScopeId,
            wireEventType,
            events: plan.events,
            dispatch,
          });
        }),
      );
    const final = plan.events.at(-1)?.projectionFinalResult;
    if (final && accepted.at(-1))
      noteMatrixProjectionFinalResult({
        ...final,
        resultEventId: accepted.at(-1)!,
      });
    return { accepted: true, eventIds: accepted };
  });
}

export async function reconcileMatrixUnknownSend(
  ctx: ChannelMessageUnknownSendContext,
): Promise<ChannelMessageUnknownSendReconciliationResult> {
  try {
    if (ctx.payloads.length !== 1) {
      throw new MatrixDeliveryPlanInvariantError(
        "Matrix reconciliation requires exactly one prepared payload",
      );
    }
    const plans = await loadQueuePlans(ctx.queueId);
    if (plans.length === 0) {
      throw new MatrixDeliveryPlanInvariantError(
        "Matrix ambiguous delivery has no persisted event plan",
      );
    }
    assertCompletePartTopology(plans);
    return await withResolvedMatrixSendClient(
      { cfg: ctx.cfg, accountId: ctx.accountId },
      async (client) => {
        const transactionScopeId = await requireTransactionScope(client);
        const roomId = await resolveMatrixRoomId(client, ctx.to);
        const wireEventType = await client.getMessageWireEventType(roomId);
        const orderedPlans = [...plans].toSorted((left, right) => left.partIndex - right.partIndex);
        const results = new Map<string, MatrixReceiptEvent>();
        for (const plan of orderedPlans) {
          assertPlanIdentity(plan, {
            identity: plan,
            accountId: ctx.accountId,
            roomId,
            transactionScopeId,
            wireEventType,
          });
          for (const event of plan.events) {
            const messageId = await client.sendMessage(
              roomId,
              event.content,
              event.transactionId,
              async (dispatch) => {
                await persistMatrixDeliveryPlan({
                  identity: plan,
                  accountId: ctx.accountId,
                  roomId,
                  transactionScopeId,
                  wireEventType,
                  events: plan.events,
                  dispatch,
                });
              },
            );
            if (!results.has(messageId)) {
              const replyToId = resolveMatrixReplyToEventId(event.content);
              results.set(messageId, {
                messageId,
                kind: event.receiptKind,
                ...(replyToId ? { replyToId } : {}),
              });
            }
          }
        }
        const receipt = createMatrixSendReceipt({
          roomId,
          events: [...results.values()],
          threadId: resolveMatrixThreadRootId(orderedPlans[0]!.events[0]!.content),
        });
        const final = orderedPlans.at(-1)?.events.at(-1)?.projectionFinalResult;
        if (final && receipt.platformMessageIds.at(-1))
          noteMatrixProjectionFinalResult({
            ...final,
            resultEventId: receipt.platformMessageIds.at(-1)!,
          });
        return {
          status: "sent",
          messageId: receipt.platformMessageIds.at(-1),
          receipt,
        };
      },
    );
  } catch (error) {
    const retryable = !(error instanceof MatrixDeliveryPlanInvariantError);
    let cleanupError: unknown;
    if (!retryable) {
      // Core terminally retires non-retryable reconciliation. Remove the plan
      // here so a fail-closed Matrix verdict cannot retain payload content.
      try {
        await cleanupMatrixDeliveryPlans({ queueId: ctx.queueId });
      } catch (cleanupFailure) {
        cleanupError = cleanupFailure;
      }
    }
    const errorMessage = formatErrorMessage(
      error instanceof Error || typeof error === "string" ? error : "unknown error",
    );
    return {
      status: "unresolved",
      error:
        cleanupError === undefined
          ? errorMessage
          : `${errorMessage}; Matrix delivery-plan cleanup failed: ${formatErrorMessage(
              cleanupError instanceof Error || typeof cleanupError === "string"
                ? cleanupError
                : "unknown error",
            )}`,
      retryable,
    };
  }
}

export async function cleanupMatrixDeliveryPlans(ctx: { queueId: string }): Promise<void> {
  const store = createDeliveryPlanStore();
  await store.deleteExpired();
  const entries = await store.entries();
  const prefix = entries.length > 0 ? queuePrefix(ctx.queueId) : "";
  const keys = entries.filter((entry) => entry.key.startsWith(prefix)).map((entry) => entry.key);
  for (const key of keys) {
    await store.delete(key);
  }
}
