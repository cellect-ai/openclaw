import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { FailoverError } from "../../agents/failover/error.js";
import { getRegisteredAgentHarness } from "../../agents/harness/registry.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { WORKSHOP_COLLECTION_REVIEW_DECLARATION_PREFIX } from "../../cron/system-owned-declaration.js";
import type { CronJob } from "../../cron/types.js";
import {
  WORKSHOP_COLLECTION_REVIEW_EVERY_MS,
  WORKSHOP_COLLECTION_REVIEW_MESSAGE,
  WORKSHOP_COLLECTION_REVIEW_PROMPT,
} from "./collection-review-prompt.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import { resolveSkillWorkshopToolConstructionBlock } from "./tool-availability.js";
export {
  WORKSHOP_COLLECTION_REVIEW_MESSAGE,
  WORKSHOP_COLLECTION_REVIEW_PROMPT,
} from "./collection-review-prompt.js";

/** Unknown projection waits for runtime preparation; execution requires the loaded owner's exact policy contract. */
export function supportsWorkshopCollectionRuntime(
  runtime: string,
  cliExecution = false,
  mode: "projection" | "execution" = "projection",
): boolean | undefined {
  if (cliExecution) return false;
  if (runtime === "openclaw") return true;
  const registered = getRegisteredAgentHarness(runtime);
  if (registered) return registered.harness.conversationToolPolicySupport === "exact";
  // Codex is a known host-tool owner, but dispatch still requires its actual loaded capability.
  return mode === "projection" ? (runtime === "codex" ? true : undefined) : false;
}

export function isWorkshopCollectionReview(job: Pick<CronJob, "declarationKey">): boolean {
  return job.declarationKey?.startsWith(WORKSHOP_COLLECTION_REVIEW_DECLARATION_PREFIX) === true;
}

export function assertWorkshopCollectionReviewCurrent(
  job: CronJob,
  config: OpenClawConfig,
  agentId: string,
): void {
  if (
    job.declarationKey !== `${WORKSHOP_COLLECTION_REVIEW_DECLARATION_PREFIX}${agentId}` ||
    job.agentId !== agentId ||
    job.sessionTarget !== "isolated" ||
    job.schedule.kind !== "every" ||
    job.schedule.everyMs !== WORKSHOP_COLLECTION_REVIEW_EVERY_MS ||
    job.delivery?.mode !== "none" ||
    job.payload.kind !== "agentTurn" ||
    job.payload.message !== WORKSHOP_COLLECTION_REVIEW_MESSAGE ||
    job.payload.toolsAllow?.length !== 1 ||
    job.payload.toolsAllow[0] !== "skill_workshop"
  ) {
    throw new Error(
      "Invalid system Workshop collection review declaration; repair it before running.",
    );
  }
  if (resolveSkillWorkshopConfig(config).autonomous.mode !== "auto")
    throw new Error("Weekly Skill Workshop collection review requires auto mode.");
}

/** Missing collection is empty; unreadable/corrupt library errors are not caught as emptiness. */
export async function preflightWorkshopCollectionReview(params: {
  job: CronJob;
  config: OpenClawConfig;
  agentId: string;
  assertCurrent?: () => void;
  signal?: AbortSignal;
}): Promise<boolean> {
  assertWorkshopCollectionReviewCurrent(params.job, params.config, params.agentId);
  const { listWorkshopSkills } = await import("./library.js");
  const skills = await listWorkshopSkills(params.config, params.agentId);
  params.signal?.throwIfAborted();
  params.assertCurrent?.();
  assertWorkshopCollectionReviewCurrent(params.job, getRuntimeConfig(), params.agentId);
  return skills.length > 0;
}

export async function prepareWorkshopCollectionCandidate(params: {
  config: OpenClawConfig;
  agentId: string;
  provider: string;
  model: string;
  runtime: string;
  cliExecution: boolean;
  sessionKey: string;
  workspaceDir: string;
  sandboxed: boolean;
  assertCurrent: () => void;
}): Promise<void> {
  params.assertCurrent();
  if (!supportsWorkshopCollectionRuntime(params.runtime, params.cliExecution, "execution")) {
    throw new FailoverError(
      "Weekly Workshop review requires host-owned Workshop tools (no-rooted-runtime).",
      { reason: "model_not_found", provider: params.provider, model: params.model },
    );
  }
  const { prepareConversationCapabilityProfile } =
    await import("../../agents/conversation-capability-profile.js");
  const { resolveSkillWorkshopToolPolicyAvailability } =
    await import("./tool-policy-diagnostic.js");
  const profile = await prepareConversationCapabilityProfile({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sandboxSessionKey: params.sessionKey,
    modelProvider: params.provider,
    modelId: params.model,
    workspaceDir: params.workspaceDir,
  });
  params.assertCurrent();
  if (
    resolveSkillWorkshopToolConstructionBlock({ sandboxed: params.sandboxed }) ||
    !resolveSkillWorkshopToolPolicyAvailability({
      config: params.config,
      conversationCapabilityProfile: profile,
    }).available
  ) {
    throw new FailoverError(
      "Weekly Workshop review cannot use skill_workshop (no-workshop-tools).",
      { reason: "model_not_found", provider: params.provider, model: params.model },
    );
  }
}

/** Keep cron's chosen candidate, admission, lifecycle and fallback; narrow only this review's tools/context. */
export function workshopCollectionRunOptions(
  sessionKey: string,
  timeoutMs: number,
): Partial<RunEmbeddedAgentInternalParams> {
  return {
    prompt: WORKSHOP_COLLECTION_REVIEW_PROMPT,
    skillWorkshopReviewOf: sessionKey,
    toolsAllow: ["skill_workshop"],
    toolExecutionAllow: ["skill_workshop"],
    conversationToolPolicy: { allow: ["skill_workshop"] },
    codeModeOverride: false,
    disableToolSearch: true,
    promptMode: "minimal",
    bootstrapContextMode: "lightweight",
    skillsSnapshot: undefined,
    extraSystemPrompt: undefined,
    clientTools: undefined,
    conversationRecall: undefined,
    gitCoauthorPrompt: undefined,
    forceMessageTool: false,
    disableMessageTool: true,
    sourceReplyDeliveryMode: undefined,
    contextTokenBudget: 16_384,
    streamParams: { maxTokens: 2_048 },
    timeoutMs: Math.min(timeoutMs, 120_000),
    retryTransientErrors: false,
    disableTrajectory: true,
    silentExpected: true,
    allowEmptyAssistantReplyAsSilent: true,
    terminalReplyExpectation: "optional",
    verboseLevel: "off",
  };
}
