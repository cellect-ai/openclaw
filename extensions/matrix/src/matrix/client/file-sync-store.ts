import { randomUUID } from "node:crypto";
import {
  MemoryStore,
  SyncAccumulator,
  type ISyncData,
  type ISyncResponse,
  type IStoredClientOpts,
} from "matrix-js-sdk/lib/matrix.js";
import { createAsyncLock } from "openclaw/plugin-sdk/async-lock-runtime";
import { materializeErrorStack } from "openclaw/plugin-sdk/error-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getMatrixRuntime } from "../../runtime.js";
import { emitMatrixLog, LogService } from "../sdk/logger.js";
import { claimCurrentTokenStorageState } from "./storage.js";
import {
  MATRIX_SYNC_CACHE_VERSION,
  deleteMatrixSyncCacheStateFromStore,
  openMatrixSyncCacheStoreOptions,
  claimMatrixSyncCacheCleanShutdownInStore,
  readPersistedStoreFromStore,
  writeMatrixSyncCacheStateToStore,
  type MatrixSyncCacheRecord,
  type PersistedMatrixSyncStore,
  type MatrixSyncStoreIdentity,
  type MatrixShutdownCheckpoint,
} from "./sync-cache-state.js";

// A /sync response can retain tens of megabytes of joined-room state. Persist a
// restart checkpoint periodically instead of rewriting that full snapshot on
// every long-poll response. Explicit flushes (including shutdown) remain
// immediate.
const PERSIST_DEBOUNCE_MS = 60_000;

export type MatrixSyncIngressHandler = (
  sync: ISyncResponse,
  context: { hasSavedSync: boolean },
) => Promise<void>;

function syncDataToSyncResponse(syncData: ISyncData): ISyncResponse {
  return {
    next_batch: syncData.nextBatch,
    rooms: syncData.roomsData,
    account_data: {
      events: syncData.accountData,
    },
  };
}

export class SqliteBackedMatrixSyncStore extends MemoryStore {
  private readonly diagnosticId = randomUUID();
  private diagnosticCount = 0;
  private observe(phase: string, facts: Record<string, string | number | boolean> = {}): void {
    if (this.diagnosticCount >= 48) {
      return;
    }
    this.diagnosticCount += 1;
    try {
      emitMatrixLog("debug", "MatrixSyncIngress", [
        JSON.stringify({
          store: this.diagnosticId,
          sequence: this.diagnosticCount,
          phase,
          bound: Boolean(this.syncIngressHandler),
          frozen: this.frozen,
          admissionPending: this.syncIngressAdmission !== null,
          ...facts,
          exhausted: this.diagnosticCount === 48,
        }),
      ]);
    } catch {
      // Diagnostics cannot change sync-cursor custody.
    }
  }
  private readonly persistLock = createAsyncLock();
  private readonly accumulator = new SyncAccumulator();
  private savedSync: ISyncData | null = null;
  private savedClientOptions: IStoredClientOpts | undefined;
  private readonly hadSavedSyncOnLoad: boolean;
  private readonly hadCleanShutdownOnLoad: boolean;
  private cleanShutdown = false;
  private dirty = false;
  private frozen = false;
  private persistTimer: NodeJS.Timeout | null = null;
  private persistPromise: Promise<void> | null = null;
  private syncIngressHandler: MatrixSyncIngressHandler | undefined;
  private syncIngressAdmission: Promise<void> | null = null;

  private readonly storeId: string;
  private readonly restoredCheckpoint: MatrixShutdownCheckpoint | null;
  private checkpoint: MatrixShutdownCheckpoint | undefined;
  private persistenceBarrier?: () => Promise<void>;
  private cleanShutdownClaim: Promise<void> | null = null;
  private cleanShutdownClaimed = false;

