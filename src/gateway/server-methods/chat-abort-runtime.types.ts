import type { ErrorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { VerifiedRunStopActor } from "../../infra/run-stop-actor.js";
import type { ChatAbortControllerEntry, ChatAbortOps } from "../chat-abort.js";
import type { ChatAbortRequester } from "./chat-abort-authorization.js";
import type { abortControlledSubagents } from "./chat-abort-runtime.js";
import type { ChatAbortOrigin, ChatAbortSessionSnapshot } from "./chat-aborted-partial.js";
import type { GatewayRequestContext } from "./types.js";

export type ChatSessionAbortParams = {
  context: GatewayRequestContext;
  ops: ChatAbortOps;
  sessionKey: string;
  sessionKeyAliases?: string[];
  agentId?: string;
  sessionId?: string;
  /** Supplied only by narrow admission, from its original materialized target. */
  requiredSessionId?: string;
  session?: ChatAbortSessionSnapshot;
  defaultAgentId?: string;
  abortOrigin: ChatAbortOrigin;
  stopReason?: string;
  stopActor?: VerifiedRunStopActor;
  requester: ChatAbortRequester;
  assertCurrent?: () => void;
  preserveSideRuns?: boolean;
  /** Native execution Stop does not withdraw separately owned pending input. */
  preservePendingInputs?: true;
  cascadeDescendants?: true;
  /** Exact lifecycle owners may include hidden and side runs for this one session. */
  includeProtectedRuns?: boolean;
  /** Captures exact registrations before cancellation can remove them. */
  onControllerTargets?: (
    targets: Array<{ runId: string; entry: ChatAbortControllerEntry }>,
  ) => void;
  /** Internal session-wide cleanup after exact resolution and all matching owner checks. */
  onAuthorizedAfterQueuedAbort?: () => boolean;
  /** Runs after authorized synchronous abort, before terminal/partial persistence can yield. */
  onCancellationStarted?: () => void;
};

export type ChatSessionAbortResult = {
  aborted: boolean;
  runIds: string[];
  unauthorized: boolean;
  error?: ErrorShape;
  warning?: string;
  descendants?: Awaited<ReturnType<typeof abortControlledSubagents>>;
};
