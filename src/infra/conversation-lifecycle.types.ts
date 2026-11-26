import type { ConversationLifecyclePublication } from "./conversation-lifecycle.reducer.js";
import type { ConversationProjectionBinding } from "./conversation-lifecycle.reducer.js";
export type LifecycleWriteTiming = {
  writerWaitMs: number;
  workerWriteMs: number;
  committedAt: number;
};
export type ConversationLifecycleTransportOptions = {
  transportId: string;
  resolveBindings: (
    owner: Readonly<{ sessionKey: string; sessionId: string; agentId: string }>,
  ) => readonly ConversationProjectionBinding[];
  publish: (
    binding: ConversationProjectionBinding,
    event: ConversationLifecyclePublication,
    transactionId: string,
  ) => Promise<void>;
  /** Slow successful publications only. Carries no message or event body. */
  onSlowPublish?: (
    detail: Readonly<{
      roomId: string;
      revision: number;
      ageAtSendMs?: number;
      writerWaitMs?: number;
      workerWriteMs?: number;
      committedToSendMs?: number;
      matrixAckMs: number;
    }>,
  ) => void;
  /** Recovery may seal native final membership; the session worker owns the actual fence. */
  onRetiredProducer?: (
    source: Readonly<{
      runId: string;
      generation: string;
      sessionId: string;
      binding: ConversationProjectionBinding;
    }>,
    assertRetired: () => void,
  ) => Promise<void>;
  /** `detail` names the affected room only; it never carries event content. */
  onError: (
    error: unknown,
    detail?: Readonly<{
      roomId: string;
      reason:
        | "delivery_failed"
        | "backlog_capped"
        | "room_parked"
        | "terminal_after_interrupted"
        | "status_abandoned"
        | "row_stuck";
      failures: number;
    }>,
  ) => void;
  /** True when the destination refused the transport outright and retrying cannot help. */
  isDestinationGone?: (error: unknown) => boolean;
  stateDir?: string;
  /**
   * Contract v2: the optional fields on each fact, and the heartbeat. Read when
   * a fact is sent, so switching it off stops the fields at once, backlog
   * included. Default: the environment switch
   * `OPENCLAW_CONVERSATION_LIFECYCLE_SIGNALS`, off unless set.
   */
  signals?: () => boolean;
  /**
   * Decision cards for approvals a person may decide, and `waitingOn` naming
   * them. A separate switch from `signals`; default
   * `OPENCLAW_CONVERSATION_DECISION_CARDS`, off unless set. Without
   * `publishDecision` no card is recorded or sent.
   */
  decisionCards?: () => boolean;
  /** Sends one `m.room.message` carrying a decision card, in the run's thread. */
  publishDecision?: (
    binding: ConversationProjectionBinding,
    content: Record<string, unknown>,
    transactionId: string,
  ) => Promise<void>;
};
