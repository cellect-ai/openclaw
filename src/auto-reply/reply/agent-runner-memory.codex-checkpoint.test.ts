import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { runSessionCompactionIfNeeded } from "./agent-runner-memory.js";
import { createTestFollowupRun, withTestModelContextTokens } from "./agent-runner.test-fixtures.js";

const { compactEmbeddedAgentSessionMock } = vi.hoisted(() => ({
  compactEmbeddedAgentSessionMock: vi.fn(),
}));

vi.mock("../../agents/embedded-agent-runner/run-entry.js", () => ({
  runEmbeddedAgentEntry: vi.fn(),
}));
vi.mock("../../agents/embedded-agent.js", () => ({
  compactEmbeddedAgentSession: compactEmbeddedAgentSessionMock,
}));

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-codex-checkpoint-");

describe("runSessionCompactionIfNeeded Codex memory checkpoint", () => {
  beforeEach(() => {
    compactEmbeddedAgentSessionMock.mockReset();
  });

  it("runs the memory checkpoint for Codex sessions without host compaction", async () => {
    const rootDir = sessionDirs.make();
    const sessionKey = "main";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      agentRuntimeOverride: "codex",
    };
    const refreshedEntry = { ...sessionEntry, totalTokens: 1 };
    const beforeCompaction = vi.fn(async () => refreshedEntry);
    const followupRun = createTestFollowupRun({
      provider: "openai",
      model: "gpt-5.5",
      sessionId: "session",
      sessionKey,
    });

    const entry = await runSessionCompactionIfNeeded({
      cfg: withTestModelContextTokens({
        cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
        followupRun,
        defaultModel: "gpt-5.5",
        contextTokens: 1_000_000,
      }),
      followupRun,
      defaultModel: "gpt-5.5",
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      storePath: path.join(rootDir, "sessions.json"),
      beforeCompaction,
    });

    expect(beforeCompaction).toHaveBeenCalledTimes(1);
    expect(beforeCompaction).toHaveBeenCalledWith(sessionEntry);
    expect(entry).toBe(refreshedEntry);
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });
});
