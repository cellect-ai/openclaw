import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import type { PluginHookAgentContext } from "../../plugins/hook-types.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import {
  createResolvedEmbeddedRunnerModel,
  createEmbeddedAgentRunnerOpenAiConfig,
} from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "../test-helpers/embedded-agent-runner-e2e-mocks.js";

const hook = vi.fn(async (_event: unknown, context: PluginHookAgentContext) =>
  context.inputProvenance?.kind === "internal_system" &&
  context.inputProvenance.sourceTool === "exec"
    ? { handled: true }
    : { handled: true, reply: { text: "Access verification unavailable" } },
);
const attempt = vi.fn();
let run: typeof import("./run-orchestrator.js").runEmbeddedAgent;
const state = await createOpenClawTestState({ label: "reply-provenance" });

beforeAll(async () => {
  installEmbeddedRunnerBaseE2eMocks();
  installEmbeddedRunnerFastRunE2eMocks({ runEmbeddedAttempt: attempt });
  vi.doMock("../../plugins/hook-runner-global.js", () => ({
    getGlobalHookRunner: () => ({
      hasHooks: (name: string) => name === "before_agent_reply",
      runBeforeAgentReply: hook,
    }),
    initializeGlobalHookRunner: vi.fn(),
  }));
  vi.doMock("../models-config.js", () => ({ ensureOpenClawModelsJson: vi.fn() }));
  vi.doMock("./model.js", () => ({
    resolveModelAsync: async (provider: string, modelId: string) =>
      createResolvedEmbeddedRunnerModel(provider, modelId),
  }));
  ({ runEmbeddedAgent: run } = await import("./run-orchestrator.js"));
});
afterAll(async () => {
  await state.cleanup();
});

it.each(["internal_system", "external_user"] as const)(
  "preserves %s provenance through embedded reply dispatch",
  async (kind) => {
    const config = createEmbeddedAgentRunnerOpenAiConfig(["fixture-model"]);
    const runId = `embedded-completion-${kind}`;
    const admission = prepareSystemAgentRunAdmission(config, runId, "main", "reply-provenance");
    const sessionKey = `agent:main:matrix:channel:!room:example:thread:${kind}`;
    const inputProvenance = { kind, sourceTool: "exec" };
    try {
      const result = await run({
        config,
        runId,
        preparedRunAdmission: admission,
        sessionId: runId,
        sessionKey,
        agentId: "main",
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        sessionTarget: {
          agentId: "main",
          sessionId: runId,
          sessionKey,
          storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
        },
        prompt: "[OpenClaw exec completion]",
        provider: "openai",
        model: "fixture-model",
        trigger: kind === "internal_system" ? "heartbeat" : "user",
        messageChannel: "matrix",
        agentAccountId: "fixture",
        timeoutMs: 1000,
        inputProvenance,
      });
      expect(hook).toHaveBeenLastCalledWith(
        { cleanedBody: "[OpenClaw exec completion]" },
        expect.objectContaining({ inputProvenance }),
      );
      expect(result.payloads).toEqual([
        {
          text: kind === "internal_system" ? SILENT_REPLY_TOKEN : "Access verification unavailable",
        },
      ]);
      expect(attempt).not.toHaveBeenCalled();
    } finally {
      admission.close();
    }
  },
);
