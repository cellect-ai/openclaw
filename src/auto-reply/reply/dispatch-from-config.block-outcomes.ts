import { getReplyPayloadMetadata, type ReplyPayload } from "../reply-payload.js";
import { setBlockReplyDelivery } from "./block-reply-delivery.js";
import { createBlockReplyContentKey } from "./block-reply-pipeline.js";
import { runWithDispatchAbortSignal } from "./dispatch-from-config.abort.js";
import { shouldRetryReplyDispatch } from "./reply-dispatch-outcome.js";
import type { ReplyDispatchDeliveryOutcome } from "./reply-dispatcher.js";
export type BlockDelivery = { outcome: ReplyDispatchDeliveryOutcome; pending?: boolean };
export function createBlockFinalOutcomeTracker() {
  const blockDeliveryOutcomes = new Map<string, Array<Promise<BlockDelivery>>>();
  const recordBlockOutcome = (payload: ReplyPayload, outcome: Promise<BlockDelivery>) => {
    setBlockReplyDelivery(outcome, payload);
    if (getReplyPayloadMetadata(payload)?.independentDeliveryIntentId !== undefined) {
      return;
    }
    const key = createBlockReplyContentKey(payload);
    const outcomes = blockDeliveryOutcomes.get(key) ?? [];
    outcomes.push(outcome);
    blockDeliveryOutcomes.set(key, outcomes);
  };
  const getBlockReplyOutcome = async (
    payload: ReplyPayload,
    abortSignal?: AbortSignal,
  ): Promise<BlockDelivery | undefined> => {
    const outcomes = blockDeliveryOutcomes.get(createBlockReplyContentKey(payload));
    if (!outcomes || abortSignal?.aborted) {
      return undefined;
    }
    const settled = await runWithDispatchAbortSignal(abortSignal, () => Promise.all(outcomes));
    return (
      settled.find(({ outcome }) => outcome === "delivered") ??
      settled.find(({ outcome, pending }) => pending || !shouldRetryReplyDispatch(outcome)) ??
      settled[0]
    );
  };

  return { recordBlockOutcome, getBlockReplyOutcome };
}