  static async create(
    storageRootDir: string,
    identity?: MatrixSyncStoreIdentity,
  ): Promise<SqliteBackedMatrixSyncStore> {
    let store: PluginStateKeyedStore<MatrixSyncCacheRecord, 2> | undefined;
    let persisted: PersistedMatrixSyncStore | null = null;
    let unavailableError: unknown;
    try {
      store = getMatrixRuntime().state.openKeyedStoreV2<MatrixSyncCacheRecord>(
        openMatrixSyncCacheStoreOptions(storageRootDir),
      );
      persisted = await readPersistedStoreFromStore({ storageRootDir, store });
    } catch (error) {
      materializeErrorStack(error);
      unavailableError = error;
      LogService.warn("MatrixSyncCacheStore", "Failed to load Matrix sync cache:", error);
    }
    return new SqliteBackedMatrixSyncStore(
      storageRootDir,
      store,
      persisted,
      unavailableError,
      identity,
    );
  }

  private constructor(
    private readonly storageRootDir: string,
    private readonly store: PluginStateKeyedStore<MatrixSyncCacheRecord, 2> | undefined,
    persisted: PersistedMatrixSyncStore | null,
    private readonly storeUnavailableError: unknown,
    private readonly identity?: MatrixSyncStoreIdentity,
  ) {
    super();
    const restoredSavedSync = persisted?.savedSync ?? null;
    const restoredClientOptions = persisted?.clientOptions;
    const restoredCleanShutdown = persisted?.cleanShutdown === true;

    this.savedSync = restoredSavedSync;
    this.savedClientOptions = restoredClientOptions;
    this.hadSavedSyncOnLoad = restoredSavedSync !== null;
    this.hadCleanShutdownOnLoad = this.hadSavedSyncOnLoad && restoredCleanShutdown;
    this.cleanShutdown = this.hadCleanShutdownOnLoad;
    this.storeId = persisted?.storeId || randomUUID();
    const prior = persisted?.checkpoint;
    const sameIdentity =
      identity &&
      persisted?.identity &&
      identity.accountId === persisted.identity.accountId &&
      identity.homeserver === persisted.identity.homeserver &&
      identity.userId === persisted.identity.userId &&
      identity.deviceId === persisted.identity.deviceId;
    this.restoredCheckpoint =
      this.hadCleanShutdownOnLoad &&
      sameIdentity &&
      prior &&
      prior.accountId === identity.accountId &&
      prior.storeId === this.storeId
        ? Object.freeze({ ...prior })
        : null;

    if (this.savedSync) {
      this.accumulator.accumulate(syncDataToSyncResponse(this.savedSync), true);
      super.setSyncToken(this.savedSync.nextBatch);
    }
    if (this.savedClientOptions) {
      void super.storeClientOptions(this.savedClientOptions);
    }
  }

  hasSavedSync(): boolean {
    return this.hadSavedSyncOnLoad;
  }

  hasSavedSyncFromCleanShutdown(): boolean {
    return this.hadCleanShutdownOnLoad;
  }

  async bindSyncIngress(handler: MatrixSyncIngressHandler): Promise<() => void> {
    if (this.frozen || this.syncIngressHandler) {
      throw new Error("Matrix sync ingress is already bound or the sync store is frozen");
    }
    this.syncIngressHandler = handler;
    this.observe("bound", { savedSync: this.savedSync !== null });
    const dispose = () => {
      if (this.syncIngressHandler === handler) {
        this.observe("unbound");
        this.syncIngressHandler = undefined;
      }
    };
    try {
      if (this.savedSync) {
        const cachedSync = syncDataToSyncResponse(this.savedSync);
        await this.runSyncIngress(() => handler(cachedSync, { hasSavedSync: true }));
      }
    } catch (error) {
      dispose();
      throw error;
    }
    return dispose;
  }

  override setSyncToken(token: string): void {
    // Classic sync assigns its next token before delivering events. Admission
    // owns that advance while bound, including in-memory retries after failure.
    if (!this.frozen && !this.syncIngressHandler) {
      super.setSyncToken(token);
    }
  }

