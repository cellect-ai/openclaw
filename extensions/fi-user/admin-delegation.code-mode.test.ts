import { createAgentHarnessToolSurfaceRuntime } from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { expect, it, vi } from "vitest";
import {
  installDelegationFixtures,
  matrix,
  mintBody,
  mints,
  plugin,
  SANDBOXED,
  TOKEN,
} from "./admin-delegation.test-helpers.js";

installDelegationFixtures();

it("injects the Matrix requester after Code Mode adds required exec collection", async () => {
  vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
  const turn = plugin();
  await turn.arrive(matrix.arrive);
  await turn.start(matrix.start);
  const observed = vi.fn();
  const surface = createAgentHarnessToolSurfaceRuntime({
    config: { ...SANDBOXED, tools: { ...SANDBOXED.tools, codeMode: true } },
    agentId: "cellect-fi-admin",
    sessionKey: matrix.exec.sessionKey,
    runId: "run-1",
    modelToolsEnabled: true,
    executeTool: async ({ input, acceptResultBeforeProjection }) => {
      observed(input);
      const rewrite = await turn.exec(
        { ...matrix.exec, toolName: "sandbox_exec" },
        { toolName: "sandbox_exec", params: input },
      );
      return acceptResultBeforeProjection({
        content: [],
        details: { requesterToken: rewrite?.params.env?.FI_DELEGATED_USER_TOKEN },
      });
    },
  });
  try {
    const { tools } = surface.compactTools([
      {
        name: "exec",
        label: "Run sandbox command",
        description: "Execute a command in the sandbox",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            title: { type: "string" },
            workdir: { type: "string" },
            awaitResults: { type: "boolean" },
          },
          required: ["command"],
        },
        execute: async () => ({ content: [], details: {} }),
      },
    ]);
    const exec = tools.find((tool) => tool.name === "exec");
    expect(exec).toBeDefined();
    const result = await exec!.execute("code-mode-call", {
      code: 'return await exec({ command: "cellect platform room list --tenant fixture --actor admin@example.com", title: "List authorized rooms", workdir: "/workspace" });',
      awaitResults: true,
    });
    // The guest omitted this field: the real core bridge owns its insertion.
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({ awaitResults: true }));
    expect(result.details).toMatchObject({
      status: "completed",
      value: { requesterToken: TOKEN },
    });
    expect(mints()).toHaveLength(1);
    expect(mintBody()).toEqual({
      requesterMatrixUserId: "@admin:matrix.example",
      agentId: "cellect-fi-admin",
    });
  } finally {
    surface.cleanup();
  }
});
