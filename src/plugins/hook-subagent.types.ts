export type PluginHookSubagentContext = {
  runId?: string;
  childSessionKey?: string;
  requesterSessionKey?: string;
};

type PluginHookSubagentTargetKind = "subagent" | "acp";

type PluginHookSubagentRequester = {
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string | number;
  /** Native source channel/conversation id, when distinct from the routable target. */
  channelId?: string | number;
  /** Native source message that initiated the parent run, when available. */
  messageId?: string | number;
};

type PluginHookSubagentSpawnBase = {
  childSessionKey: string;
  agentId: string;
  label?: string;
  mode: "run" | "session";
  requester?: PluginHookSubagentRequester;
  threadRequested: boolean;
};

export type PluginHookSubagentDeliveryTargetEvent = {
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  childRunId?: string;
  spawnMode?: "run" | "session";
  expectsCompletionMessage: boolean;
};

/**
 * @deprecated Core route projection resolves subagent delivery targets from
 * `SessionBindingRecord` and channel `resolveDeliveryTarget`. This hook result
 * remains for plugin compatibility during the transition.
 */
export type PluginHookSubagentDeliveryTargetResult = {
  origin?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
};

export type PluginHookSubagentSpawnedEvent = PluginHookSubagentSpawnBase & {
  runId: string;
  /** Fully resolved provider/model ref applied to the spawned child session. */
  resolvedModel?: string;
  /** Provider prefix parsed from resolvedModel when the ref includes one. */
  resolvedProvider?: string;
};

/** Portable channel presentation signal for one background child run. */
export type PluginHookSubagentProgressEvent =
  | {
      phase: "started";
      runId: string;
      childSessionKey: string;
      requester?: PluginHookSubagentRequester;
    }
  | {
      phase: "ended";
      runId: string;
      childSessionKey: string;
      outcome: "ok" | "error" | "timeout" | "killed" | "unknown";
      requester?: PluginHookSubagentRequester;
    };

export type PluginHookSubagentEndedEvent = {
  targetSessionKey: string;
  targetKind: PluginHookSubagentTargetKind;
  reason: string;
  sendFarewell?: boolean;
  accountId?: string;
  runId?: string;
  endedAt?: number;
  outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
  error?: string;
};
