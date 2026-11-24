import { isRestrictedBackgroundHookRun } from "../../agents/shadow-hook-tool-policy.js";
import { registerCronRunExecSource } from "../../infra/cron-run-exec-source.js";
import { registerHookFiEnvironment } from "../../infra/hook-fi-environment.js";
import { registerHookRequesterAttestation } from "../../infra/hook-requester-attestation.js";
import { registerMailWakeSourceLock } from "../../infra/mail-wake-source-lock.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { prepareCronRunAdmission } from "../run-admission.js";
import type { CronRunExecutionParams } from "./run-execution.types.js";

export function registerCronPromptSources(
  params: Pick<
    CronRunExecutionParams,
    | "agentId"
    | "job"
    | "runSessionKey"
    | "agentSessionKey"
    | "sourceLockCapability"
    | "mailWakeSessionKey"
    | "hookRequesterEnvironment"
    | "hookRequesterAttestation"
  >,
  runId: string,
  cronAdmission: ReturnType<typeof prepareCronRunAdmission>,
) {
  using cronRunExecSource = new DisposableStack();
  try {
    cronRunExecSource.defer(
      registerCronRunExecSource(runId, {
        agentId: params.agentId,
        jobId: params.job.id,
        jobConfigRevision: resolveCronJobConfigRevision(params.job),
        jobName: params.job.name,
        standingGrantAuthority: cronAdmission.standingGrantAuthority,
      }),
    );
  } catch {
    // Non-canonicalizable job config: no grant registration for this run.
  }
  cronRunExecSource.defer(
    registerMailWakeSourceLock({
      runId,
      sessionKey: params.runSessionKey,
      capability: params.sourceLockCapability,
      mailSessionKey: params.mailWakeSessionKey,
      environment: params.hookRequesterEnvironment,
    }),
  );
  cronRunExecSource.defer(
    registerHookFiEnvironment({
      runId,
      sessionKey: params.runSessionKey,
      environment: params.hookRequesterEnvironment,
    }),
  );
  cronRunExecSource.defer(
    registerHookRequesterAttestation({
      runId,
      sessionKey: params.runSessionKey,
      environment: params.hookRequesterEnvironment,
      attestation: isRestrictedBackgroundHookRun(params.agentSessionKey, params.runSessionKey)
        ? params.hookRequesterAttestation
        : undefined,
    }),
  );
  return cronRunExecSource.move();
}
