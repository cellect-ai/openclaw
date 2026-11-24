import { resolveCliExecutionAuthProfileId } from "../../agents/cli-execution-auth.js";
import { createUnrecordedScheduledAccountRefusal } from "../../agents/scheduled-unrecorded-account.js";
import type { CliSessionBinding } from "../../config/sessions.js";
import { prepareCronRunInference } from "../run-inference.js";
import { getCliSessionBinding } from "./run-execution.runtime.js";
import type { CronRunExecutionParams } from "./run-execution.types.js";

// A CLI child in its parent's workspace runs native tools no tool check sees, so
// its process also ends when the parent resets.
export function resolveCliChildAbortSignal(
  runSignal: AbortSignal | undefined,
  parentSignal: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!parentSignal) {
    return runSignal;
  }
  return runSignal ? AbortSignal.any([runSignal, parentSignal]) : parentSignal;
}

export function hasCliSessionReuseMetadata(binding: CliSessionBinding): boolean {
  return Object.entries(binding).some(([key, value]) => key !== "sessionId" && value !== undefined);
}

export async function prepareCronCliSessionAuth({
  params,
  executionProvider,
  providerOverride,
  allowCliAuthProfileForwarding,
  inference,
  trigger,
  binding,
  modelOverride,
}: {
  params: Pick<
    CronRunExecutionParams,
    "cronSession" | "cfgWithAgentDefaults" | "agentDir" | "liveSelection"
  >;
  executionProvider: string;
  providerOverride: string;
  allowCliAuthProfileForwarding: boolean;
  inference: Awaited<ReturnType<typeof prepareCronRunInference>>;
  trigger: "cron" | "event";
  binding: CronRunExecutionParams["job"]["inferenceBinding"];
  modelOverride: string;
}) {
  const cliSessionBinding = params.cronSession.isNewSession
    ? undefined
    : await getCliSessionBinding(params.cronSession.sessionEntry, executionProvider);
  const resolveForwardedProfile = (
    selected: Parameters<typeof resolveCliExecutionAuthProfileId>[0]["selected"],
  ) =>
    allowCliAuthProfileForwarding
      ? resolveCliExecutionAuthProfileId({
          cliExecutionProvider: executionProvider,
          authProfileProvider: providerOverride,
          config: params.cfgWithAgentDefaults,
          agentDir: params.agentDir,
          sessionBinding: cliSessionBinding,
          selected,
        })
      : Promise.resolve(undefined);
  // A recorded account runs only when this backend forwards exactly that account.
  const authProfileId = inference
    ? await inference.resolveCliAuthProfile(resolveForwardedProfile)
    : await resolveForwardedProfile(
        params.liveSelection.authProfileId
          ? {
              authProfileId: params.liveSelection.authProfileId,
              authProfileIdSource:
                params.liveSelection.authProfileIdSource === "user" ? "user" : "auto",
            }
          : undefined,
      );
  if (trigger === "cron" && !binding && authProfileId) {
    throw createUnrecordedScheduledAccountRefusal({
      runtime: executionProvider,
      modelRef: `${providerOverride}/${modelOverride}`,
      profileId: authProfileId,
    });
  }
  return { cliSessionBinding, authProfileId };
}
