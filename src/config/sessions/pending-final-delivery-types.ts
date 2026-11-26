import type { DeliveryContext } from "../../utils/delivery-context.types.js";

export type PendingFinalDeliveryState = {
  createdAt: number;
  context?: DeliveryContext;
  intentId?: string;
  /** Original admitted source; survives claim cleanup before the queued final settles. */
  sourceRunId?: string;
  /** Provider message that triggered this final, when owned by the same route. */
  sourceMessageId?: string;
  /** Native dispatch may append synthetic finals until it closes this intent. */
  dispatchState?: "open" | "closed";
  dispatchClosure?: "completed" | "retired";
  sourceGeneration?: string;
  /** Exact projection consumers that requested retention before a member was sent. */
  projectionConsumers?: string[];
  deliveries?: Array<{
    id: string;
    state: "prepared" | "queued" | "delivered" | "suppressed" | "unknown";
    /** Same-route identified evidence for the complete logical member, not just its last send. */
    receipt?: { platformMessageId: string; resultCount: number; finalPlatformMessageId?: string };
  }>;
} & ({ kind: "replayable"; text: string } | { kind: "transport-only" });

/** Descriptive native completion, retained after transport custody is cleared. */
export type CompletedFinalDelivery = {
  sessionId: string;
  intentId: string;
  sourceRunId: string;
  sourceGeneration: string;
  completedAt: number;
  closure: "completed" | "retired";
  context?: DeliveryContext;
  deliveries: NonNullable<PendingFinalDeliveryState["deliveries"]>;
  projectionConsumers: string[];
};

/** Exact host correlation; never a session writer or delivery permission. */
export type NativeFinalDeliveryReference = {
  agentId?: string;
  storePath: string;
  sessionKey: string;
  sessionId: string;
  intentId: string;
  deliveryId: string;
  sourceRunId: string;
  sourceGeneration: string;
  sourceMessageId?: string;
};

/**
 * Owed user-visible notice that a final's delivery outcome stayed unknown.
 * Settled unknown custody records the debt here; the next same-route turn
 * sends it once, so an ambiguous loss never ends silently.
 */
export type PendingDeliveryNoticeState = {
  createdAt: number;
  context: DeliveryContext;
  intentId: string;
  sourceMessageId?: string;
  /** Specific logical reply member whose delivery is still unconfirmed. */
  deliveryId?: string;
  state: "owed" | "unresolved" | "acknowledged";
};
