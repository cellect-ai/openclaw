import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { getSkillWorkshopReviewLane } from "../../process/background-work.js";
import { captureSkillReviewBackground } from "./review-background.js";

/**
 * The background Workshop review run: the openclaw harness on a locked model, crediting
 * changes to the reviewed session.
 */
export async function runSkillWorkshopReview(
  params: RunEmbeddedAgentParams & {
    agentId: string;
    config: OpenClawConfig;
    preparedRunAdmission: NonNullable<RunEmbeddedAgentParams["preparedRunAdmission"]>;
    skillWorkshopReviewOf: string;
  },
) {
  using background = captureSkillReviewBackground(params.sessionId, params.abortSignal);
  const abortSignal = background.signal;
  // Background runs stay out of the Control UI and never project into a user session.
  registerAgentRunContext(params.runId, {
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    isControlUiVisible: false,
    projectSessionActive: false,
    projectSessionLifecycle: false,
    projectSessionMessages: false,
  });
  try {
    background.assertCurrent();
    const { runEmbeddedAgent } = await import("../../agents/embedded-agent.js");
    const result = await runEmbeddedAgent({
      ...params,
      abortSignal,
      lane: getSkillWorkshopReviewLane(),
      agentHarnessId: "openclaw",
      agentHarnessRuntimeOverride: "openclaw",
      // Review is best-effort work: never spend interactive capacity on retries.
      modelSelectionLocked: true,
      modelFallbacksOverride: [],
      retryTransientErrors: false,
      allowAuthProfileFallback: false,
      authProfileFailurePolicy: "local_transient",
      requestedRouteResolution: "resolved",
      sessionPersistence: "detached",
      promptCacheKey: undefined,
      sourceReplyDeliveryMode: undefined,
      toolsAllow: ["skill_workshop"],
      toolExecutionAllow: ["skill_workshop"],
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
      contextTokenBudget: 16_384,
      streamParams: { maxTokens: 2_048 },
      thinkLevel: "low",
      timeoutMs: Math.min(params.timeoutMs, 120_000),
      disableTrajectory: true,
      silentExpected: true,
      allowEmptyAssistantReplyAsSilent: true,
      terminalReplyExpectation: "optional",
      cleanupBundleMcpOnRunEnd: true,
      verboseLevel: "off",
    });
    background.assertCurrent();
    return result;
  } finally {
    params.preparedRunAdmission.close();
    clearAgentRunContext(params.runId);
    cleanupSessionResources(params.sessionId);
  }
}
