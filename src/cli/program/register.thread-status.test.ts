import "../../test-utils/prepare-compiled-subprocesses.js";
import { Command } from "commander";
import { beforeEach, expect, it, vi } from "vitest";
import type { ThreadContinuationDescription } from "../../../packages/gateway-protocol/src/schema/thread-continuation.js";
import { registerStatusHealthSessionsCommands } from "./register.status-health-sessions.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
}));
// The registered command and lazy command import are real; only transport/runtime are isolated.
vi.mock("../../gateway/call.js", () => ({ callGateway: mocks.callGateway }));
vi.mock("../../runtime.js", async (original) => ({
  ...(await original<typeof import("../../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));
const permalink = "https://example.slack.com/archives/C123/p1785541458788849";
const key = "agent:main:slack:channel:c123:thread:1785541458.788849";
function observation(): ThreadContinuationDescription {
  return {
    complete: true,
    members: [
      {
        agentId: "main",
        sessionKey: key,
        sessionId: "incarnation",
        lifecycleRevision: null,
        fingerprint: "a".repeat(64),
        status: "done",
        recoveryPending: false,
        updatedAt: 100,
        endedAt: 100,
        terminalRunId: "success",
      },
    ],
    status: {
      lastTool: "exec",
      lastToolAt: "2026-11-23T00:00:00.000Z",
      lastError: "observed failure",
      latestTask: {
        taskId: "old-failure",
        status: "failed",
        agentId: "main",
        ownerKey: key,
        requesterSessionKey: key,
        createdAt: null,
        lastEventAt: 50,
        sequence: 1,
        task: null,
        observationSummary: "observed failure",
        error: "observed failure",
      },
      taskCount: 1,
      historyAvailable: true,
      historyComplete: false,
      historyScope: "retained-terminal-observations",
      currentTerminalCoverageComplete: false,
      transcriptComplete: true,
    },
  };
}
function respond(state = observation()) {
  mocks.callGateway.mockImplementation(async ({ method }: { method: string }) => {
    if (method === "sessions.list") return { sessions: [{ key, agentId: "main" }] };
    if (method === "sessions.describe") return { threadContinuation: state };
    throw new Error(`Unexpected method ${method}`);
  });
}
async function run(args: string[]) {
  const cli = new Command();
  registerStatusHealthSessionsCommands(cli);
  await cli.parseAsync(args, { from: "user" });
}
beforeEach(() => vi.clearAllMocks());
it.each([
  ["thread", "--json", "status", permalink],
  ["thread", "status", permalink, "--json"],
])("registered status restores JSON fields %j", async (...args: string[]) => {
  respond();
  await run(args);
  expect(JSON.parse(mocks.runtime.log.mock.calls[0]![0])).toMatchObject({
    permalink,
    channelId: "C123",
    threadTs: "1785541458.788849",
    agentId: "main",
    sessionKey: key,
    sessionExists: true,
    sessionUpdatedAt: 100,
    active: false,
    lastTool: "exec",
    lastToolAt: "2026-11-23T00:00:00.000Z",
    lastError: "observed failure",
    taskCount: 1,
    latestTask: { taskId: "old-failure", status: "failed" },
    historyComplete: false,
  });
  expect(mocks.callGateway.mock.calls.every(([request]) => request.method !== "agent")).toBe(true);
});
it("registered text reports task/activity/tool/error without making observations live authority", async () => {
  respond();
  await run(["thread", "status", permalink]);
  expect(mocks.runtime.log.mock.calls.flat()).toEqual(
    expect.arrayContaining([
      "agent: main",
      `session: ${key}`,
      "active: no",
      "latest task: old-failure (failed)",
      "last activity: 50",
      "last tool: exec",
      "last error: observed failure",
    ]),
  );
  await run(["thread", "resume", permalink]);
  expect(mocks.runtime.exit).toHaveBeenCalledWith(2);
  expect(mocks.callGateway.mock.calls.every(([request]) => request.method !== "agent")).toBe(true);
});
it("reports unavailable history explicitly instead of inventing a task", async () => {
  const state = observation();
  delete state.status;
  respond(state);
  await run(["thread", "status", permalink]);
  expect(mocks.runtime.log.mock.calls.flat()).toEqual(
    expect.arrayContaining([
      "latest task: unknown",
      "last tool: unknown",
      "last error: unknown",
      "task history: unavailable",
    ]),
  );
});
it("reports an unavailable native read as failure without a status success", async () => {
  respond();
  mocks.callGateway.mockImplementation(async ({ method }: { method: string }) => {
    if (method === "sessions.list") return { sessions: [{ key, agentId: "main" }] };
    throw new Error("native history unavailable");
  });
  await run(["thread", "status", permalink]);
  expect(mocks.runtime.log).not.toHaveBeenCalled();
  expect(mocks.runtime.error).toHaveBeenCalledWith(
    expect.stringContaining("native history unavailable"),
  );
  expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
});
