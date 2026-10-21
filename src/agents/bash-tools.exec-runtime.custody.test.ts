import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { markBackgrounded } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";
import { runtimeManagedRun } from "./bash-tools.exec-runtime.test-support.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), emit: vi.fn() }));
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn: mocks.spawn }),
}));
vi.mock("../infra/heartbeat-wake.js", () => ({ requestHeartbeat: vi.fn() }));
vi.mock("../infra/system-events.js", () => ({ enqueueSystemEventWithReceipt: vi.fn() }));

let unsubscribe: (() => void) | undefined;
beforeEach(() => {
  resetProcessRegistryForTests();
  mocks.emit.mockReset();
  mocks.spawn.mockReset();
  mocks.spawn.mockImplementation(async (input) => runtimeManagedRun(input));
  unsubscribe = onAgentEvent((event) => {
    if (event.stream === "sandbox_process") {
      mocks.emit(event);
    }
  });
});
afterEach(() => {
  unsubscribe?.();
  resetProcessRegistryForTests();
});

function fixture() {
  const terminate = vi.fn(async () => {});
  const finalizeExec = vi.fn(async () => {});
  const sandbox = {
    containerName: "shared-fixture",
    workspaceDir: "/workspace",
    containerWorkdir: "/workspace",
    prepareProcessCleanup: (env: Record<string, string>) => ({
      env,
      terminate,
      interrupt: async () => false,
    }),
    buildExecSpec: vi.fn(async () => ({
      argv: ["fixture"],
      env: {},
      stdinMode: "pipe-closed" as const,
    })),
    finalizeExec,
  };
  const options = {
    command: "cellect platform documents show --tenant fixture",
    workdir: "/workspace",
    env: {},
    sandbox,
    usePty: false,
    warnings: [],
    maxOutput: 1000,
    pendingMaxOutput: 1000,
    notifyOnExit: false,
    timeoutSec: null,
    closeProcessTree: true,
    executionOwner: {
      toolCallId: "call-1",
      runId: "run-1",
      agentId: "admin",
      sessionKey: "agent:admin:fixture",
    },
    originRunId: "run-1",
    agentId: "admin",
    sessionKey: "agent:admin:fixture",
  };
  return { options, terminate, finalizeExec };
}

describe("native sandbox credential-custody completion", () => {
  it.each([false, true])(
    "waits for tree cleanup before release (background=%s)",
    async (background) => {
      const { options, terminate, finalizeExec } = fixture();
      const entered = createDeferred();
      const cleanup = createDeferred();
      terminate.mockImplementation(async () => {
        entered.resolve();
        await cleanup.promise;
      });
      const process = await runExecProcess(options);
      if (background) {
        markBackgrounded(process.session);
      }
      await entered.promise;
      expect(mocks.emit).not.toHaveBeenCalled();
      expect(process.session.exited).toBe(false);
      cleanup.resolve();
      await expect(process.promise).resolves.toMatchObject({ status: "completed" });
      expect(finalizeExec).toHaveBeenCalledOnce();
      expect(mocks.emit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          runId: "run-1",
          stream: "sandbox_process",
          data: {
            phase: "cleanup-complete",
            toolCallId: "call-1",
            sessionKey: "agent:admin:fixture",
            agentId: "admin",
          },
        }),
      );
    },
  );

  it.each(["cleanup", "artifacts"])("does not release on %s failure", async (failure) => {
    const { options, terminate, finalizeExec } = fixture();
    (failure === "cleanup" ? terminate : finalizeExec).mockRejectedValue(
      new Error("fixture failure"),
    );
    const process = await runExecProcess(options);
    await expect(process.promise).resolves.toMatchObject({ status: "failed" });
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(process.session.finalizationFailed).toBe(true);
  });

  it("refuses before spawn when the backend cannot prove cleanup", async () => {
    const { options } = fixture();
    await expect(
      runExecProcess({
        ...options,
        sandbox: { ...options.sandbox, prepareProcessCleanup: undefined },
      }),
    ).rejects.toThrow("process-tree cleanup is unavailable");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("does not change ordinary sandbox command lifetime", async () => {
    const { options, terminate } = fixture();
    const process = await runExecProcess({ ...options, closeProcessTree: false });
    await process.promise;
    expect(terminate).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("keeps the cleanup owner separate from notification routing", async () => {
    const { options } = fixture();
    const process = await runExecProcess({
      ...options,
      sessionKey: "agent:admin:parent-notifications",
      executionOwner: { ...options.executionOwner, sessionKey: "agent:admin:actual-tool-owner" },
    });
    await process.promise;
    expect(mocks.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sessionKey: "agent:admin:actual-tool-owner" }),
      }),
    );
  });
});
