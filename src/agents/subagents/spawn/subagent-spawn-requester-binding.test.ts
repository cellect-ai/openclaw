import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent, resetAgentEventsForTest } from "../../../infra/agent-events.js";
import {
  claimAgentRunDelegatedAuthority,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
} from "../../../infra/agent-run-registry.js";
import { buildAgentHookContextChannelFields } from "../../../plugins/hook-agent-context.js";
import {
  mintSubagentRequesterBinding,
  resolveSubagentSpawnedFrom,
} from "./subagent-spawn-requester-binding.js";

const parentKey = "agent:main:matrix:channel:!room:example:thread:$root";
const childKey = "agent:main:subagent:child";
const child = { runId: "child-run", sessionKey: childKey, sessionId: "child-session" };

function admitParent() {
  registerAgentRunContext("parent-run", {
    agentId: "main",
    sessionKey: parentKey,
    sessionId: "parent-session",
  });
  return claimAgentRunDelegatedAuthority({ instanceId: "parent-instance", runId: "parent-run" });
}

function startChild(overrides: Record<string, string> = {}) {
  registerAgentRunContext("child-run", {
    agentId: "main",
    sessionKey: childKey,
    sessionId: "child-session",
    ...overrides,
  });
}

const mint = (overrides: Partial<Parameters<typeof mintSubagentRequesterBinding>[0]> = {}) =>
  mintSubagentRequesterBinding({
    parentRunId: "parent-run",
    childRunId: "child-run",
    childAgentId: "main",
    childSessionKey: childKey,
    childSessionId: "child-session",
    runTimeoutSeconds: 0,
    ...overrides,
  });

describe("sub-agent requester lineage", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
    resetAgentRunRegistryForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is minted only while the parent run holds live delegated authority", () => {
    expect(mint()).toBeUndefined();
    registerAgentRunContext("parent-run", { agentId: "main", sessionKey: parentKey });
    expect(mint()).toBeUndefined();
    const authority = admitParent();
    expect(mint({ parentRunId: undefined })).toBeUndefined();
    expect(mint({ childSessionId: undefined })).toBeUndefined();
    releaseAgentRunDelegatedAuthority(authority);
    expect(mint()).toBeUndefined();
    startChild();
    expect(resolveSubagentSpawnedFrom(child)).toBeUndefined();
  });

  it("projects to the exact child run and session only", () => {
    admitParent();
    mint();
    startChild();
    expect(resolveSubagentSpawnedFrom(child)).toMatchObject({
      parentRunId: "parent-run",
      parentAgentId: "main",
      parentSessionKey: parentKey,
      parentSessionId: "parent-session",
      childRunId: "child-run",
      childSessionKey: childKey,
    });
    for (const other of [
      { ...child, runId: "parent-run" },
      { ...child, sessionKey: parentKey },
      { ...child, sessionId: "other-session" },
      { ...child, sessionId: undefined },
    ]) {
      expect(resolveSubagentSpawnedFrom(other)).toBeUndefined();
    }
    expect(
      buildAgentHookContextChannelFields({ ...child, messageChannel: "matrix" }).spawnedFrom,
    ).toMatchObject({ childRunId: "child-run" });
    expect(
      buildAgentHookContextChannelFields({ ...child, sessionKey: parentKey }).spawnedFrom,
    ).toBeUndefined();
  });

  it("refuses a child whose own run context drifts from what was minted", () => {
    admitParent();
    mint();
    startChild({ agentId: "other" });
    expect(resolveSubagentSpawnedFrom(child)).toBeUndefined();
  });

  it("is revoked on demand, when the child settles, and after its bound", () => {
    admitParent();
    const binding = mint();
    startChild();
    const lineage = resolveSubagentSpawnedFrom(child);
    expect(lineage).toBeDefined();
    binding?.revoke();
    expect(() => lineage?.assertCurrent()).toThrow();
    expect(resolveSubagentSpawnedFrom(child)).toBeUndefined();

    mint();
    const settled = resolveSubagentSpawnedFrom(child);
    emitAgentEvent({ runId: "child-run", stream: "lifecycle", data: { phase: "end" } });
    expect(resolveSubagentSpawnedFrom(child)).toBeDefined();
    emitAgentEvent({
      runId: "child-run",
      stream: "lifecycle",
      data: { phase: "end", executionSettled: true },
    });
    expect(() => settled?.assertCurrent()).toThrow();
    expect(resolveSubagentSpawnedFrom(child)).toBeUndefined();

    vi.useFakeTimers();
    mint({ runTimeoutSeconds: 60 });
    const bounded = resolveSubagentSpawnedFrom(child);
    expect(bounded?.expiresAt).toBe(Date.now() + 60_000);
    vi.advanceTimersByTime(60_000);
    expect(() => bounded?.assertCurrent()).toThrow();
    expect(resolveSubagentSpawnedFrom(child)).toBeUndefined();
  });

  it("never outlives thirty minutes, whatever the run timeout", () => {
    vi.useFakeTimers();
    admitParent();
    mint({ runTimeoutSeconds: 24 * 3600 });
    startChild();
    expect(resolveSubagentSpawnedFrom(child)?.expiresAt).toBe(Date.now() + 30 * 60_000);
  });

  it("replaces an earlier lineage for the same child run", () => {
    admitParent();
    mint();
    startChild();
    const first = resolveSubagentSpawnedFrom(child);
    mint();
    expect(() => first?.assertCurrent()).toThrow();
    expect(resolveSubagentSpawnedFrom(child)).not.toBe(first);
  });
});
