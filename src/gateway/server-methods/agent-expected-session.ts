import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ThreadContinuationSnapshot } from "../../../packages/gateway-protocol/src/schema/thread-continuation.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  consumeSessionEffectHandoff,
  type SessionEffectInterrupt,
  type SessionEffectRef,
  type SessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import type { ThreadContinuationGuard } from "../thread-continuation.js";

export type ExpectedExistingSessionConstraint = {
  handoffId?: string;
  threadContinuation?: ThreadContinuationSnapshot;
  threadContinuationGuard?: ThreadContinuationGuard;
  sessionId: string;
  lifecycleRevision?: string | null;
};

export class ExpectedExistingSessionChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpectedExistingSessionChangedError";
  }
}

export function resolveExpectedExistingSessionConstraint(params: {
  canUseInternalRuntimeHandoff: boolean;
  expectedExistingSessionId?: unknown;
  expectedThreadContinuation?: ThreadContinuationSnapshot;
  expectedExistingSessionLifecycleRevision?: string | null;
  internalRuntimeHandoffId?: unknown;
}): { ok: true; constraint?: ExpectedExistingSessionConstraint } | { ok: false; error: string } {
  const sessionId = normalizeOptionalString(params.expectedExistingSessionId);
  if (
    params.expectedThreadContinuation &&
    (!sessionId ||
      params.internalRuntimeHandoffId ||
      params.expectedThreadContinuation.owner.sessionId !== sessionId ||
      params.expectedThreadContinuation.owner.lifecycleRevision !==
        params.expectedExistingSessionLifecycleRevision)
  ) {
    return {
      ok: false,
      error:
        "Thread continuation requires its exact existing session generation and cannot use a runtime handoff.",
    };
  }
  if (!sessionId) {
    if (params.expectedExistingSessionLifecycleRevision !== undefined) {
      return {
        ok: false,
        error: "expectedExistingSessionLifecycleRevision requires expectedExistingSessionId.",
      };
    }
    return { ok: true };
  }
  if (!params.canUseInternalRuntimeHandoff) {
    return {
      ok: false,
      error: "expectedExistingSessionId is reserved for backend callers.",
    };
  }
  const handoffId = normalizeOptionalString(params.internalRuntimeHandoffId);
  return {
    ok: true,
    constraint: {
      sessionId,
      ...(params.expectedThreadContinuation
        ? { threadContinuation: structuredClone(params.expectedThreadContinuation) }
        : {}),
      lifecycleRevision: params.expectedExistingSessionLifecycleRevision,
      ...(handoffId ? { handoffId } : {}),
    },
  };
}

export function validateExpectedExistingSessionTarget(params: {
  constraint?: ExpectedExistingSessionConstraint;
  requestedSessionId?: string;
  requestedSessionKey?: string;
}): string | undefined {
  if (!params.constraint) {
    return undefined;
  }
  if (
    params.constraint.threadContinuation &&
    params.requestedSessionKey !== params.constraint.threadContinuation.owner.sessionKey
  )
    return "Thread continuation owner does not match the requested session.";
  if (!params.requestedSessionKey) {
    return "expectedExistingSessionId requires an explicit session key.";
  }
  if (params.requestedSessionId && params.requestedSessionId !== params.constraint.sessionId) {
    return "conflicting session identity constraints.";
  }
  return undefined;
}

export function assertExpectedExistingSession(params: {
  constraint?: ExpectedExistingSessionConstraint;
  entry?: SessionEntry;
  message: string;
}): void {
  params.constraint?.threadContinuationGuard?.assertCurrent();
  params.constraint?.threadContinuationGuard?.assertEntry(params.entry);
  if (
    params.constraint &&
    (params.entry?.sessionId !== params.constraint.sessionId ||
      (params.constraint.lifecycleRevision !== undefined &&
        (params.entry?.lifecycleRevision ?? null) !== params.constraint.lifecycleRevision))
  ) {
    throw new ExpectedExistingSessionChangedError(params.message);
  }
}

export function consumeExpectedSessionWorkAdmission(params: {
  constraint?: ExpectedExistingSessionConstraint;
  target: SessionTarget;
  onInterrupt: SessionEffectInterrupt;
  isSettling?: () => boolean;
  getAbortReason?: () => unknown;
}): SessionEffectRef | undefined {
  const handoffId = params.constraint?.handoffId;
  if (!handoffId) {
    return undefined;
  }
  const lease = consumeSessionEffectHandoff({
    handoffId,
    target: params.target,
    onInterrupt: params.onInterrupt,
    isSettling: params.isSettling,
    getAbortReason: params.getAbortReason,
  });
  if (!lease) {
    throw new Error("session work admission handoff is unavailable");
  }
  return lease;
}
