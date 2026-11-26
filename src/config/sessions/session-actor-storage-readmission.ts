import { acquireSessionActorStorage } from "./session-actor-storage-acquisition.js";
import {
  CHAT_SESSION_STORAGE_ADMISSION_ENDED_MESSAGE,
  isChatSessionStorageAdmissionEnded,
} from "./session-actor-storage-admission.js";
import {
  getSessionActorStorageBinding,
  runWithSessionActorStorage,
  runWithoutSessionActorStorage,
} from "./session-actor-storage-binding.js";

type FreshSessionActorStorageScope = {
  sessionKey: string;
  agentId: string;
  storePath: string;
};

/**
 * A chat-send lifetime that has already released stays on the mailbox that
 * inherited it. Re-acquire that same incognito owner once, outside the dead
 * binding, and keep the replacement current until the queued turn settles.
 */
async function runWithFreshSessionActorStorage<T>(
  scope: FreshSessionActorStorageScope,
  run: () => Promise<T>,
): Promise<T> {
  let active = true;
  const assertCurrent = () => {
    if (!active) {
      throw new Error(CHAT_SESSION_STORAGE_ADMISSION_ENDED_MESSAGE);
    }
  };
  const fresh = await acquireSessionActorStorage(
    {
      sessionKey: scope.sessionKey,
      agentId: scope.agentId,
      storePath: scope.storePath,
    },
    {
      lifetime: { assertCurrent, assertReadable: assertCurrent },
      authority: { assertCurrent, authorize: assertCurrent },
    },
  );
  if (!fresh) {
    return run();
  }
  try {
    return await runWithSessionActorStorage(fresh, run);
  } finally {
    active = false;
    await fresh.actor.release();
  }
}

/** Keep a live binding. Replace only the exact ended chat-send admission. */
export async function runWithCurrentOrFreshSessionActorStorage<T>(
  sessionKey: string,
  run: () => Promise<T>,
): Promise<T> {
  const current = getSessionActorStorageBinding({ sessionKey });
  if (!current) {
    return run();
  }
  try {
    current.authority.assertCurrent();
  } catch (error) {
    if (!isChatSessionStorageAdmissionEnded(error)) {
      throw error;
    }
    return runWithoutSessionActorStorage(() =>
      runWithFreshSessionActorStorage(
        { sessionKey, agentId: current.agentId, storePath: current.path },
        run,
      ),
    );
  }
  return run();
}
