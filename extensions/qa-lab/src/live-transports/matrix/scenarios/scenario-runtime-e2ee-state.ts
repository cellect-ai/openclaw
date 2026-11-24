import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type {
  OpenKeyedStoreOptions,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseByPathAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { loadMatrixQaE2eeRuntime } from "../substrate/e2ee-client.js";
import { requestMatrixJson } from "../substrate/request.js";
import type { MatrixQaCliRuntime } from "./scenario-runtime-e2ee-destructive-recovery.js";
import { findMatrixStateDatabases } from "./scenario-runtime-find-files.js";

function withMatrixQaStateStore<T>(
  options: OpenKeyedStoreOptions,
  run: (store: PluginStateSyncKeyedStore<unknown>) => T,
): T {
  try {
    return run(createPluginStateSyncKeyedStoreForTests<unknown>("matrix", options));
  } finally {
    resetPluginStateStoreForTests();
  }
}

export async function findMatrixQaCliAccountRoot(params: {
  accountId?: string;
  deviceId: string;
  runtime: Pick<MatrixQaCliRuntime, "stateDir">;
  userId: string;
}) {
  const storageMetadataRuntime = await loadMatrixQaE2eeRuntime();
  const sqlitePaths = await findMatrixStateDatabases(params.runtime.stateDir);
  for (const sqlitePath of sqlitePaths) {
    if (path.basename(path.dirname(sqlitePath)) !== "state") {
      continue;
    }
    const accountRoot = path.dirname(path.dirname(sqlitePath));
    let metadata: { deviceId?: unknown; userId?: unknown; accountId?: unknown } | null;
    try {
      const store = createPluginStateKeyedStoreForTests<unknown>(
        "matrix",
        storageMetadataRuntime.openMatrixStorageMetaStoreOptions(accountRoot),
      );
      try {
        metadata = storageMetadataRuntime.normalizeMatrixStorageMetadata(
          await store.lookup("current"),
        );
      } finally {
        await closeOpenClawStateDatabaseByPathAsync(
          path.join(accountRoot, "state", "openclaw.sqlite"),
        );
      }
    } catch {
      continue;
    }
    if (
      metadata?.userId === params.userId &&
      metadata.deviceId === params.deviceId &&
      (params.accountId === undefined || metadata.accountId === params.accountId)
    ) {
      return accountRoot;
    }
  }
  throw new Error(`Matrix CLI account storage root was not created for ${params.userId}`);
}

export async function mutateMatrixQaCliStateLoss(params: {
  deviceId: string;
  runtime: Pick<MatrixQaCliRuntime, "stateDir">;
  userId: string;
}) {
  const accountRoot = await findMatrixQaCliAccountRoot(params);
  const matrixRuntime = await loadMatrixQaE2eeRuntime();
  const recoveryKeyStoreOptions = matrixRuntime.openMatrixRecoveryKeyStoreOptions(accountRoot);
  const recoveryKeyState = withMatrixQaStateStore(recoveryKeyStoreOptions, (store) =>
    store.lookup("current"),
  );
  if (!recoveryKeyState) {
    throw new Error("Matrix CLI recovery key state was not created");
  }
  await rm(accountRoot, { force: true, recursive: true });
  await mkdir(accountRoot, { recursive: true });
  withMatrixQaStateStore(recoveryKeyStoreOptions, (store) =>
    store.register("current", recoveryKeyState),
  );
  return accountRoot;
}

export async function corruptMatrixQaCliIdbSnapshot(params: {
  deviceId: string;
  runtime: MatrixQaCliRuntime;
  userId: string;
}) {
  const accountRoot = await findMatrixQaCliAccountRoot(params);
  const matrixRuntime = await loadMatrixQaE2eeRuntime();
  const snapshotStoreOptions = matrixRuntime.openMatrixIdbSnapshotStoreOptions(accountRoot);
  withMatrixQaStateStore(snapshotStoreOptions, (store) =>
    store.register("current:meta", {
      kind: "meta",
      version: 1,
      generation: "corrupt",
      chunkCount: 1,
      digest: "corrupt",
      databaseCount: 1,
      persistedAt: new Date().toISOString(),
    }),
  );
  return {
    path: "matrix/idb-snapshot/current:meta",
    readGeneration: () =>
      withMatrixQaStateStore(snapshotStoreOptions, (store) => {
        const meta = store.lookup("current:meta");
        return meta && typeof meta === "object" && "generation" in meta
          ? meta.generation
          : undefined;
      }),
  };
}

export async function deleteMatrixQaServerRoomKeyBackup(params: {
  accessToken: string;
  baseUrl: string;
  version: string;
}) {
  const response = await requestMatrixJson<Record<string, never>>({
    accessToken: params.accessToken,
    baseUrl: params.baseUrl,
    endpoint: `/_matrix/client/v3/room_keys/version/${encodeURIComponent(params.version)}`,
    method: "DELETE",
    okStatuses: [200, 404],
  });
  return response.status;
}
