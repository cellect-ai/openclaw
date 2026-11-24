import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect } from "vitest";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
import { createUsageFixture } from "../../agents/test-helpers/usage-fixtures.js";
import type { SessionEntry } from "../../config/sessions.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { runReplyAgent } from "./agent-runner-run.js";
import { rootDir, tempDirs } from "./agent-runner.misc.runreplyagent.test-support.js";
import { type BaseRunOptions, createBaseRun } from "./agent-runner.runreplyagent.test-support.js";

export const requireRecord = createRequireRecord("record", "expected-label-object");

export function sessionFixture(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: "session", updatedAt: Date.now(), ...overrides };
}

export function sessionState(sessionKey: string, sessionEntry: SessionEntry) {
  return { sessionKey, sessionEntry, sessionStore: { [sessionKey]: sessionEntry } };
}

export async function storedSession(
  overrides: Partial<SessionEntry> = {},
  sessionKey = "main",
  tmp = tempDirs.make("openclaw-reply-"),
) {
  const storePath = path.join(tmp, "sessions.json");
  const sessionEntry = sessionFixture(overrides);
  await replaceSessionEntry({ storePath, sessionKey }, sessionEntry);
  return {
    tmp,
    storePath,
    sessionKey,
    sessionEntry,
    scope: { agentId: "main", sessionId: sessionEntry.sessionId, sessionKey, storePath },
    reply: { ...sessionState(sessionKey, sessionEntry), storePath },
  };
}

export function agentRun(options: BaseRunOptions = {}) {
  return createBaseRun({
    ...options,
    run: { agentId: "main", agentDir: path.join(rootDir, "agent"), ...options.run },
  });
}

export function assistantMessage(input: number, output: number, text = "NO_REPLY") {
  return makeAssistantMessageFixture({
    provider: "anthropic",
    api: "anthropic-messages",
    model: "claude-opus-4-6",
    content: [{ type: "text", text }],
    stopReason: "stop",
    errorMessage: undefined,
    usage: createUsageFixture(input, output, input + output),
  });
}

export function flushPlan(overrides: { softThresholdTokens?: number; systemPrompt?: string } = {}) {
  return {
    softThresholdTokens: 4_000,
    reserveTokensFloor: 20_000,
    forceFlushTranscriptBytes: 1_000_000_000,
    prompt: "Pre-compaction memory flush.",
    systemPrompt: "Write durable memory, then reply NO_REPLY.",
    relativePath: "memory/active.md",
    ...overrides,
  };
}

export function channelRun(provider: string, to: string, options: BaseRunOptions = {}) {
  return createBaseRun({
    ...options,
    context: {
      Provider: provider,
      OriginatingTo: to,
      AccountId: "primary",
      MessageSid: "msg",
      ...options.context,
    },
    run: { messageProvider: provider, thinkLevel: "low", ...options.run },
  });
}

export function replyResult<T extends Record<string, unknown>>(text: string, meta: T) {
  return { payloads: [{ text }], meta };
}

export function replyText(result: Awaited<ReturnType<typeof runReplyAgent>>) {
  return (Array.isArray(result) ? result : [result])
    .map((payload) => payload?.text ?? "")
    .join("\n");
}

export function expectReplyText(result: unknown, text: string): void {
  expect(requireRecord(result, "reply result")).toMatchObject({ text });
}
