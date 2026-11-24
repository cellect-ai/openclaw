import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ThreadContinuationDescription,
  ThreadContinuationSnapshot,
} from "../../packages/gateway-protocol/src/schema/thread-continuation.js";
import { callGateway } from "../gateway/call.js";
import type { RuntimeEnv } from "../runtime.js";
import { parseSlackThreadPermalink, threadResumeCommand, threadStatusCommand } from "./thread.js";

vi.mock("../gateway/call.js", () => ({ callGateway: vi.fn() }));
const permalink =
  "https://example.slack.com/archives/C123/p1785766836369329?thread_ts=1785541458.788849";
const key = "agent:main:slack:channel:c123:thread:1785541458.788849";
const owner = {
  agentId: "main",
  sessionKey: key,
  sessionId: "owner-generation",
  lifecycleRevision: "revision-1",
};
function observation(): ThreadContinuationDescription {
  const members: ThreadContinuationSnapshot["members"] = [
    {
      ...owner,
      fingerprint: "a".repeat(64),
      status: "failed",
      recoveryPending: false,
      updatedAt: 20,
      endedAt: 20,
      terminalRunId: "failure-1",
    },
  ];
  return {
    complete: true,
    members,
    originalTask: "Full original context\n\n" + "detail ".repeat(500),
    continuation: {
      version: 1,
      gatewayInstance: "native-gateway",
      expiresAt: Date.now() + 60_000,
      owner,
      failedSessionKey: key,
      failedRunId: "failure-1",
      members,
    },
  };
}
const runtime = (): RuntimeEnv => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() });
function gateway(description = observation(), roster: Record<string, unknown> = {}) {
  vi.mocked(callGateway).mockImplementation(async (request) => {
    if (request.method === "sessions.list")
      return { sessions: [{ key, agentId: "main" }], ...roster } as never;
    if (request.method === "sessions.describe") return { threadContinuation: description } as never;
    if (request.method === "agent") return { status: "accepted", runId: "continuation" } as never;
    throw new Error(`Unexpected method: ${request.method}`);
  });
}
const agentCalls = () =>
  vi.mocked(callGateway).mock.calls.filter(([request]) => request.method === "agent");
beforeEach(() => vi.mocked(callGateway).mockReset());

describe("Slack permalink", () => {
  it("uses the original thread timestamp for a reply permalink", () => {
    expect(parseSlackThreadPermalink(permalink)).toMatchObject({
      channelId: "C123",
      threadTs: "1785541458.788849",
      sessionSuffix: ":slack:channel:c123:thread:1785541458.788849",
    });
  });
  it("converts the root message timestamp", () => {
    expect(
      parseSlackThreadPermalink("https://example.slack.com/archives/C123/p1786731202876369")
        .threadTs,
    ).toBe("1786731202.876369");
  });
  it.each(["https://example.com/not-a-thread", "invalid", `${permalink}&thread_ts=invalid`])(
    "rejects malformed references (%s)",
    (url) => {
      // A repeated query parameter uses the first value, as URLSearchParams specifies.
      if (url.includes("&thread_ts="))
        expect(() =>
          parseSlackThreadPermalink(url.replace("thread_ts=1785541458.788849&", "")),
        ).toThrow();
      else expect(() => parseSlackThreadPermalink(url)).toThrow();
    },
  );
});

