import { afterEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  replaceSessionEntry,
  readSessionSubmittedInput,
} from "../config/sessions/session-accessor.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import { registerChatAbortController } from "./chat-abort.js";
import { sessionByKeyReadHandlers } from "./server-methods/sessions-read-by-key.js";
import { requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import {
  seedProjectionRow,
  withSessionRowProjectionState,
} from "./session-row-projection.test-support.js";
import {
  describeThreadContinuation,
  prepareThreadContinuationGuard,
  threadContinuationIdempotencyKey,
} from "./thread-continuation.js";

const key = "agent:main:slack:channel:c123:thread:1785541458.788849";
const originalTask = "Exact original triggering context\n\n" + "synthetic detail ".repeat(250);
afterEach(() => vi.restoreAllMocks());
function withThread(run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  return withSessionRowProjectionState(async (create) => {
    const fixture = await setup(create);
    await run(fixture);
  });
}
async function setup(create: Parameters<Parameters<typeof withSessionRowProjectionState>[0]>[0]) {
  const cfg = { agents: { entries: { main: {} } }, plugins: { enabled: false } };
  setRuntimeConfigSnapshot(cfg);
  const seed = seedProjectionRow(key, {
    sessionId: "thread-generation",
    lifecycleRevision: "revision-1",
    status: "failed",
    lastRunId: "failed-run",
    updatedAt: 100,
    endedAt: 100,
  });
  const initial = createUserTurnTranscriptRecorder({
    input: { text: originalTask, timestamp: 50, idempotencyKey: "failed-run:user" },
    target: { ...seed.scope, sessionEntry: seed.entry },
  });
  await initial.persistApproved();
  await replaceSessionEntry(seed.scope, seed.entry);
  const context = requestContext(cfg);
  const projection = await create({ cfg, context, modelCatalog: [] });
  bindSessionRowProjection(context, () => projection);
  const assertVisible = vi.fn(async (rows) => {
    expect(rows.every((row: { agentId: string }) => row.agentId === "main")).toBe(true);
  });
  const inspect = () =>
    describeThreadContinuation({
      context,
      owner: { agentId: "main", sessionKey: key },
      assertVisible,
      assertCurrent() {},
    });
  const prepare = async () => {
    const result = await inspect();
    expect(result.continuation).toBeDefined();
    const snapshot = result.continuation!;
    const runId = threadContinuationIdempotencyKey(snapshot);
    return {
      snapshot,
      runId,
      guard: await prepareThreadContinuationGuard({ context, snapshot, runId }),
    };
  };
  return { cfg, seed, context, projection, inspect, prepare, assertVisible };
}

describe("native thread continuation condition", () => {
  it("returns full original submitted input only for the exact latest failed run", () =>
    withThread(async ({ inspect, assertVisible }) => {
      const result = await inspect();
      expect(result.originalTask).toBe(originalTask);
      expect(result.continuation).toMatchObject({
        owner: { sessionKey: key, sessionId: "thread-generation", lifecycleRevision: "revision-1" },
        failedRunId: "failed-run",
      });
      expect(assertVisible).toHaveBeenCalledTimes(2);
    }));
  it.each(["done", "unknown", "recovery", "new-input", "missing-original"])(
    "refuses %s without observer fallback",
    (kind) =>
      withThread(async ({ seed, inspect }) => {
        await replaceSessionEntry(seed.scope, {
          ...seed.entry,
          ...(kind === "done"
            ? { status: "done" as const, lastRunId: "new-success", endedAt: 110, updatedAt: 110 }
            : {}),
          ...(kind === "unknown" ? { status: undefined } : {}),
          ...(kind === "new-input" ? { updatedAt: 110 } : {}),
          ...(kind === "missing-original" ? { lastRunId: "uncorrelated-failure" } : {}),
          ...(kind === "recovery"
            ? { resumeAfterRestart: { queuedInputIds: ["recovery-input"] } }
            : {}),
        });
        expect((await inspect()).continuation).toBeUndefined();
      }),
  );
  it("rejects same-incarnation newer success after the observation", () =>
    withThread(async ({ prepare, seed }) => {
      const { guard } = await prepare();
      try {
        await replaceSessionEntry(seed.scope, {
          ...seed.entry,
          status: "done",
          lastRunId: "new-success",
          endedAt: 110,
          updatedAt: 110,
        });
        expect(() => guard.assertCurrent()).toThrow("changed");
      } finally {
        guard.dispose();
      }
    }));
  it("rejects changed child membership", () =>
    withThread(async ({ prepare }) => {
      const { guard } = await prepare();
      try {
        seedProjectionRow("agent:main:subagent:later", {
          sessionId: "later-child",
          parentSessionKey: key,
          status: "done",
          endedAt: 90,
          updatedAt: 90,
        });
        expect(() => guard.assertCurrent()).toThrow();
      } finally {
        guard.dispose();
      }
    }));
  it("rejects new native queued work after the observation", () =>
    withThread(async ({ prepare, seed, projection }) => {
      const { guard } = await prepare();
      const row = projection.selectEntries({ key, agentId: "main" })[0]!;
      const source = registerChatAbortController({
        runId: "new-queued-run",
        sessionId: seed.entry.sessionId,
        sessionKey: key,
        agentId: "main",
        timeoutMs: 60_000,
        target: captureSessionTarget({
          storeScope: row.storeTarget.storePath,
          sessionKey: key,
          agentId: "main",
          incarnation: seed.entry.sessionId,
        }),
      });
      try {
        expect(() => guard.assertCurrent()).toThrow("changed");
      } finally {
        source.cleanup();
        guard.dispose();
      }
    }));
  it("refuses a forged generation and an expired observation", () =>
    withThread(async ({ inspect, context }) => {
      const result = await inspect();
      const snapshot = result.continuation!;
      for (const changed of [
        { ...snapshot, expiresAt: 1 },
        { ...snapshot, owner: { ...snapshot.owner, sessionId: "other-generation" } },
      ]) {
        await expect(
          prepareThreadContinuationGuard({
            context,
            snapshot: changed,
            runId: threadContinuationIdempotencyKey(changed),
          }),
        ).rejects.toThrow("changed");
      }
    }));
  it("keeps the precondition through native input preparation and refuses a changed row before durable append", () =>
    withThread(async ({ prepare, seed }) => {
      const { guard, runId } = await prepare();
      const recorder = createUserTurnTranscriptRecorder({
        target: { ...seed.scope, sessionEntry: seed.entry },
        input: { text: "continue", timestamp: 150, idempotencyKey: `${runId}:user` },
        assertOriginalInputCommit: guard.assertCurrent,
        beforeMessageWrite: (write) => {
          guard.assertCurrent();
          return write.message;
        },
      });
      await replaceSessionEntry(seed.scope, {
        ...seed.entry,
        updatedAt: 120,
        lastRunId: "new-success",
        status: "done",
        endedAt: 120,
      });
      try {
        await expect(recorder.persistApproved()).rejects.toThrow();
        expect(
          await readSessionSubmittedInput(seed.scope, `${runId}:user`, { includeSource: true }),
        ).toBeUndefined();
      } finally {
        guard.dispose();
      }
    }));
});

describe("native pending-input commit consumes the condition", () => {
  it("accepts exactly one durable continuation and permits its own later lifecycle writes", () =>
    withThread(async ({ prepare, seed, projection }) => {
      const { guard, runId } = await prepare();
      const row = projection.selectEntries({ key, agentId: "main" })[0]!;
      const source = registerChatAbortController({
        runId,
        sessionId: seed.entry.sessionId,
        sessionKey: key,
        agentId: "main",
        timeoutMs: 60_000,
        target: captureSessionTarget({
          storeScope: row.storeTarget.storePath,
          sessionKey: key,
          agentId: "main",
          incarnation: seed.entry.sessionId,
        }),
      });
      expect(source.registered).toBe(true);
      if (!source.entry) throw new Error("source unavailable");
      guard.bindSource(source.entry);
      const committed = vi.fn(guard.onPendingInputCommitted);
      const recorder = createUserTurnTranscriptRecorder({
        target: { ...seed.scope, sessionEntry: seed.entry },
        input: { text: "continue original task", timestamp: 150, idempotencyKey: `${runId}:user` },
        assertOriginalInputCommit: guard.assertCurrent,
        onPendingInputCommitted: committed,
        onOriginalInputCommitted: guard.onOriginalInputCommitted,
      });
      try {
        expect(
          await recorder.stageApproved!({
            runId,
            assertCurrent: guard.assertCurrent,
            assertAdmittedCurrent: guard.assertCurrent,
          }),
        ).toBe(true);
        expect(committed).toHaveBeenCalledTimes(1);
        expect(await recorder.stageApproved!({ runId, assertCurrent: guard.assertCurrent })).toBe(
          true,
        );
        expect(committed).toHaveBeenCalledTimes(1);
        expect(
          await readSessionSubmittedInput(seed.scope, `${runId}:user`, { includeSource: true }),
        ).toMatchObject({ source: "pending", message: { content: "continue original task" } });
        await replaceSessionEntry(seed.scope, {
          ...seed.entry,
          updatedAt: 150,
          lifecycleRunId: runId,
        });
        expect(() => guard.assertCurrent()).not.toThrow();
        await recorder.persistApproved();
        expect(
          await readSessionSubmittedInput(seed.scope, `${runId}:user`, { includeSource: true }),
        ).toMatchObject({ source: "transcript" });
      } finally {
        recorder.finishPendingInput?.("interrupted");
        await recorder.waitForPendingInputSettlement?.();
        source.cleanup();
        guard.dispose();
      }
    }));
  it("does not consume the condition on a fabricated receipt or a different run", () =>
    withThread(async ({ prepare }) => {
      const { guard, runId } = await prepare();
      const fake = {
        inputId: "unowned",
        state: "queued" as const,
        message: {
          role: "user" as const,
          content: "continue",
          timestamp: 1,
          idempotencyKey: `${runId}:user`,
        },
        run: <T>(operation: () => T) => operation(),
        finish() {},
      };
      try {
        expect(() => guard.onPendingInputCommitted(fake)).toThrow("changed");
      } finally {
        guard.dispose();
      }
    }));
  it("refuses a newer terminal state arriving during the preparation await without accepting input", () =>
    withThread(async ({ prepare, seed }) => {
      const { guard, runId } = await prepare();
      let finish!: () => void;
      let entered!: () => void;
      const paused = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const recorder = createUserTurnTranscriptRecorder({
        target: { ...seed.scope, sessionEntry: seed.entry },
        resolveInput: async () => {
          entered();
          await paused;
          return { text: "continue", timestamp: 150, idempotencyKey: `${runId}:user` };
        },
        assertOriginalInputCommit: guard.assertCurrent,
        onPendingInputCommitted: guard.onPendingInputCommitted,
      });
      const staging = recorder.stageApproved!({ runId, assertCurrent: guard.assertCurrent });
      void staging.catch(() => undefined);
      await started;
      await replaceSessionEntry(seed.scope, {
        ...seed.entry,
        status: "done",
        lastRunId: "new-success",
        endedAt: 110,
        updatedAt: 110,
      });
      finish();
      try {
        await expect(staging).rejects.toThrow();
        expect(
          await readSessionSubmittedInput(seed.scope, `${runId}:user`, { includeSource: true }),
        ).toBeUndefined();
      } finally {
        guard.dispose();
      }
    }));
});

it("adopts only its native guarded metadata postimage and refuses later independent writes", () =>
  withThread(async ({ prepare, seed }) => {
    const { guard } = await prepare();
    try {
      await patchSessionEntryCore(
        seed.scope,
        (entry) => {
          guard.assertEntry(entry);
          return { ...entry!, updatedAt: 105 };
        },
        { workerGuard: { source: guard.assertCurrent }, onCommitted: guard.onSessionCommitted },
      );
      expect(() => guard.assertCurrent()).not.toThrow();
      await replaceSessionEntry(seed.scope, { ...seed.entry, updatedAt: 110 });
      expect(() => guard.assertCurrent()).toThrow("changed");
    } finally {
      guard.dispose();
    }
  }));

it.each(["webchat-ui", "openclaw-control-ui", "openclaw-browser-copilot"])(
  "does not disclose continuation identity to paired %s claiming backend mode",
  (pairedClientId) =>
    withThread(async ({ context }) => {
      const respond = vi.fn();
      await sessionByKeyReadHandlers["sessions.describe"]!({
        req: { type: "req", id: "describe", method: "sessions.describe" },
        params: { key, agentId: "main", includeThreadContinuation: true },
        context,
        respond,
        client: {
          pairedClientId,
          connect: {
            client: { id: "cli", mode: "backend" },
            role: "operator",
            scopes: ["operator.read", "operator.write"],
          },
        },
      } as never);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
    }),
);
