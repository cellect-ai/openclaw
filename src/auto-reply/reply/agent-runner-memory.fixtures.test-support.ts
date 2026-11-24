import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import {
  registerMemoryCapability,
  type MemoryFlushPlanResolver,
} from "../../plugins/memory-state.test-fixtures.js";

export function createSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: "session", updatedAt: Date.now(), ...overrides };
}

export function createFreshSessionEntry(overrides: Partial<SessionEntry>): SessionEntry {
  return createSessionEntry({ totalTokensFresh: true, totalTokensVersion: 1, ...overrides });
}

export function createFlushSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return createFreshSessionEntry({ totalTokens: 80_000, compactionCount: 1, ...overrides });
}

export function registerMemoryFlushPlanResolverForTest(resolver: MemoryFlushPlanResolver): void {
  registerMemoryCapability("memory-core", { flushPlanResolver: resolver });
}

export function registerClaudeCliBackend(ownsNativeCompaction = false): void {
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        modelProvider: "anthropic",
        pluginId: "anthropic",
        config: { command: "claude" },
        ownsNativeCompaction,
      },
    ],
  });
}

export function loadMainSessionEntry(storePath: string): SessionEntry {
  const entry = loadSessionEntry({ storePath, sessionKey: "main" });
  if (!entry) {
    throw new Error("expected persisted main session entry");
  }
  return entry;
}

export function usageEvent(
  content: string,
  usage: Partial<ReturnType<typeof makeAssistantMessageFixture>["usage"]>,
  api?: string,
) {
  return {
    type: "message",
    message: { role: "assistant", content, usage, ...(api ? { api } : {}) },
  };
}

export function compactionConfig(compaction: AgentDefaultsConfig["compaction"]) {
  return { agents: { defaults: { compaction } } };
}
