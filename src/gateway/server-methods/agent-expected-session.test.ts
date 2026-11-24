import { describe, expect, it } from "vitest";
import type { ThreadContinuationSnapshot } from "../../../packages/gateway-protocol/src/schema/thread-continuation.js";
import {
  assertExpectedExistingSession,
  resolveExpectedExistingSessionConstraint,
  validateExpectedExistingSessionTarget,
} from "./agent-expected-session.js";

const owner = {
  agentId: "main",
  sessionKey: "agent:main:slack:channel:c123:thread:123.456",
  sessionId: "session-1",
  lifecycleRevision: "revision-1",
};
const snapshot: ThreadContinuationSnapshot = {
  version: 1,
  gatewayInstance: "gateway",
  expiresAt: 100,
  owner,
  failedSessionKey: owner.sessionKey,
  failedRunId: "failed-run",
  members: [
    {
      ...owner,
      fingerprint: "a".repeat(64),
      status: "failed",
      recoveryPending: false,
      updatedAt: 1,
      endedAt: 1,
      terminalRunId: "failed-run",
    },
  ],
};
const request = {
  canUseInternalRuntimeHandoff: true,
  expectedExistingSessionId: owner.sessionId,
  expectedExistingSessionLifecycleRevision: owner.lifecycleRevision,
  expectedThreadContinuation: snapshot,
};
describe("expected existing session restriction", () => {
  it("preserves ordinary optional and null revision behavior", () => {
    expect(
      resolveExpectedExistingSessionConstraint({ canUseInternalRuntimeHandoff: true }),
    ).toEqual({ ok: true });
    expect(
      resolveExpectedExistingSessionConstraint({
        canUseInternalRuntimeHandoff: true,
        expectedExistingSessionId: "s",
        expectedExistingSessionLifecycleRevision: null,
      }),
    ).toMatchObject({ ok: true, constraint: { sessionId: "s", lifecycleRevision: null } });
    expect(() =>
      assertExpectedExistingSession({
        constraint: { sessionId: "s", lifecycleRevision: null },
        entry: { sessionId: "s", updatedAt: 1 },
        message: "changed",
      }),
    ).not.toThrow();
    expect(() =>
      assertExpectedExistingSession({
        constraint: { sessionId: "s", lifecycleRevision: null },
        entry: { sessionId: "s", updatedAt: 1, lifecycleRevision: "later" },
        message: "changed",
      }),
    ).toThrow("changed");
  });
  it.each([
    { canUseInternalRuntimeHandoff: false },
    { expectedExistingSessionId: undefined },
    { expectedExistingSessionId: "other" },
    { expectedExistingSessionLifecycleRevision: undefined },
    { expectedExistingSessionLifecycleRevision: "later" },
    { internalRuntimeHandoffId: "other-owner" },
  ])("refuses changed or unauthorized condition %j", (patch) => {
    expect(resolveExpectedExistingSessionConstraint({ ...request, ...patch }).ok).toBe(false);
  });
  it("captures the restriction without granting a different target", () => {
    const result = resolveExpectedExistingSessionConstraint(request);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected accepted condition");
    expect(result.constraint?.threadContinuation).toEqual(snapshot);
    expect(result.constraint?.threadContinuation).not.toBe(snapshot);
    expect(
      validateExpectedExistingSessionTarget({
        constraint: result.constraint,
        requestedSessionKey: owner.sessionKey,
      }),
    ).toBeUndefined();
    expect(
      validateExpectedExistingSessionTarget({
        constraint: result.constraint,
        requestedSessionKey: "agent:other:main",
      }),
    ).toMatch(/owner/);
  });
});
