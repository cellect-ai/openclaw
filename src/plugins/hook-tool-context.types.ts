import type { DiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import type {
  PluginHookRequesterContinuation,
  PluginHookSpawnedRequester,
} from "./hook-agent-context.types.js";
import type { PluginJsonValue } from "./host-hook-json.js";

export type PluginHookToolKind = "code_mode_exec";
export type PluginHookToolInputKind = "javascript" | "typescript";

/** Host-derived identity for the message requester that initiated a tool call. */
export type PluginHookToolRequesterContext = {
  /** Channel/plugin id, for example `discord` or `telegram`. */
  readonly channel?: string;
  /** Channel account used by the agent when multiple accounts are configured. */
  readonly accountId?: string;
  /** Channel-scoped sender id when the host received one. */
  readonly senderId?: string;
  /** True only when the host resolved the sender as an owner. */
  readonly senderIsOwner?: boolean;
  /** Provider-native role ids when the channel supplies them. */
  readonly roleIds?: readonly string[];
};

export type PluginHookToolContext = {
  /** Host-bound source receipt; never copied from model/tool arguments. */
  hookSourceLockCapability?: string;
  /** Original authenticated mail source target when execution is projected to cron. */
  hookMailWakeSessionKey?: string;
  hostMailWakeEnvironment?: "dev" | "staging" | "prod";
  /** Fi environment named by the authenticated hook; host context only. */
  hostHookFiEnvironment?: "dev" | "staging" | "prod";
  /** Live requester custody of a supported native task continuation. */
  requesterContinuation?: PluginHookRequesterContinuation;
  /** Host-owned lineage of a spawned child run. */
  spawnedFrom?: PluginHookSpawnedRequester;
  /** Parent channel metadata; grants no authority. */
  spawnedFromChannel?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  /** Aborts when the owning tool call is cancelled. Hook timeout expiry does not abort this signal. */
  abortSignal?: AbortSignal;
  trace?: DiagnosticTraceContext;
  toolName: string;
  /** Host-authoritative discriminator for tools that intentionally share names. */
  toolKind?: PluginHookToolKind;
  /** Host-authoritative input/runtime family for tools whose payloads need policy distinction. */
  toolInputKind?: PluginHookToolInputKind;
  toolCallId?: string;
  getSessionExtension?: (namespace: string) => PluginJsonValue | undefined;
  channelId?: string;
  /**
   * Message requester for this turn. Absent for non-message runs and harnesses
   * that cannot prove requester identity. Authorization hooks should fail
   * closed when a required field is absent.
   */
  requester?: PluginHookToolRequesterContext;
  /** Run origin (for example "user", "cron", or "memory"); metadata, not authorization. */
  trigger?: string;
};
