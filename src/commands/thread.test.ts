import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  replaceSessionEntrySync,
  replaceTranscriptEventsSync,
} from "../config/sessions/session-accessor.js";
import { callGateway } from "../gateway/call.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { recordSessionStateEvent } from "../sessions/session-state-events.js";
import {
  parseSlackThreadPermalink,
  readThreadTranscriptTail,
  tasksForThread,
  threadResumeCommand,
  threadStatusCommand,
  type ThreadSessionMatch,
} from "./thread.js";

vi.mock("../gateway/call.js", () => ({ callGateway: vi.fn() }));

const tempDirs: string[] = [];

afterEach(async () => {
  await closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.mocked(callGateway).mockClear();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseSlackThreadPermalink", () => {
  it("uses thread_ts for a reply permalink and builds the canonical session suffix", () => {
    expect(
      parseSlackThreadPermalink(
        "https://shape-equity-partners.slack.com/archives/C0BJLAWS49H/p1785766836369329?thread_ts=1785541458.788849&cid=C0BJLAWS49H",
      ),
    ).toMatchObject({
      channelId: "C0BJLAWS49H",
      threadTs: "1785541458.788849",
      sessionSuffix: ":slack:channel:c0bjlaws49h:thread:1785541458.788849",
    });
  });

  it("converts a root permalink timestamp when thread_ts is absent", () => {
    expect(
      parseSlackThreadPermalink(
        "https://shape-equity-partners.slack.com/archives/C0BJLAWS49H/p1786731202876369",
      ).threadTs,
    ).toBe("1786731202.876369");
  });

  it("rejects non-Slack permalink paths", () => {
    expect(() => parseSlackThreadPermalink("https://example.com/not-a-thread")).toThrow(
      "Expected a Slack permalink path",
    );
  });
});