  getCheckpointStatus() {
    return {
      version: 1 as const,
      accountId: this.identity?.accountId,
      storeId: this.storeId,
      restored: this.restoredCheckpoint ? { ...this.restoredCheckpoint } : null,
    };
  }

  setPersistenceBarrier(barrier: () => Promise<void>): void {
    this.persistenceBarrier = barrier;
  }

  override getSavedSync(): Promise<ISyncData | null> {
    return Promise.resolve(this.savedSync ? structuredClone(this.savedSync) : null);
  }

  override getSavedSyncToken(): Promise<string | null> {
    return Promise.resolve(this.savedSync?.nextBatch ?? null);
  }

  override async setSyncData(syncData: ISyncResponse): Promise<void> {
    const eventCount =
      this.diagnosticCount < 48
        ? [
            ...Object.values(syncData.rooms?.join ?? {}),
            ...Object.values(syncData.rooms?.leave ?? {}),
          ].reduce((count, room) => count + (room.timeline?.events?.length ?? 0), 0)
        : 0;
    if (eventCount > 0) {
      this.observe("sync-received", { eventCount });
    }
    if (this.frozen) {
      return;
    }
    await this.claimLoadedCleanShutdown();
    const handler = this.syncIngressHandler;
    if (handler) {
      await this.runSyncIngress(async () => {
        if (eventCount > 0) {
          this.observe("handler-entered");
        }
        await handler(syncData, { hasSavedSync: this.hadSavedSyncOnLoad });
        if (eventCount > 0) {
          this.observe("handler-returned");
        }
        if (!this.frozen) {
          super.setSyncToken(syncData.next_batch);
          this.acceptSyncData(syncData);
          if (eventCount > 0) {
            this.observe("cursor-accepted");
          }
        }
      });
      return;
    }
    this.acceptSyncData(syncData);
    if (eventCount > 0) {
      this.observe("cursor-accepted-unbound");
    }
  }

  /**
   * A restored clean checkpoint is single-use. Retire it durably before this
   * generation admits a newer cursor, so a crash before the next persist cannot
   * present the old proof again. Diagnostic and read-only opens never advance
   * the cursor and therefore keep the evidence.
   */
  private async claimLoadedCleanShutdown(): Promise<void> {
    if (!this.hadCleanShutdownOnLoad || this.cleanShutdownClaimed) {
      return;
    }
    this.cleanShutdownClaim ??= claimMatrixSyncCacheCleanShutdownInStore({
      storageRootDir: this.storageRootDir,
      store: this.requireStore(),
    }).then(
      () => {
        this.cleanShutdownClaimed = true;
      },
      (error: unknown) => {
        this.cleanShutdownClaim = null;
        throw error;
      },
    );
    await this.cleanShutdownClaim;
  }

  private acceptSyncData(syncData: ISyncResponse): void {
    this.accumulator.accumulate(syncData);
    this.savedSync = this.accumulator.getJSON();
    this.markDirtyAndSchedulePersist();
  }

  private runSyncIngress(operation: () => Promise<void>): Promise<void> {
    const pending = Promise.resolve(this.syncIngressAdmission)
      .then(operation)
      .finally(() => {
        if (this.syncIngressAdmission === pending) {
          this.syncIngressAdmission = null;
        }
      });
    this.syncIngressAdmission = pending;
    return pending;
  }

  override getClientOptions() {
    return Promise.resolve(
      this.savedClientOptions ? structuredClone(this.savedClientOptions) : undefined,
    );
  }

  override storeClientOptions(options: IStoredClientOpts) {
    if (this.frozen) {
      return Promise.resolve();
    }
    this.savedClientOptions = structuredClone(options);
    void super.storeClientOptions(options);
    this.markDirtyAndSchedulePersist();
    return Promise.resolve();
  }

  override save(force = false) {
    if (force) {
      return this.flush();
    }
    return Promise.resolve();
  }

