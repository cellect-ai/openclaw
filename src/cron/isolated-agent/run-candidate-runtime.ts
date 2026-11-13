import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import {
  isRestrictedBackgroundHookRun,
  SHADOW_CLI_REFUSAL,
} from "../../agents/shadow-hook-tool-policy.js";
import { isCliProvider } from "./run-execution.runtime.js";
import type { CronRunExecutionParams } from "./run-execution.types.js";
import { resolveEffectiveAgentRuntime } from "./run.runtime.js";

export { SHADOW_CLI_REFUSAL };

/** Fails a shadow run that would execute on a CLI backend; never falls back. */
export function assertShadowRunNotCli(
  sessionKeys: Array<string | undefined | null>,
  cliExecution: boolean,
): void {
  if (cliExecution && isRestrictedBackgroundHookRun(...sessionKeys)) {
    throw new Error(SHADOW_CLI_REFUSAL);
  }
}

/** Shares candidate execution policy between harness preparation and dispatch. */
export function createCronCandidateExecutionResolver(
  params: Pick<
    CronRunExecutionParams,
    "cfgWithAgentDefaults" | "agentId" | "runSessionKey" | "cronSession"
  > &
    Partial<Pick<CronRunExecutionParams, "agentSessionKey">>,
) {
  return (provider: string, model: string, sessionRuntimeOverride: string | undefined) => {
    const executionProvider = sessionRuntimeOverride
      ? isCliProvider(sessionRuntimeOverride, params.cfgWithAgentDefaults)
        ? sessionRuntimeOverride
        : provider
      : (resolveCliRuntimeExecutionProvider({
          provider,
          cfg: params.cfgWithAgentDefaults,
          agentId: params.agentId,
          modelId: model,
        }) ?? provider);
    const runtime =
      sessionRuntimeOverride ??
      resolveEffectiveAgentRuntime({
        cfg: params.cfgWithAgentDefaults,
        provider,
        modelId: model,
        agentId: params.agentId,
        sessionKey: params.runSessionKey,
        sessionEntry: params.cronSession.sessionEntry,
      });
    const cliExecution =
      isCliProvider(executionProvider, params.cfgWithAgentDefaults) ||
      isCliProvider(runtime, params.cfgWithAgentDefaults);
    assertShadowRunNotCli([params.runSessionKey, params.agentSessionKey], cliExecution);
    return {
      sessionRuntimeOverride,
      executionProvider,
      cliExecution: isCliProvider(executionProvider, params.cfgWithAgentDefaults),
      runtime,
    };
  };
}