describe("readThreadTranscriptTail", () => {
  it("reads the bounded recent tail from SQLite without materializing a JSONL export", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-thread-command-"));
    tempDirs.push(dir);
    const agentId = "fi-admin";
    const sessionId = "session-thread";
    const sessionKey = "agent:fi-admin:slack:channel:c123:thread:123.456";
    const storePath = path.join(dir, "sessions.json");
    replaceSessionEntrySync(
      { agentId, sessionKey, storePath },
      {
        sessionId,
        updatedAt: 1,
      },
    );
    replaceTranscriptEventsSync({ agentId, sessionId, sessionKey, storePath }, [
      ...Array.from({ length: 201 }, (_, index) => ({
        type: "message",
        timestamp: `2026-09-14T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
        message: {
          role: "toolResult",
          toolName: index === 0 ? "outside-bounded-tail" : `tool-${index}`,
          ...(index === 0 ? { errorMessage: "outside bounded tail" } : {}),
          content: [],
        },
      })),
      {
        type: "message",
        timestamp: "2026-09-14T00:04:00.000Z",
        message: {
          role: "toolResult",
          toolName: "latest-tool",
          content: [],
        },
      },
    ]);

    await expect(
      readThreadTranscriptTail({
        agentId,
        sessionKey,
        storePath,
        entry: { sessionId, updatedAt: 1 },
      }),
    ).resolves.toEqual({
      lastTool: "latest-tool",
      lastToolAt: "2026-09-14T00:04:00.000Z",
      userTexts: [],
    });
    expect(fs.existsSync(storePath)).toBe(false);
    expect(fs.readdirSync(dir).some((name) => name.endsWith(".jsonl"))).toBe(false);
  });
});

const THREAD_PERMALINK =
  "https://shape-equity-partners.slack.com/archives/C123/p1785766836369329?thread_ts=1785541458.788849";
const THREAD_OWNER_KEY = "agent:main:slack:channel:c123:thread:1785541458.788849";

function seedStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-thread-state-"));
  tempDirs.push(dir);
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
}

function threadMatch(
  sessionKey: string,
  entry: Record<string, unknown>,
): ThreadSessionMatch {
  return {
    agentId: "main",
    sessionKey,
    storePath: ":memory:",
    entry: entry as ThreadSessionMatch["entry"],
  };
}

function recordRun(params: {
  sessionKey: string;
  kind: "run_completed" | "run_failed" | "human_direct_message";
  runId?: string;
  outcome?: string;
  occurredAt: number;
}) {
  recordSessionStateEvent({
    sessionKey: params.sessionKey,
    sessionId: `session-${params.sessionKey}`,
    agentId: "main",
    kind: params.kind,
    actorType: params.kind === "human_direct_message" ? "human" : "system",
    summary: `${params.kind} ${params.runId ?? ""}`.trim(),
    ...(params.runId ? { runId: params.runId } : {}),
    ...(params.outcome ? { payload: { outcome: params.outcome } } : {}),
    occurredAt: params.occurredAt,
  });
}

function testRuntime(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

describe("thread run-event port", () => {
  it("ranks a new success above an old failure past the 200-event page cap", () => {
    seedStateDir();
    const base = Date.now() - 3_600_000;
    for (let i = 0; i < 210; i += 1) {
      recordRun({
        sessionKey: THREAD_OWNER_KEY,
        kind: "human_direct_message",
        occurredAt: base + i,
      });
    }
    recordRun({
      sessionKey: THREAD_OWNER_KEY,
      kind: "run_failed",
      runId: "run-old",
      outcome: "error",
      occurredAt: base + 500,
    });
    recordRun({
      sessionKey: THREAD_OWNER_KEY,
      kind: "run_completed",
      runId: "run-new",
      occurredAt: base + 600,
    });
    const tasks = tasksForThread(
      { permalink: "", channelId: "", threadTs: "", sessionSuffix: "" },
      [threadMatch(THREAD_OWNER_KEY, { updatedAt: base + 600 })],
    );
    expect(tasks.map((task) => task.taskId)).toEqual(["run-new", "run-old"]);
    expect(tasks[0]?.status).toBe("succeeded");
    expect(tasks[1]?.status).toBe("failed");
  });

  it("treats a native running entry as live and refuses a duplicate resume", async () => {
    seedStateDir();
    const old = Date.now() - 3_600_000;
    recordRun({
      sessionKey: THREAD_OWNER_KEY,
      kind: "run_failed",
      runId: "run-1",
      outcome: "error",
      occurredAt: old,
    });
    const runtime = testRuntime();
    await threadResumeCommand({ permalink: THREAD_PERMALINK }, runtime, [
      threadMatch(THREAD_OWNER_KEY, { updatedAt: old, status: "running" }),
    ]);
    expect(runtime.exit).toHaveBeenCalledWith(2);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringMatching(/already has active task live:/),
    );
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("refuses resume when gateway recovery owns the session", async () => {
    seedStateDir();
    const old = Date.now() - 3_600_000;
    recordRun({
      sessionKey: THREAD_OWNER_KEY,
      kind: "run_failed",
      runId: "run-1",
      outcome: "error",
      occurredAt: old,
    });
    const runtime = testRuntime();
    await threadResumeCommand({ permalink: THREAD_PERMALINK }, runtime, [
      threadMatch(THREAD_OWNER_KEY, { updatedAt: old, status: "running", abortedLastRun: true }),
    ]);
    expect(runtime.exit).toHaveBeenCalledWith(2);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringMatching(/recovery cycle pending/));
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("fails closed on stale activity with no terminal record", async () => {
    seedStateDir();
    const old = Date.now() - 3_600_000;
    recordRun({ sessionKey: THREAD_OWNER_KEY, kind: "human_direct_message", occurredAt: old });
    const runtime = testRuntime();
    await threadResumeCommand({ permalink: THREAD_PERMALINK }, runtime, [
      threadMatch(THREAD_OWNER_KEY, { updatedAt: old }),
    ]);
    expect(runtime.exit).toHaveBeenCalledWith(2);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringMatching(/No failed task/));
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("fails closed when a newer message supersedes the terminal failure", async () => {
    seedStateDir();
    const old = Date.now() - 3_600_000;
    recordRun({
      sessionKey: THREAD_OWNER_KEY,
      kind: "run_failed",
      runId: "run-1",
      outcome: "error",
      occurredAt: old,
    });
    recordRun({
      sessionKey: THREAD_OWNER_KEY,
      kind: "human_direct_message",
      occurredAt: old + 60_000,
    });
    const runtime = testRuntime();
    await threadResumeCommand({ permalink: THREAD_PERMALINK }, runtime, [
      threadMatch(THREAD_OWNER_KEY, { updatedAt: old + 60_000 }),
    ]);
    expect(runtime.exit).toHaveBeenCalledWith(2);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringMatching(/superseded/));
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("targets the owning thread session even when a child failed more recently", async () => {
    seedStateDir();
    const old = Date.now() - 3_600_000;
    const childKey = "agent:main:subagent:thread-child";
    recordRun({
      sessionKey: THREAD_OWNER_KEY,
      kind: "run_failed",
      runId: "run-owner",
      outcome: "timeout",
      occurredAt: old,
    });
    recordRun({
      sessionKey: childKey,
      kind: "run_failed",
      runId: "run-child",
      outcome: "error",
      occurredAt: old + 60_000,
    });
    vi.mocked(callGateway).mockResolvedValueOnce({ ok: true });
    const runtime = testRuntime();
    const owner = threadMatch(THREAD_OWNER_KEY, { updatedAt: old + 60_000 });
    const child = threadMatch(childKey, { updatedAt: old + 60_000, spawnedBy: THREAD_OWNER_KEY });
    await threadResumeCommand({ permalink: THREAD_PERMALINK }, runtime, [child, owner]);
    expect(callGateway).toHaveBeenCalledTimes(1);
    const request = vi.mocked(callGateway).mock.calls[0]?.[0] as {
      params?: { sessionKey?: string; idempotencyKey?: string };
    };
    expect(request.params?.sessionKey).toBe(THREAD_OWNER_KEY);
    expect(request.params?.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores the observer digest for liveness and resumes the quiet failure", async () => {
    seedStateDir();
    const old = Date.now() - 3_600_000;
    recordRun({
      sessionKey: THREAD_OWNER_KEY,
      kind: "run_failed",
      runId: "run-1",
      outcome: "error",
      occurredAt: old,
    });
    vi.mocked(callGateway).mockResolvedValueOnce({ ok: true });
    const runtime = testRuntime();
    await threadResumeCommand({ permalink: THREAD_PERMALINK }, runtime, [
      threadMatch(THREAD_OWNER_KEY, {
        updatedAt: old,
        observerDigest: {
          sessionKey: THREAD_OWNER_KEY,
          revision: 3,
          updatedAt: old,
          headline: "working",
          health: "on-track",
        },
      }),
    ]);
    expect(callGateway).toHaveBeenCalledTimes(1);
  });

  it("resumes with the complete triggering request, not a later follow-up", async () => {
    seedStateDir();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-thread-store-"));
    tempDirs.push(dir);
    const now = Date.now();
    const terminalAt = now - 3_600_000;
    const trigger = `please reconcile the ledger ${"x".repeat(800)}`;
    const followUp = "are you done yet?";
    const sessionId = "session-thread-owner";
    const storePath = path.join(dir, "sessions.json");
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: THREAD_OWNER_KEY, storePath },
      { sessionId, updatedAt: terminalAt },
    );
    replaceTranscriptEventsSync({ agentId: "main", sessionId, sessionKey: THREAD_OWNER_KEY, storePath }, [
      {
        type: "message",
        timestamp: new Date(terminalAt - 3_600_000).toISOString(),
        message: { role: "user", content: trigger },
      },
      {
        type: "message",
        timestamp: new Date(terminalAt + 1_800_000).toISOString(),
        message: { role: "user", content: followUp },
      },
    ]);
    // Follow-up state event would supersede; keep the log quiet after failure.
    recordRun({
      sessionKey: THREAD_OWNER_KEY,
      kind: "run_failed",
      runId: "run-ctx",
      outcome: "error",
      occurredAt: terminalAt,
    });
    vi.mocked(callGateway).mockResolvedValueOnce({ ok: true });
    const runtime = testRuntime();
    await threadResumeCommand({ permalink: THREAD_PERMALINK }, runtime, [
      {
        agentId: "main",
        sessionKey: THREAD_OWNER_KEY,
        storePath,
        entry: { sessionId, updatedAt: terminalAt } as ThreadSessionMatch["entry"],
      },
    ]);
    expect(callGateway).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(callGateway).mock.calls[0]?.[0] as {
      params?: { message?: string };
    };
    expect(sent.params?.message).toContain(trigger);
    expect(sent.params?.message).not.toContain(followUp);
    expect(trigger.length).toBeGreaterThan(500);
  });

  it("reports the terminal record in status output", async () => {
    seedStateDir();
    const old = Date.now() - 3_600_000;
    recordRun({
      sessionKey: THREAD_OWNER_KEY,
      kind: "run_failed",
      runId: "run-9",
      outcome: "error",
      occurredAt: old,
    });
    const runtime = testRuntime();
    await threadStatusCommand({ permalink: THREAD_PERMALINK, json: true }, runtime, [
      threadMatch(THREAD_OWNER_KEY, { updatedAt: old }),
    ]);
    const logged = vi.mocked(runtime.log).mock.calls[0]?.[0] as string;
    const payload = JSON.parse(logged) as {
      taskCount: number;
      active: boolean;
      latestTask: { taskId: string; status: string } | null;
      lastError: string | null;
    };
    expect(payload.taskCount).toBe(1);
    expect(payload.active).toBe(false);
    expect(payload.latestTask?.taskId).toBe("run-9");
    expect(payload.latestTask?.status).toBe("failed");
    expect(payload.lastError).toContain("run_failed");
  });
});
