import { beforeEach, expect, it, vi } from "vitest";
import type { PluginHookAgentContext } from "../../plugins/hook-types.js";
import { runCliBeforeAgentReply } from "./before-agent-reply.js";
import type { RunCliAgentParams } from "./types.js";

const hookRunner = vi.hoisted(() => ({
  hasHooks: vi.fn(() => true),
  runBeforeAgentReply: vi.fn(),
}));
vi.mock("../../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => hookRunner }));
vi.mock("../cli-backends.js", () => ({ resolveCliBackendConfig: () => undefined }));
vi.mock("./log.js", () => ({
  cliBackendLog: { info: vi.fn() },
  formatCliBackendOutputDigest: () => "synthetic",
}));
beforeEach(() => {
  hookRunner.runBeforeAgentReply
    .mockReset()
    .mockImplementation(async (_event, context: PluginHookAgentContext) =>
      context.inputProvenance?.kind === "internal_system" &&
      context.inputProvenance.sourceTool === "exec"
        ? { handled: true }
        : { handled: true, reply: { text: "Access verification unavailable" } },
    );
});

it.each(["internal_system", "external_user"] as const)(
  "passes %s provenance through the CLI reply boundary without inferring it from text",
  async (kind) => {
    const inputProvenance = { kind, sourceTool: "exec" };
    const params: RunCliAgentParams = {
      runId: `cli-completion-${kind}`,
      sessionId: "fixture",
      sessionFile: "synthetic",
      sessionKey: "agent:fixture:matrix:channel:!room:example:thread:$root",
      workspaceDir: "/synthetic",
      prompt: "[OpenClaw exec completion]",
      provider: "fixture-cli",
      timeoutMs: 1000,
      trigger: "user",
      messageChannel: "matrix",
      agentAccountId: "fixture",
      inputProvenance,
    };
    const result = await runCliBeforeAgentReply(params);
    expect(hookRunner.runBeforeAgentReply).toHaveBeenCalledWith(
      { cleanedBody: params.prompt },
      expect.objectContaining({ inputProvenance }),
    );
    expect(result?.payloads).toEqual(
      kind === "internal_system" ? [] : [{ text: "Access verification unavailable" }],
    );
    if (kind === "internal_system") {
      expect(result?.meta.terminalReply).toEqual({ disposition: "silent" });
    }
  },
);

it("leaves event turns outside the claiming-hook trigger contract", async () => {
  const result = await runCliBeforeAgentReply({
    runId: "cli-completion-event",
    sessionId: "fixture",
    sessionFile: "synthetic",
    workspaceDir: "/synthetic",
    prompt: "[OpenClaw exec completion]",
    provider: "fixture-cli",
    timeoutMs: 1000,
    trigger: "event",
    inputProvenance: { kind: "internal_system", sourceTool: "exec" },
  });
  expect(hookRunner.runBeforeAgentReply).not.toHaveBeenCalled();
  expect(result).toBeUndefined();
});
