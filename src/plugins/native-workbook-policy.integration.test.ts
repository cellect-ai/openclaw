import { expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import type { AnyAgentTool } from "../agents/agent-tools.types.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAgentHarnessToolSurfaceRuntime } from "../plugin-sdk/agent-harness-tool-runtime.js";
import { createOpenClawCodingTools } from "../plugin-sdk/agent-harness.js";
import { resolveSandboxRuntimeStatus } from "../plugin-sdk/sandbox.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createHookRunner } from "./hooks.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  disposePluginRegistryInstances,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "./runtime.js";

// Artifact-bound plugin loading belongs to the native owner: an SDK-created
// record alone intentionally cannot stand in for the loader's source receipt.
it("advertises an admitted workbook reader through actual operator policy and Code Mode with one exact grant", async () => {
  const state = await createOpenClawTestState({ prefix: "workbook-policy-" });
  let registry: ReturnType<typeof loadOpenClawPlugins> | undefined;
  let runAdmission: ReturnType<typeof prepareAgentRunAdmission> | undefined;
  let runtime: ReturnType<typeof createAgentHarnessToolSurfaceRuntime> | undefined;
  try {
    const room = "!room:matrix.test",
      root = "$root",
      sender = "@human:matrix.test";
    const sessionKey = `agent:cellect-main:matrix:channel:${room}:thread:${root}`;
    const extras = [
      "message",
      "requester_gmail",
      "requester_gdrive",
      "cellect_mail",
      "read_conversation",
      "ask_user",
      "m365_mail",
    ];
    const config: OpenClawConfig = {
      talk: { agentId: "cellect-main" },
      agents: {
        defaults: { sandbox: { mode: "all", scope: "agent" } },
        entries: {
          "cellect-main": {
            sandbox: { scope: "session" },
            tools: {
              elevated: { enabled: false },
              alsoAllow: extras,
              sandbox: { tools: { alsoAllow: extras } },
            },
          },
        },
      },
      plugins: {
        allow: ["fi-user"],
        entries: {
          "fi-user": {
            enabled: true,
            config: {
              operatorAgentId: "cellect-main",
              baseUrl: "https://fi.test/fi",
              brokerTokenEnv: "WORKBOOK_TEST_BROKER",
            },
          },
        },
      },
    };
    vi.stubEnv("WORKBOOK_TEST_BROKER", "fixture-broker");
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ operatorprod: "prod" }));
    const fetchMock = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/agent-authorize")
              ? {
                  ok: true,
                  credentialClass: "operator",
                  orgId: "admitted-org",
                  agentId: "cellect-main",
                }
              : {
                  ok: true,
                  orgId: "admitted-org",
                  sheet: {
                    fieldId: "field",
                    summary: { sheets: [{ id: "tab", name: "Original" }] },
                    collabRevision: 82,
                  },
                },
          ),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    setRuntimeConfigSnapshot(config);
    registry = loadOpenClawPlugins({
      config,
      onlyPluginIds: ["fi-user"],
      activate: false,
      throwOnLoadError: true,
    });
    setActivePluginRegistry(registry);
    runAdmission = prepareAgentRunAdmission({
      cfg: config,
      facts: {
        runId: "native-run",
        agentId: "cellect-main",
        ingress: { kind: "system", boundary: "native-workbook-fixture", state: "present" },
      },
      operationalRunInstance: createOperationalRunInstanceRef("native-run"),
    });
    const admittedRunContext = await runAdmission.admit("embedded");
    const identity = createAdmittedGatewayToolCallerIdentity({
      admittedRunContext,
      agentId: "cellect-main",
      sessionKey,
    });
    let selectedTools: AnyAgentTool[] = [];
    const surface = createAgentHarnessToolSurfaceRuntime({
      config: { ...config, tools: { codeMode: true } },
      agentId: "cellect-main",
      sessionKey,
      runId: "native-run",
      modelToolsEnabled: true,
      executeTool: async ({ toolName, input, signal, onUpdate, acceptResultBeforeProjection }) => {
        const tool = selectedTools.find((candidate) => candidate.name === toolName);
        if (!tool) {
          throw new Error("Unknown fixture tool");
        }
        return acceptResultBeforeProjection(
          await tool.execute("native-code", input, signal, onUpdate),
        );
      },
    });
    runtime = surface;
    const runner = createHookRunner(registry, { catchErrors: false });
    const admission = await runner.runBeforeAgentReply(
      { cleanedBody: "Read the workbook" },
      {
        runId: "native-run",
        agentId: "cellect-main",
        channel: "matrix",
        accountId: "operatorprod",
        senderId: sender,
        chatId: room,
        sessionKey,
        inputProvenance: { kind: "external_user" },
        channelContext: { sender: { id: sender }, chat: { id: room, eventId: "$event" } },
      },
    );
    expect(admission).toBeUndefined();
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/agent-authorize"))).toBe(true);
    const resolve = async (grant: boolean) => {
      const alsoAllow = [...extras, ...(grant ? ["fi_workbook"] : [])];
      const effective = structuredClone(config);
      const entry = effective.agents!.entries!["cellect-main"]!;
      entry.tools = { ...entry.tools, alsoAllow, sandbox: { tools: { alsoAllow } } };
      return withGatewayToolCallerIdentity(identity, () =>
        createOpenClawCodingTools({
          config: effective,
          agentId: "cellect-main",
          includeCoreTools: false,
          sessionKey,
          runId: "native-run",
          messageChannel: "matrix",
          agentAccountId: "operatorprod",
          senderId: sender,
          nativeChannelId: room,
          currentMessageId: "$event",
          modelProvider: "openai",
          modelId: "fixture-model",
          workspaceDir: state.workspaceDir,
          sandbox: {
            enabled: true,
            backendId: "docker",
            sessionKey,
            workspaceDir: state.workspaceDir,
            agentWorkspaceDir: state.workspaceDir,
            workspaceAccess: "rw",
            runtimeId: "fixture",
            runtimeLabel: "fixture",
            containerName: "fixture",
            containerWorkdir: "/workspace",
            browserAllowHostControl: false,
            docker: {
              image: "fixture",
              containerPrefix: "fixture-",
              workdir: "/workspace",
              readOnlyRoot: true,
              tmpfs: [],
              network: "none",
              capDrop: [],
            },
            tools: resolveSandboxRuntimeStatus({
              cfg: effective,
              agentId: "cellect-main",
              sessionKey,
              preparedSessionEntry: null,
            }).toolPolicy,
          },
        }),
      );
    };
    expect((await resolve(false)).some((tool) => tool.name === "fi_workbook")).toBe(false);
    const tools = await resolve(true);
    selectedTools = tools;
    expect(tools.some((tool) => tool.name === "fi_workbook")).toBe(true);
    const exec = surface.compactTools(tools).tools.find((tool) => tool.name === "exec");
    expect(exec).toBeDefined();
    const result = await withGatewayToolCallerIdentity(identity, () =>
      exec!.execute("code", {
        code: 'return await fi_workbook({ action: "get", roomId: "data-room", fieldId: "field" });',
        awaitResults: true,
      }),
    );
    expect(JSON.stringify(result)).toContain("Original");
    expect(JSON.stringify(result)).not.toContain("fixture-broker");
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/openclaw-user-delegation"))).toBe(
      false,
    );
  } finally {
    runtime?.cleanup();
    runAdmission?.close();
    if (registry) {
      await disposePluginRegistryInstances(registry);
    }
    resetPluginRuntimeStateForTest();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await state.cleanup();
  }
});
