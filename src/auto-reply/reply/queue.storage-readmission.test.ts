import { expect, it } from "vitest";
import { memorySessionActorRegistry } from "../../config/sessions/session-actor-memory-registry.js";
import { acquireSessionActorStorage } from "../../config/sessions/session-actor-storage-acquisition.js";
import { CHAT_SESSION_STORAGE_ADMISSION_ENDED_MESSAGE } from "../../config/sessions/session-actor-storage-admission.js";
import {
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
  readCapturedSessionActorEntry,
  runWithSessionActorStorage,
} from "../../config/sessions/session-actor-storage-binding.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import { clearFollowupQueue } from "./queue/state.js";

const sessionKey = "agent:claw-e2e-storage:dashboard:incognito-storage-readmission";
const agentId = "claw-e2e-storage";
const seededSessionId = "storage-readmission-session";

it("runs a queued followup after the incognito chat-send storage admission has ended", async () => {
  resetGatewayWorkAdmission();
  const env = { OPENCLAW_STATE_DIR: "/synthetic/storage-readmission" };
  const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env });
  const target = { agentId, path: storePath };
  const seedAuthority = { assertCurrent() {}, authorize() {} };
  const seedLifetime = { assertCurrent() {}, assertReadable() {} };
  let deadAssert = () => {};
  try {
    const seeded = await acquireSessionActorStorage(
      { sessionKey, agentId, storePath, env },
      { lifetime: seedLifetime, authority: seedAuthority, create: true },
    );
    expect(seeded).toBeDefined();
    expect(
      await seeded!.actor.storage!.mutate(
        {
          type: "session.entry.create",
          input: { entry: { sessionId: seededSessionId, updatedAt: 1 }, cwd: "/synthetic" },
        },
        seedAuthority,
      ),
    ).toMatchObject({ kind: "committed", value: { sessionId: seededSessionId } });
    await seeded!.actor.release();

    let active = true;
    const assertCurrent = () => {
      if (!active) {
        throw new Error(CHAT_SESSION_STORAGE_ADMISSION_ENDED_MESSAGE);
      }
    };
    deadAssert = assertCurrent;
    const closed = await acquireSessionActorStorage(
      { sessionKey, agentId, storePath, env },
      {
        lifetime: { assertCurrent, assertReadable: assertCurrent },
        authority: { assertCurrent, authorize: assertCurrent },
      },
    );
    expect(closed).toBeDefined();

    let observedSessionId: string | undefined;
    const finished = new Promise<void>((resolve, reject) => {
      const runFollowup = async () => {
        try {
          await Promise.resolve();
          const binding = getSessionActorStorageBinding({ sessionKey });
          expect(binding).toBeDefined();
          binding!.authority.assertCurrent();
          expect(deadAssert).toThrow(CHAT_SESSION_STORAGE_ADMISSION_ENDED_MESSAGE);
          const captured = captureSessionActorStorageOwner({ sessionKey, agentId, storePath });
          observedSessionId = readCapturedSessionActorEntry(captured!, sessionKey)?.sessionId;
          expect(observedSessionId).toBe(seededSessionId);
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      void runWithSessionActorStorage(closed!, async () => {
        active = false;
        expect(deadAssert).toThrow(CHAT_SESSION_STORAGE_ADMISSION_ENDED_MESSAGE);
        const queued = enqueueFollowupRun(
          sessionKey,
          createQueueTestRun(
            { prompt: "Synthetic E2E. Reply exactly RESUMED:nonce. Do not use tools." },
            { agentId },
          ),
          { mode: "followup", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
          "none",
          runFollowup,
          true,
        );
        expect(queued).toBe(true);
      }).catch(reject);
    });
    await Promise.race([
      finished,
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("queued followup did not read the incognito session")),
          4000,
        );
      }),
    ]);
    expect(observedSessionId).toBe(seededSessionId);
  } finally {
    clearFollowupQueue(sessionKey);
    memorySessionActorRegistry.closeDatabase(target);
    resetGatewayWorkAdmission();
  }
});