describe("native thread status and conditional continuation", () => {
  it("reports owner and child native state", async () => {
    const state = observation();
    state.members.push({
      ...state.members[0]!,
      sessionKey: "agent:worker:subagent:child",
      agentId: "worker",
      sessionId: "child-generation",
      status: "queued",
    });
    gateway(state);
    const output = runtime();
    await threadStatusCommand({ permalink, json: true }, output);
    expect(JSON.parse(vi.mocked(output.log).mock.calls[0]![0] as string)).toMatchObject({
      active: true,
      members: [{ sessionKey: key }, { status: "queued" }],
    });
    expect(agentCalls()).toHaveLength(0);
  });
  it("resumes the owning thread with complete original context and exact generation", async () => {
    const state = observation();
    gateway(state);
    const output = runtime();
    await threadResumeCommand({ permalink }, output);
    expect(agentCalls()).toHaveLength(1);
    expect(agentCalls()[0]![0]).toMatchObject({
      method: "agent",
      mode: "backend",
      expectFinal: false,
      params: {
        agentId: "main",
        sessionKey: key,
        expectedExistingSessionId: owner.sessionId,
        expectedExistingSessionLifecycleRevision: owner.lifecycleRevision,
        expectedThreadContinuation: state.continuation,
        replyChannel: "slack",
        replyTo: "C123",
        threadId: "1785541458.788849",
        deliver: true,
        bestEffortDeliver: false,
      },
    });
    expect((agentCalls()[0]![0].params as { message: string }).message).toContain(
      state.originalTask,
    );
    expect(vi.mocked(callGateway).mock.calls.every(([request]) => request.mode === "backend")).toBe(
      true,
    );
  });
  it("keeps one idempotency key for repeated inspection of the same child failure", async () => {
    const state = observation();
    state.continuation!.failedSessionKey = "agent:worker:subagent:child";
    state.continuation!.failedRunId = "child-run";
    gateway(state);
    await threadResumeCommand({ permalink }, runtime());
    state.continuation!.expiresAt += 1;
    state.continuation!.gatewayInstance = "restarted-gateway";
    await threadResumeCommand({ permalink }, runtime());
    const requests = agentCalls().map(([request]) => request.params as Record<string, unknown>);
    expect(requests[0]!.idempotencyKey).toBe(requests[1]!.idempotencyKey);
    expect(requests[0]!.sessionKey).toBe(key);
  });
  it.each([
    "running",
    "queued",
    "recovery",
    "unknown",
    "newer-success",
    "missing-context",
    "incomplete",
  ])("refuses %s", async (kind) => {
    const state = observation();
    if (kind === "running" || kind === "queued") state.members[0]!.status = kind;
    else if (kind === "recovery") state.members[0]!.recoveryPending = true;
    else if (kind === "incomplete") state.complete = false;
    else if (kind === "missing-context") delete state.originalTask;
    else {
      delete state.continuation;
      state.members[0]!.status = kind === "unknown" ? "unknown" : "done";
    }
    gateway(state);
    const output = runtime();
    await threadResumeCommand({ permalink }, output);
    expect(agentCalls()).toHaveLength(0);
    expect(output.exit).toHaveBeenCalledWith(2);
  });
  it.each([{ hasMore: true }, { nextOffset: 128 }, { totalCount: 129 }])(
    "refuses incomplete owner discovery %j",
    async (roster) => {
      gateway(observation(), roster);
      await expect(threadResumeCommand({ permalink }, runtime())).rejects.toThrow("incomplete");
      expect(agentCalls()).toHaveLength(0);
    },
  );
  it("refuses ambiguous owners", async () => {
    gateway(observation(), {
      sessions: [
        { key, agentId: "main" },
        { key: key.replace("agent:main:", "agent:other:"), agentId: "other" },
      ],
    });
    const output = runtime();
    await threadResumeCommand({ permalink }, output);
    expect(output.exit).toHaveBeenCalledWith(2);
    expect(agentCalls()).toHaveLength(0);
  });
  it("does not claim admission when the gateway rejects newer activity after inspection", async () => {
    gateway();
    const original = vi.mocked(callGateway).getMockImplementation()!;
    vi.mocked(callGateway).mockImplementation(async (request) => {
      if (request.method === "agent") throw new Error("Thread continuation changed");
      return original(request);
    });
    const output = runtime();
    await expect(threadResumeCommand({ permalink }, output)).rejects.toThrow("changed");
    expect(output.log).not.toHaveBeenCalled();
  });
});
