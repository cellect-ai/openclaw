import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach } from "vitest";
import { NOTICE_STORE_OPTIONS, type NoticeOperations } from "./notice-operation-api.js";

/** Actual worker-backed state, isolated from both other fixtures and deployed state. */
export function useNoticeStores() {
  // Native option signatures are process-wide; each completed case owns its policy.
  afterEach(() => resetPluginStateStoreForTests({ closeDatabase: false }));
  const dirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterAll(async () => {
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests({ closeDatabase: false });
      cleanup();
    }),
  );
  return (maxEntries = NOTICE_STORE_OPTIONS.maxEntries, assertCurrent = () => {}) => {
    const options = {
      ...NOTICE_STORE_OPTIONS,
      maxEntries,
      env: { OPENCLAW_STATE_DIR: dirs.make("fi-user-notice-") },
    };
    const store = createPluginStateKeyedStoreForTests<unknown>("fi-user", options);
    const operation = store.createOperation<NoticeOperations>(
      [store],
      { moduleName: "notice-operation-api.js", exportName: "runNoticeOperation" },
      { assertCurrent },
    );
    return { options, store, operation };
  };
}
