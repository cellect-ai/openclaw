import type { DiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import type { PluginHookChannelContext } from "./hook-channel-context.types.js";
import type { MemoryAudience } from "./memory-provider-types.js";

export type PluginHookContextWindow = {
  /** Resolved effective context-token budget after model/config/agent caps. */
  contextTokenBudget?: number;
  /** Source that supplied the resolved context-token budget. */
  contextWindowSource?: "model" | "modelsConfig" | "agentContextTokens" | "default";
  /** Native/configured reference window when a lower cap wins. */
  contextWindowReferenceTokens?: number;
};

export type PluginHookToolAuthority = {
  /** Opaque host fingerprint for the exact turn, route, policy, and active tool surface. */
  readonly fingerprint: string;
  /** Checks whether the finalized turn surface contains this exact tool. */
  allows(toolName: string): boolean;
  /** Lists only the frozen canonical tool names checked by allows(); absent on older hosts. */
  list?(): readonly string[];
  /** Rejects retained or timed-out capabilities after the host dispatch closes. */
  assertActive(): void;
};

/** Original requester retained by the native owner of this exact resumed task. */
export type PluginHookRequesterContinuation = Readonly<{
  runId: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  sourceTurnId: string;
  /** Original native text event, retained only with the owning source task. */
  chatId?: string;
  eventId?: string;
  channel: string;
  senderId: string;
  accountId?: string;
  /** Checks current native task custody; identity fields alone grant nothing. */
  assertCurrent: () => void;
}>;

/**
 * Host-proven lineage of a spawned child run back to the admitted parent run that
 * launched it, projected only to that exact child run and session. It proves
 * lineage, never a person: the plugin that admitted the parent decides that.
 */
export type PluginHookSpawnedRequester = Readonly<{
  parentRunId: string;
  parentAgentId: string;
  parentSessionKey: string;
  parentSessionId?: string;
  childRunId: string;
  childAgentId: string;
  childSessionKey: string;
  childSessionId: string;
  /** "parent" when the child's result returns only to its parent, never to a channel. */
  completionTarget?: "parent";
  /** Epoch ms after which the lineage grants nothing. */
  expiresAt: number;
  /** Rejects revoked, expired or drifted lineage; identity fields alone grant nothing. */
  assertCurrent: () => void;
}>;

export type PluginHookAgentContext = PluginHookContextWindow & {
  runId?: string;
  jobId?: string;
  trace?: DiagnosticTraceContext;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  /** Host-resolved memory partition for this turn. */
  memoryAudience?: MemoryAudience;
  /** Rejects the audience after any captured session incarnation changes. */
  assertMemoryAudienceCurrent?: () => void;
  /** Whether this turn's tool/runtime surface is sandboxed. */
  sandboxed?: boolean;
  workspaceDir?: string;
  /** Run-prepared repository identities; empty when the turn is outside a repository. */
  activeProjectKeys?: string[];
  modelProviderId?: string;
  modelId?: string;
  messageProvider?: string;
  /** Channel/plugin id for channel-originated runs, e.g. `discord`. */
  channel?: string;
  /** Channel account used by the agent when multiple accounts are configured. */
  accountId?: string;
  /** Conversation target id for channel-originated runs. Mirrors `channelId` for compatibility. */
  chatId?: string;
  /** Sender identity for channel-originated runs when available. */
  senderId?: string;
  trigger?: string;
  /**
   * OpenClaw tool names the model could call this turn, after policy. Set on `agent_end`
   * by runtimes that know them; runtime-native tools (such as Codex shell) are not listed.
   */
  toolNames?: readonly string[];
  /**
   * The transcript entry that ended this turn, set on `agent_end` when the runtime recorded one.
   * Pass it as `through` to `api.runtime.subagent.runForkedTurn` to fork the finished turn.
   */
  completedTurn?: { sessionId: string; entryId: string };
  channelId?: string;
  /** Typed origin of the turn's user-role input when supplied by the producer. */
  inputProvenance?: InputProvenance;
  /** Host-owned capability; absent for unbound operator or inter-session input. */
  requesterContinuation?: PluginHookRequesterContinuation;
  /** Host-owned lineage of a spawned child run; absent for every other run. */
  spawnedFrom?: PluginHookSpawnedRequester;
  /** Channel a spawned child's parent run arrived on, with or without lineage; grants nothing. */
  spawnedFromChannel?: string;
  /**
   * Opaque Fi shadow-turn attestation of a `hook:fi-shadow:` cron run. Given
   * to before_agent_reply only; Fi, not the gateway, verifies it.
   */
  hookRequesterAttestation?: string;
  /** Host-owned source binding for a generic mail hook, including isolated cron projection. */
  hookSourceLockCapability?: string;
  hookMailWakeSessionKey?: string;
  hostMailWakeEnvironment?: "dev" | "staging" | "prod";
  /** The Fi environment the authenticated hook of this run named; host context only. */
  hostHookFiEnvironment?: "dev" | "staging" | "prod";
  /** @deprecated Use `channelContext.sender` for channel-specific identities. */
  senderExternalId?: string;
  /** Channel-owned sender/chat details. Plugins may augment the nested interfaces. */
  channelContext?: PluginHookChannelContext;
  /** Present only for post-policy prompt enrichment hooks that requested tool authority. */
  toolAuthority?: PluginHookToolAuthority;
  /** Checks this prompt hook handler's result-acceptance lifetime. */
  readonly hookInvocation?: Readonly<{ assertActive(): void }>;
};
