import { expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { isDetachedCronSessionTarget } from "../session-target.js";
import { resolveCronSession } from "./session.js";

const NOW_MS = 1_763_000_000_000;
const SESSION_KEY = "agent:cellect-fi-user:hook:fi-shadow:thread";

function freshEntry(sessionId: string, updatedAt: number): SessionEntry {
  return {
    sessionId,
    updatedAt,
    sessionStartedAt: updatedAt,
    lastInteractionAt: updatedAt,
  };
}

function resolveShadowSession(entry: SessionEntry | undefined, forceNew: boolean, nowMs: number) {
  return resolveCronSession({
    cfg: { session: {} },
    sessionKey: SESSION_KEY,
    agentId: "cellect-fi-user",
    nowMs,
    forceNew,
    store: entry ? { [SESSION_KEY]: entry } : {},
    lifecycleTimestamps: {
      sessionStartedAt: entry?.sessionStartedAt,
      lastInteractionAt: entry?.lastInteractionAt,
    },
  });
}

it("keeps a persistent shadow session on one transcript across turns", () => {
  expect(isDetachedCronSessionTarget("session:hook:fi-shadow:thread")).toBe(false);
  expect(isDetachedCronSessionTarget("isolated")).toBe(true);

  const first = resolveShadowSession(freshEntry("shadow-transcript", NOW_MS), false, NOW_MS);
  expect(first.isNewSession).toBe(false);
  expect(first.sessionEntry.sessionId).toBe("shadow-transcript");

  const second = resolveShadowSession(first.sessionEntry, false, NOW_MS + 60_000);
  expect(second.isNewSession).toBe(false);
  expect(second.sessionEntry.sessionId).toBe("shadow-transcript");

  const isolated = resolveShadowSession(second.sessionEntry, true, NOW_MS + 120_000);
  expect(isolated.isNewSession).toBe(true);
  expect(isolated.sessionEntry.sessionId).not.toBe("shadow-transcript");
});
