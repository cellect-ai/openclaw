import {
  lookupMailWakeSourceLock,
  lookupMailWakeSessionKey,
  lookupMailWakeEnvironment,
} from "../../../infra/mail-wake-source-lock.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../../plugins/hook-agent-context.js";
import type { PluginHookAgentContext } from "../../../plugins/hook-types.js";
import {
  assertMemoryAudienceCurrent,
  assertMemoryAudienceSession,
} from "../../../plugins/memory-audience.js";
import type { RunEmbeddedAgentInternalParams } from "./internal-params.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/** The pre-reply hook and later hooks share these exact native run facts. */
export function buildEmbeddedPreReplyHookContext(
  run: Pick<RunEmbeddedAgentInternalParams, "runId" | "jobId" | "sessionId" | "trigger"> &
    Parameters<typeof buildAgentHookContextChannelFields>[0] &
    Parameters<typeof buildAgentHookContextIdentityFields>[0],
  input: {
    sessionKey: string;
    agentId: string;
    workspaceDir: string;
    activeProjectKeys: ReadonlySet<string> | readonly string[];
    provider: string;
    modelId: string;
  },
) {
  return {
    runId: run.runId,
    jobId: run.jobId,
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    sessionId: run.sessionId,
    workspaceDir: input.workspaceDir,
    activeProjectKeys: [...input.activeProjectKeys],
    modelProviderId: input.provider,
    modelId: input.modelId,
    trigger: run.trigger,
    hookSourceLockCapability: lookupMailWakeSourceLock(run.runId, input.sessionKey),
    hookMailWakeSessionKey: lookupMailWakeSessionKey(run.runId, input.sessionKey),
    hostMailWakeEnvironment: lookupMailWakeEnvironment(run.runId, input.sessionKey),
    ...buildAgentHookContextChannelFields(run),
    ...buildAgentHookContextIdentityFields(run),
  };
}

type EmbeddedAgentHookRun = Pick<
  EmbeddedRunAttemptParams,
  "runId" | "sessionId" | "sessionKey" | "workspaceDir" | "trigger" | "memoryAudience" | "sandbox"
> &
  Parameters<typeof buildAgentHookContextChannelFields>[0] &
  Parameters<typeof buildAgentHookContextIdentityFields>[0];

export function buildEmbeddedAgentHookContext(
  run: EmbeddedAgentHookRun,
  agentId: string,
  trace: PluginHookAgentContext["trace"],
) {
  if (run.memoryAudience) {
    assertMemoryAudienceSession(run.memoryAudience, run.sessionKey);
  }
  return {
    runId: run.runId,
    trace,
    agentId,
    sessionKey: run.sessionKey,
    sessionId: run.sessionId,
    memoryAudience: run.memoryAudience,
    assertMemoryAudienceCurrent: run.memoryAudience
      ? () => assertMemoryAudienceCurrent(run.memoryAudience!)
      : undefined,
    sandboxed: run.sandbox?.enabled === true,
    workspaceDir: run.workspaceDir,
    trigger: run.trigger,
    ...buildAgentHookContextChannelFields(run),
    ...buildAgentHookContextIdentityFields(run),
  };
}
