import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexDynamicToolBridge } from "../../extensions/codex/src/app-server/dynamic-tools.js";
import { createSandboxExecProjection } from "../../extensions/codex/src/app-server/shell-dynamic-tools.js";
import {
  HELD,
  UNPROVEN_HOLD,
  installDelegationFixtures,
  mints,
  plugin,
  slackThread,
  SLACK_THREAD,
  TOKEN,
} from "../../extensions/fi-user/admin-delegation.test-helpers.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationRegistryScope } from "../plugins/runtime/generation-state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { createRunExit } from "./bash-tools.exec-runtime.test-support.js";

const processBoundary = vi.hoisted(() => ({ envs: [] as Array<Record<string, string>> }));
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: async (input: { env: Record<string, string> }) => {
      processBoundary.envs.push(input.env);
      return {
        activity: { resultSettled: true, lastOutputAtMs: Date.now() },
        runId: "fixture-process",
        startedAtMs: Date.now(),
        wait: async () => createRunExit(),
        cancel: vi.fn(),
      };
    },
    cancel: vi.fn(),
    cancelScope: vi.fn(),
  }),
}));

installDelegationFixtures();

describe("registered Codex sandbox execution requester custody", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    resetGlobalHookRunner();
    processBoundary.envs.length = 0;
  });

  it("releases the minting prepared instance only after native asynchronous cleanup", async () => {
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
    const turn = plugin();
    const prepared = createEmptyPluginRegistry();
    for (const [hookName, handlers] of turn.registrations.hooks) {
      for (const handler of handlers) {
        prepared.typedHooks.push({
          pluginId: "fi-user",
          source: "fixture",
          hookName,
          handler,
        } as never);
      }
    }
    prepared.agentEventSubscriptions.push(
      ...turn.registrations.subscriptions.map((subscription) => ({
        pluginId: "fi-user",
        source: "fixture",
        subscription,
      })),
    );
    const root = createEmptyPluginRegistry();
    const rootCleanup = vi.fn();
    root.agentEventSubscriptions.push({
      pluginId: "fi-user",
      source: "fixture-root",
      subscription: {
        id: "admin-delegation-turn-retirement",
        streams: ["sandbox_process"],
        handle: rootCleanup,
      },
    });
    setActivePluginRegistry(root);
    initializeGlobalHookRunner(root);

    const first = slackThread();
    await turn.arrive(first.arrive);
    await turn.start(first.start);
    const cleanupStarted = createDeferredCore();
    const cleanupAllowed = createDeferredCore();
    const terminate = vi.fn(async () => {});
    const cleanupEvents: unknown[] = [];
    const unsubscribe = onAgentEvent((event) => {
      if (event.stream === "sandbox_process") cleanupEvents.push(event);
    });
    const context = {
      agentId: "cellect-fi-admin",
      sessionKey: SLACK_THREAD,
      runId: "run-1",
      requester: first.exec.requester,
    };
    function registeredBridge(owner: typeof context, finalizeExec: () => Promise<void>) {
      const exec = createExecTool({
        host: "sandbox",
        security: "full",
        ask: "off",
        ...owner,
        preparedStoreEnvironment: {},
        sandbox: {
          containerName: "custody-fixture",
          workspaceDir: process.cwd(),
          containerWorkdir: "/workspace",
          workdirValidation: "backend",
          validateWorkdir: async (workdir) => workdir,
          prepareProcessCleanup: (env) => ({ env, terminate, interrupt: async () => false }),
          buildExecSpec: async ({ env }) => ({ argv: ["fixture"], env, stdinMode: "pipe-closed" }),
          finalizeExec,
        },
      });
      return createCodexDynamicToolBridge({
        tools: [createSandboxExecProjection(wrapToolWithBeforeToolCallHook(exec, owner))],
        signal: new AbortController().signal,
        hookContext: owner,
      });
    }
    const bridge = registeredBridge(context, async () => {
      cleanupStarted.resolve();
      await cleanupAllowed.promise;
    });
    // Return the promise to an unscoped caller. Native asynchronous cleanup must
    // retain the originating generation rather than select the process root.
    const execution = withPluginRuntimeGenerationRegistryScope(prepared, () =>
      bridge.handleToolCall({
        threadId: "thread",
        turnId: "turn",
        callId: "native-codex-call",
        namespace: null,
        tool: "sandbox_exec",
        arguments: { command: "cellect commands list", yieldMs: 10000 },
      }),
    );
    try {
      await Promise.race([
        cleanupStarted.promise,
        execution.then((result) => {
          throw new Error(`Execution ended before native cleanup: ${JSON.stringify(result)}`);
        }),
      ]);
      expect(processBoundary.envs[0]?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
      expect(cleanupEvents).toEqual([]);

      const senderId = "@admin:matrix.example";
      const roomId = "!projection:matrix.example";
      const eventId = "$projected-reply";
      const channelContext = {
        sender: { id: senderId },
        chat: {
          id: roomId,
          eventId,
          sourceReplyAdmission: {
            version: 1,
            sessionKey: SLACK_THREAD,
            roomId,
            senderId,
            accountId: "adminprod",
            eventId,
            authorizedAt: Date.now(),
          },
        },
      };
      await turn.arrive({
        channel: "matrix",
        senderId,
        sessionKey: SLACK_THREAD,
        accountId: "adminprod",
        isGroup: true,
        messageId: eventId,
        channelContext,
      });
      await turn.start({
        runId: "matrix-run",
        channel: "matrix",
        senderId,
        sessionKey: SLACK_THREAD,
        accountId: "adminprod",
        chatId: roomId,
        channelContext,
      });
      const projected = {
        runId: "matrix-run",
        sessionKey: SLACK_THREAD,
        requester: { channel: "matrix", senderId, accountId: "adminprod" },
      };
      const raw = { params: { command: "pwd" } };
      const matrixContext = { agentId: "cellect-fi-admin", ...projected };
      const matrixBridge = registeredBridge(matrixContext, async () => {});
      const heldResponse = await withPluginRuntimeGenerationRegistryScope(prepared, () =>
        matrixBridge.handleToolCall({
          threadId: "thread",
          turnId: "matrix-turn",
          callId: "native-matrix-held",
          namespace: null,
          tool: "sandbox_exec",
          arguments: { command: "cellect commands list" },
        }),
      );
      expect(JSON.stringify(heldResponse)).toContain(HELD);
      expect(processBoundary.envs).toHaveLength(1);
      expect(await turn.exec(projected, raw)).toMatchObject({ block: true, blockReason: HELD });
      expect(await turn.exec({ ...projected, runId: "unproven-run" }, raw)).toMatchObject({
        block: true,
        blockReason: UNPROVEN_HOLD,
      });
      for (const mismatch of [
        { toolCallId: "other-call" },
        { sessionKey: "other-session" },
        { agentId: "other-agent" },
      ]) {
        withPluginRuntimeGenerationRegistryScope(prepared, () =>
          emitAgentEvent({
            runId: "run-1",
            stream: "sandbox_process",
            data: {
              phase: "cleanup-complete",
              toolCallId: "native-codex-call",
              agentId: "cellect-fi-admin",
              sessionKey: SLACK_THREAD,
              ...mismatch,
            },
          }),
        );
        expect(await turn.exec(projected, raw)).toMatchObject({ block: true, blockReason: HELD });
      }
      withPluginRuntimeGenerationRegistryScope(prepared, () =>
        emitAgentEvent({
          runId: "different-run",
          stream: "sandbox_process",
          data: {
            phase: "cleanup-complete",
            toolCallId: "native-codex-call",
            agentId: "cellect-fi-admin",
            sessionKey: SLACK_THREAD,
          },
        }),
      );
      expect(await turn.exec(projected, raw)).toMatchObject({ block: true, blockReason: HELD });
      cleanupEvents.length = 0;
      cleanupAllowed.resolve();
      await execution;
      expect(terminate).toHaveBeenCalledOnce();
      expect(cleanupEvents).toEqual([
        expect.objectContaining({
          runId: "run-1",
          stream: "sandbox_process",
          data: {
            phase: "cleanup-complete",
            toolCallId: "native-codex-call",
            agentId: "cellect-fi-admin",
            sessionKey: SLACK_THREAD,
          },
        }),
      ]);
      expect(rootCleanup).not.toHaveBeenCalled();
      expect((await turn.exec(projected, raw))?.block).not.toBe(true);
      await withPluginRuntimeGenerationRegistryScope(prepared, () =>
        matrixBridge.handleToolCall({
          threadId: "thread",
          turnId: "matrix-turn",
          callId: "native-matrix-call",
          namespace: null,
          tool: "sandbox_exec",
          arguments: { command: "cellect commands list", yieldMs: 10000 },
        }),
      );
      expect(processBoundary.envs).toHaveLength(2);
      expect(processBoundary.envs[1]?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
      expect(JSON.parse(String(mints().at(-1)?.[1]?.body))).toMatchObject({
        requesterMatrixUserId: senderId,
      });
      expect(cleanupEvents.at(-1)).toMatchObject({
        runId: "matrix-run",
        data: {
          phase: "cleanup-complete",
          toolCallId: "native-matrix-call",
          agentId: "cellect-fi-admin",
          sessionKey: SLACK_THREAD,
        },
      });
    } finally {
      cleanupAllowed.resolve();
      await execution;
      unsubscribe();
    }
  });
});
