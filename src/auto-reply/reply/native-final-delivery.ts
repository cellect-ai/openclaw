import { randomUUID } from "node:crypto";
import type {
  NativeFinalDeliveryReference,
  CompletedFinalDelivery,
} from "../../config/sessions/pending-final-delivery-types.js";
import { applySessionEntryOperation } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { getAgentRunLifecycleGeneration } from "../../infra/agent-run-registry.js";
import type { OutboundDeliveryResult } from "../../infra/outbound/deliver-types.js";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import { captureDeliveryPublicationEvidence } from "../../infra/outbound/delivery-queue-publication-evidence.js";
import type { DeliveryPublicationEvidence } from "../../infra/outbound/delivery-queue-publication.types.js";
import { normalizeTargetForProvider } from "../../infra/outbound/target-normalization.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
  type ReplyPayloadMetadata,
} from "../reply-payload.js";
import type { AgentTurnCompletion } from "./agent-runner-completion.types.js";

type Plan = Omit<NativeFinalDeliveryReference, "deliveryId"> &
  Pick<
    NonNullable<ReplyPayloadMetadata["pendingFinalDeliveryCompletion"]>,
    "commandOwnerReference"
  >;
const plans = new WeakMap<ReplyOperation, Plan>();
const listeners = new Set<(reference: Plan) => Promise<void>>();
export async function admitNativeFinalDeliveryPlan(params: {
  completion: AgentTurnCompletion;
  operation: ReplyOperation;
  agentId?: string;
  storePath: string;
  sessionKey: string;
  runId: string;
  sourceMessageId?: string;
  payloads: readonly ReplyPayload[];
  context?: DeliveryContext;
  commandOwnerReference?: Plan["commandOwnerReference"];
}): Promise<void> {
  const reference: Plan = {
    agentId: params.agentId,
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    sessionId: params.operation.sessionId,
    intentId: randomUUID(),
    sourceRunId: params.runId,
    sourceGeneration: params.operation.lifecycleGeneration ?? getAgentRunLifecycleGeneration(),
    commandOwnerReference: params.commandOwnerReference,
  };
  const deliveries = params.payloads.map((payload) => {
    const deliveryId = randomUUID();
    setReplyPayloadMetadata(payload, {
      pendingFinalDeliveryCompletion: { ...reference, deliveryId },
      pendingFinalDeliveryCleanup: {},
    });
    return { id: deliveryId, state: "prepared" as const };
  });
  const entry = await params.completion.complete({
    kind: "transport-only",
    createdAt: Date.now(),
    intentId: reference.intentId,
    sourceRunId: reference.sourceRunId,
    sourceMessageId: params.sourceMessageId,
    sourceGeneration: reference.sourceGeneration,
    dispatchState: "open",
    deliveries,
    context: params.context,
  });
  if (
    entry.sessionId !== reference.sessionId ||
    entry.pendingFinalDelivery?.intentId !== reference.intentId
  )
    throw new Error("Native final intent admission changed");
  bindNativeFinalDeliveryPlan(params.operation, reference);
}
/** A correlation cache only. All mutations and reads check the persisted native intent. */
export function bindNativeFinalDeliveryPlan(operation: ReplyOperation, reference: Plan): void {
  plans.set(operation, Object.freeze({ ...reference }));
}
export function resolveNativeFinalDeliveryPlan(
  operation: ReplyOperation | undefined,
): Plan | undefined {
  return operation ? plans.get(operation) : undefined;
}
export function nativeFinalDeliveryReference(
  payload: ReplyPayload,
): NativeFinalDeliveryReference | undefined {
  const completion = getReplyPayloadMetadata(payload)?.pendingFinalDeliveryCompletion;
  if (!completion?.sourceRunId || !completion.sourceGeneration) return undefined;
  const {
    agentId,
    storePath,
    sessionKey,
    sessionId,
    intentId,
    deliveryId,
    sourceRunId,
    sourceGeneration,
  } = completion;
  return {
    agentId,
    storePath,
    sessionKey,
    sessionId,
    intentId,
    deliveryId,
    sourceRunId,
    sourceGeneration,
  };
}
export function registerNativeFinalDeliveryListener(
  listener: (reference: Plan) => Promise<void>,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** Wakeups are best effort. Native rows and the projection's durable references own restart. */
export async function notifyNativeFinalDeliveryChanged(reference: Plan): Promise<void> {
  await Promise.allSettled([...listeners].map((listener) => listener(reference)));
}
function scope(reference: Plan) {
  return {
    agentId: reference.agentId,
    storePath: reference.storePath,
    sessionKey: reference.sessionKey,
  };
}
export async function readNativeFinalDeliveryReceipt(
  reference: Plan,
  source?: { channel: string; to: string; accountId: string },
): Promise<CompletedFinalDelivery | undefined> {
  const entry = await readSessionEntryReadOnlyInWorker(scope(reference));
  if (entry?.sessionId !== reference.sessionId) return undefined;
  const receipt = entry.completedFinalDeliveries?.find(
    (receipt) =>
      receipt.sessionId === reference.sessionId &&
      receipt.intentId === reference.intentId &&
      receipt.sourceRunId === reference.sourceRunId &&
      receipt.sourceGeneration === reference.sourceGeneration,
  );
  if (
    receipt &&
    source &&
    (receipt.context?.channel !== source.channel ||
      !receipt.context.to ||
      normalizeTargetForProvider(source.channel, receipt.context.to) !==
        normalizeTargetForProvider(source.channel, source.to) ||
      (receipt.context.accountId ?? "default") !== source.accountId)
  )
    throw new Error("Native final receipt has different source placement");
  return receipt;
}
export async function retainNativeFinalDeliveryReceipt(
  reference: NativeFinalDeliveryReference,
  consumerId: string,
): Promise<void> {
  const entry = await applySessionEntryOperation(
    scope(reference),
    {
      kind: "pending-final-projection",
      ...reference,
      consumerId,
      retainDeliveryId: reference.deliveryId,
    },
    { skipMaintenance: true, preserveActivity: true },
  );
  const pending = entry?.pendingFinalDelivery;
  if (
    entry?.sessionId !== reference.sessionId ||
    pending?.intentId !== reference.intentId ||
    pending.sourceRunId !== reference.sourceRunId ||
    pending.sourceGeneration !== reference.sourceGeneration ||
    !pending.projectionConsumers?.includes(consumerId)
  ) {
    throw new Error("Native final projection has no current admitted intent");
  }
}
export async function releaseNativeFinalDeliveryReceipt(
  reference: Plan,
  consumerId: string,
): Promise<void> {
  await applySessionEntryOperation(
    scope(reference),
    {
      kind: "pending-final-projection",
      ...reference,
      consumerId,
      release: true,
    },
    { skipMaintenance: true, preserveActivity: true },
  );
}
export async function appendNativeFinalDelivery(
  reference: Plan | undefined,
  payload: ReplyPayload,
  assertCurrent: () => void,
): Promise<void> {
  if (!reference || nativeFinalDeliveryReference(payload)) return;
  assertCurrent();
  const deliveryId = randomUUID();
  const entry = await applySessionEntryOperation(
    scope(reference),
    {
      kind: "pending-final-dispatch",
      ...reference,
      appendDeliveryId: deliveryId,
      now: Date.now(),
    },
    { skipMaintenance: true, preserveActivity: true, workerGuard: { assertCurrent } },
  );
  assertCurrent();
  if (
    entry?.sessionId !== reference.sessionId ||
    entry.pendingFinalDelivery?.intentId !== reference.intentId ||
    !entry.pendingFinalDelivery.deliveries?.some(({ id }) => id === deliveryId)
  )
    throw new Error("Native final intent changed before append");
  setReplyPayloadMetadata(payload, {
    pendingFinalDeliveryCompletion: { ...reference, deliveryId },
    pendingFinalDeliveryCleanup: {},
  });
}
export async function closeNativeFinalDelivery(
  reference: Plan | undefined,
  options: { assertCurrent?: () => void; retiredConsumer?: string } = {},
): Promise<void> {
  if (!reference) return;
  options.assertCurrent?.();
  const entry = await applySessionEntryOperation(
    scope(reference),
    {
      kind: "pending-final-dispatch",
      ...reference,
      close: true,
      now: Date.now(),
      ...(options.retiredConsumer ? { retiredConsumer: options.retiredConsumer } : {}),
    },
    {
      skipMaintenance: true,
      preserveActivity: true,
      workerGuard: { assertCurrent: options.assertCurrent },
    },
  );
  if (
    entry?.pendingFinalDelivery?.projectionConsumers?.length ||
    entry?.completedFinalDeliveries?.some((receipt) => receipt.intentId === reference.intentId)
  ) {
    await notifyNativeFinalDeliveryChanged(reference);
  }
}
/** Native recovery seals admitted membership; it does not infer dispositions or resume execution. */
export async function retireNativeFinalDelivery(
  reference: Plan,
  consumerId: string,
  assertRetired: () => void,
): Promise<void> {
  const currentGeneration = getAgentRunLifecycleGeneration();
  const assertCurrent = () => {
    assertRetired();
    if (
      reference.sourceGeneration === currentGeneration ||
      getAgentRunLifecycleGeneration() !== currentGeneration
    ) {
      throw new Error("Native final producer retirement generation is not fenced");
    }
  };
  await closeNativeFinalDelivery(reference, { assertCurrent, retiredConsumer: consumerId });
}
/** Direct channel owner supplies every actual physical result for this logical member. */
export async function settleNativeFinalDeliveryPayload(
  payload: ReplyPayload,
  results: readonly OutboundDeliveryResult[],
  destination: DeliveryPublicationEvidence["destination"],
): Promise<string | undefined> {
  const finalPhysicalReceipt = captureDeliveryPublicationEvidence(results, destination);
  const completion = getReplyPayloadMetadata(payload)?.pendingFinalDeliveryCompletion;
  if (!completion || !results.length) return finalPhysicalReceipt?.platformMessageId;
  await settlePendingFinalDelivery(
    { kind: "pending-final", ...completion },
    "delivered",
    ["prepared", "queued", "unknown"],
    {
      identifiedResult: results.at(-1),
      finalPhysicalReceipt,
      batch: {
        results: [...results],
        payloadCount: 1,
        payloadOutcomes: [{ index: 0, status: "sent", results: [...results] }],
      },
      clearAfterSettled: true,
    },
  );
  return finalPhysicalReceipt?.platformMessageId;
}