  override async deleteAllData(): Promise<void> {
    const store = this.requireStore();
    this.clearPersistTimer();
    this.dirty = false;
    await this.enqueuePersistence(async () => {
      await super.deleteAllData();
      this.savedSync = null;
      this.savedClientOptions = undefined;
      this.cleanShutdown = false;
      this.dirty = false;
      await deleteMatrixSyncCacheStateFromStore({
        storageRootDir: this.storageRootDir,
        store,
      });
    });
  }

  markCleanShutdown(operation?: {
    requestId: string;
    suspensionId: string;
    processInstanceId: string;
  }): void {
    this.cleanShutdown = true;
    this.checkpoint =
      operation && this.identity && this.savedSync
        ? {
            requestId: operation.requestId,
            suspensionId: operation.suspensionId,
            predecessorProcessInstanceId: operation.processInstanceId,
            accountId: this.identity.accountId,
            storeId: this.storeId,
            generation: randomUUID(),
          }
        : undefined;
    this.dirty = true;
  }

  async freezeSyncCursorPersistence(): Promise<void> {
    this.frozen = true;
    this.clearPersistTimer();
    await this.syncIngressAdmission;
    while (this.persistPromise) {
      await this.persistPromise;
    }
  }

  discardPendingSyncCursorPersistence(): void {
    this.frozen = true;
    this.clearPersistTimer();
    this.cleanShutdown = false;
    this.dirty = false;
  }

  async flush(): Promise<void> {
    this.clearPersistTimer();
    while (this.dirty || this.persistPromise) {
      if (this.dirty && !this.persistPromise) {
        void this.enqueuePersistence(() => this.persist());
      }
      await this.persistPromise;
    }
  }

  private clearPersistTimer(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
  }

  private markDirtyAndSchedulePersist(): void {
    if (this.frozen) {
      return;
    }
    this.cleanShutdown = false;
    this.dirty = true;
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush().catch((err: unknown) => {
        LogService.warn("MatrixSyncCacheStore", "Failed to persist Matrix sync store:", err);
      });
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimer.unref?.();
  }

  private async persist(): Promise<void> {
    const store = this.requireStore();
    // Freeze the prefix before joining its async appends. Later SDK batches must
    // retain dirty ownership for their own barrier, never slip into this snapshot.
    this.dirty = false;
    const payload: PersistedMatrixSyncStore = {
      version: MATRIX_SYNC_CACHE_VERSION,
      savedSync: this.savedSync,
      cleanShutdown: this.cleanShutdown,
      storeId: this.storeId,
      identity: this.identity,
      checkpoint: this.checkpoint,
      ...(this.savedClientOptions
        ? { clientOptions: structuredClone(this.savedClientOptions) }
        : {}),
    };
    try {
      await this.persistenceBarrier?.();
      await writeMatrixSyncCacheStateToStore({
        storageRootDir: this.storageRootDir,
        payload,
        store,
        ...(payload.cleanShutdown
          ? {
              beforeCleanPublish: async () => {
                await claimCurrentTokenStorageState({ rootDir: this.storageRootDir });
              },
            }
          : {}),
      });
      if (!payload.cleanShutdown) {
        await claimCurrentTokenStorageState({ rootDir: this.storageRootDir });
      }
    } catch (err) {
      this.dirty = true;
      throw err;
    }
  }

  private enqueuePersistence(operation: () => Promise<void>): Promise<void> {
    const pending = this.persistLock(operation).finally(() => {
      if (this.persistPromise === pending) {
        this.persistPromise = null;
      }
    });
    this.persistPromise = pending;
    return pending;
  }

  private requireStore(): PluginStateKeyedStore<MatrixSyncCacheRecord, 2> {
    if (this.store && this.storeUnavailableError == null) {
      return this.store;
    }
    throw new Error("Matrix sync cache SQLite store is unavailable; cannot persist sync state", {
      cause: this.storeUnavailableError,
    });
  }
}
