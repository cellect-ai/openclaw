import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api/CryptoEvent.js";
import "fake-indexeddb/auto";
import { MatrixError } from "matrix-js-sdk/lib/http-api/errors.js";
import type { MatrixClient as MatrixJsSdkClient } from "matrix-js-sdk/lib/matrix.js";
import { SyncApi, SyncState } from "matrix-js-sdk/lib/sync.js";
import type { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixTestRuntime } from "../test-runtime.js";
import { prepareMockMatrixClientStorage } from "./client/shared.test-support.js";
import { createMatrixCryptoApi } from "./sdk/crypto.test-support.js";
import { registerDecryptRetentionTests } from "./sdk/decrypt-retention.test-support.js";
import type { MatrixEventDecryptor } from "./sdk/event.test-support.js";
import {
  FakeMatrixEvent,
  makeDecryptedMessageEvent,
  makeMatrixEvent,
} from "./sdk/event.test-support.js";
import type { MatrixRawEvent } from "./sdk/types.js";

const ROOM = "!room:example.org";

const USER = "@bot:example.org";

const DEVICE = "DEVICE123";

const HOMESERVER = "https://matrix.example.org";

vi.mock("./sdk/joined-room-encryption.js", () => ({
  reconcileJoinedRoomEncryption: vi.fn(async () => undefined),
}));

const createSharedMatrixClientMock = vi.hoisted(() => vi.fn());

const captureReadAuthorityMock = vi.hoisted(() => vi.fn<() => (() => void) | undefined>());

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
    vi.unstubAllEnvs();
  }),
);

vi.mock("./client/create-client.js", () => ({
  createMatrixClient: createSharedMatrixClientMock,
  prepareMatrixClientStorage: prepareMockMatrixClientStorage,
}));

vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>()),
  captureChannelReadAuthority: captureReadAuthorityMock,
}));

beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("matrix-sdk-state-"));
  captureReadAuthorityMock.mockReset();
});

const requireMatrixJsSdkPackage = createRequire(import.meta.url);

type MatrixSyncApiTestInternals = {
  connectionReturnedResolvers?: ReturnType<typeof createDeferred<boolean>>;
};

async function expectAbortError(promise: Promise<unknown>) {
  const err = await promise.catch((caught: unknown) => caught);
  expect(err).toBeInstanceOf(Error);
  expect(err).toMatchObject({ message: "Matrix startup aborted", name: "AbortError" });
}

async function consumeMatrixSecretStorageKey(keyId = "SSSSKEY"): Promise<boolean> {
  const callbacks = (lastCreateClientOpts?.cryptoCallbacks ?? null) as {
    getSecretStorageKey?: (
      params: { keys: Record<string, unknown> },
      name: string,
    ) => Promise<[string, Uint8Array] | null>;
  } | null;
  const result = await callbacks?.getSecretStorageKey?.(
    { keys: { [keyId]: { algorithm: "m.secret_storage.v1.aes-hmac-sha2" } } },
    "m.cross_signing.master",
  );
  return Boolean(result);
}

type TypedClientMembers = {
  startClient: ReturnType<typeof vi.fn<MatrixJsSdkClient["startClient"]>>;
  stopClient: ReturnType<typeof vi.fn<MatrixJsSdkClient["stopClient"]>>;
  initRustCrypto: ReturnType<typeof vi.fn<MatrixJsSdkClient["initRustCrypto"]>>;
  getCrypto: ReturnType<typeof vi.fn<() => unknown>>;
  secretStorage: Pick<
    MatrixJsSdkClient["secretStorage"],
    "getDefaultKeyId" | "getKey" | "checkKey"
  >;
  decryptEventIfNeeded: ReturnType<typeof vi.fn<MatrixEventDecryptor>>;
  syncApi: SyncApi;
};

type MatrixJsClientStub = TypedClientMembers & {
  [
    K in Exclude<keyof ReturnType<typeof createMatrixJsClientMethods>, keyof TypedClientMembers>
  ]: ReturnType<typeof vi.fn>;
} & {
  emit: EventEmitter["emit"];
  on: (eventName: string | symbol, listener: (...args: unknown[]) => void) => MatrixJsClientStub;
};

function createMatrixJsClientMethods(client: EventEmitter) {
  const classicSyncStop = vi.fn(() => {
    queueMicrotask(() => {
      client.emit("sync", SyncState.Stopped, SyncState.Syncing, undefined);
    });
  });
  return {
    classicSyncStop,
    syncApi: Object.assign(Object.create(SyncApi.prototype) as SyncApi, {
      getSyncState: vi.fn(() => SyncState.Syncing),
      stop: classicSyncStop,
    }),
    startClient: vi.fn(async () => {
      queueMicrotask(() => {
        client.emit("sync", "PREPARED", null, undefined);
      });
    }),
    stopClient: vi.fn(),
    initRustCrypto: vi.fn(async () => {}),
    getUserId: vi.fn(() => USER),
    getDeviceId: vi.fn(() => DEVICE),
    getJoinedRooms: vi.fn(async () => ({ joined_rooms: [] })),
    getJoinedRoomMembers: vi.fn(async () => ({ joined: {} })),
    getStateEvent: vi.fn(async (_roomId: string, eventType: string) => {
      if (eventType === "m.room.encryption") {
        throw new MatrixError({ errcode: "M_NOT_FOUND", error: "State event not found" }, 404);
      }
      return {};
    }),
    getAccountData: vi.fn(() => undefined),
    getAccountDataFromServer: vi.fn(async () => null),
    setAccountData: vi.fn(async () => {}),
    getRoomIdForAlias: vi.fn(async () => ({ room_id: "!resolved:example.org" })),
    sendMessage: vi.fn(async () => ({ event_id: "$sent" })),
    resendEvent: vi.fn(async () => ({ event_id: "$resent" })),
    sendEvent: vi.fn(async () => ({ event_id: "$sent-event" })),
    sendStateEvent: vi.fn(async () => ({ event_id: "$state" })),
    redactEvent: vi.fn(async () => ({ event_id: "$redact" })),
    getProfileInfo: vi.fn(async () => ({})),
    getDevices: vi.fn(async () => ({
      devices: [{ device_id: DEVICE, display_name: "OpenClaw" }],
    })),
    joinRoom: vi.fn(async () => ({})),
    mxcUrlToHttp: vi.fn(() => null),
    uploadContent: vi.fn(async () => ({ content_uri: "mxc://example/file" })),
    fetchRoomEvent: vi.fn(async () => ({})),
    getEventMapper: vi.fn(
      () => (raw: Partial<MatrixRawEvent>) =>
        new FakeMatrixEvent({
          roomId: raw.room_id ?? "!mapped:example.org",
          eventId: raw.event_id ?? "$mapped",
          sender: raw.sender ?? "@mapped:example.org",
          type: raw.type ?? "m.room.message",
          ts: raw.origin_server_ts ?? Date.now(),
          content: raw.content ?? {},
          stateKey: raw.state_key,
          unsigned: raw.unsigned,
        }),
    ),
    sendTyping: vi.fn(async () => {}),
    getRoom: vi.fn(() => ({ hasEncryptionStateEvent: () => false })),
    getRooms: vi.fn(() => []),
    getCrypto: vi.fn(() => undefined),
    secretStorage: {
      getDefaultKeyId: vi.fn(async () => null),
      getKey: vi.fn(async () => null),
      checkKey: vi.fn(async () => false),
    },
    decryptEventIfNeeded: vi.fn<MatrixEventDecryptor>(async () => {}),
    relations: vi.fn(async () => ({
      originalEvent: null,
      events: [],
      nextBatch: null,
      prevBatch: null,
    })),
  };
}

function createMatrixJsClientStub(): MatrixJsClientStub {
  const client = new EventEmitter();
  return Object.assign(
    client,
    createMatrixJsClientMethods(client),
  ) as unknown as MatrixJsClientStub;
}

let matrixJsClient = createMatrixJsClientStub();

let lastCreateClientOpts: Record<string, unknown> | null = null;

vi.mock("matrix-js-sdk/lib/matrix.js", async () => {
  const actual = await vi.importActual<typeof import("matrix-js-sdk/lib/matrix.js")>(
    "matrix-js-sdk/lib/matrix.js",
  );
  return {
    ...actual,
    ClientEvent: {
      Event: "event",
      Room: "Room",
      Sync: "sync",
      SyncUnexpectedError: "sync.unexpectedError",
    },
    MatrixEventEvent: { Decrypted: "decrypted" },
    createClient: vi.fn((opts: Record<string, unknown>) => {
      lastCreateClientOpts = opts;
      return matrixJsClient;
    }),
  };
});

const { encodeRecoveryKey } = await import("matrix-js-sdk/lib/crypto-api/recovery-key.js");

const { DecryptionFailureCode } = await import("matrix-js-sdk/lib/crypto-api/index.js");

const { calculateKeyCheck, ServerSideSecretStorageImpl, SECRET_STORAGE_ALGORITHM_V1_AES } =
  await import("matrix-js-sdk/lib/secret-storage.js");

const { MatrixClient: BaseMatrixClient } = await import("./sdk.js");

const startedClients = new Set<InstanceType<typeof BaseMatrixClient>>();

class MatrixClient extends BaseMatrixClient {
  protected override registerBridge(): void {
    super.registerBridge();
    startedClients.add(this);
  }
}

function createSdkClient(options: ConstructorParameters<typeof MatrixClient>[2] = {}) {
  return new MatrixClient(HOMESERVER, "token", options);
}

function createEncryptedSdkClient() {
  return createSdkClient({ encryption: true });
}

async function stopStartedClients(): Promise<void> {
  const clients = [...startedClients];
  startedClients.clear();
  // Retire the client owner before mocks or state disappear; its periodic
  // persistence must not run against the next test's runtime or deleted home.
  await Promise.all(clients.map((client) => client.stopWithoutPersist()));
}

function makeCryptoApi(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...createMatrixCryptoApi(), ...overrides };
}

function mockCryptoApi(overrides: () => Record<string, unknown>) {
  matrixJsClient.getCrypto = vi.fn(() => makeCryptoApi(overrides()));
}

function createCryptoSignalClient(prefix: string) {
  const cryptoStateDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const client = createSdkClient({
    encryption: true,
    idbSnapshotPath: path.join(cryptoStateDir, "crypto-idb-snapshot.json"),
    cryptoDatabasePrefix: path.basename(cryptoStateDir),
  });
  const delivered: string[] = [];
  const cryptoListeners = new Map<string, (...args: unknown[]) => void>();
  mockCryptoApi(() => ({
    on: vi.fn((eventName: string, listener: (...args: unknown[]) => void) => {
      cryptoListeners.set(eventName, listener);
    }),
    bootstrapSecretStorage: vi.fn(consumeMatrixSecretStorageKey),
  }));
  client.on("room.message", (_roomId, event) => delivered.push(event.type));
  return { client, delivered, cryptoListeners };
}

describe("MatrixClient event bridge", () => {
  beforeEach(() => {
    // Split from sdk.test.ts, whose earlier suites installed the runtime that
    // encrypted clients need to take crypto-store ownership.
    installMatrixTestRuntime();
    matrixJsClient = createMatrixJsClientStub();
    lastCreateClientOpts = null;
  });

  afterEach(async () => {
    await stopStartedClients();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("emits room.message only after encrypted events decrypt", async () => {
    const client = createSdkClient();
    const messageEvents: Array<{ roomId: string; type: string }> = [];
    client.on("room.message", (roomId, event) => {
      messageEvents.push({ roomId, type: event.type });
    });
    await client.start();
    const encrypted = makeMatrixEvent();
    const decrypted = makeDecryptedMessageEvent();
    matrixJsClient.emit("event", encrypted);
    expect(messageEvents).toHaveLength(0);
    encrypted.emit("decrypted", decrypted);
    // Simulate a second normal event emission from the SDK after decryption.
    matrixJsClient.emit("event", decrypted);
    expect(messageEvents).toEqual([{ roomId: ROOM, type: "m.room.message" }]);
  });

  it("quiesces and drains decrypt retries before stopping the SDK once", async () => {
    vi.useFakeTimers();
    const client = createSdkClient();
    const delivered: string[] = [];
    client.on("room.message", (_roomId, event) => delivered.push(event.type));
    const encrypted = makeMatrixEvent({ decryptionFailure: true });
    const decrypted = makeDecryptedMessageEvent();
    matrixJsClient.decryptEventIfNeeded = vi.fn(async () => {
      encrypted.emit("decrypted", decrypted);
    });
    await client.start();
    matrixJsClient.emit("event", encrypted);
    encrypted.emit("decrypted", encrypted, new Error("missing room key"));
    await client.drainPendingDecryptions("test shutdown");
    expect(matrixJsClient.stopClient).not.toHaveBeenCalled();
    expect(matrixJsClient.decryptEventIfNeeded).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual(["m.room.message"]);
    const lateEncrypted = makeMatrixEvent({ eventId: "$late", decryptionFailure: true });
    matrixJsClient.emit("event", lateEncrypted);
    lateEncrypted.emit("decrypted", lateEncrypted, new Error("late missing room key"));
    await Promise.resolve();
    expect(matrixJsClient.decryptEventIfNeeded).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual(["m.room.message"]);
    vi.useRealTimers();
    await client.stopAndPersist();
    expect(matrixJsClient.stopClient).toHaveBeenCalledTimes(1);
  });

  it("waits for an SDK decrypt already pending when the event is attached", async () => {
    vi.useFakeTimers();
    const client = createSdkClient();
    const delivered: string[] = [];
    let releaseSdkDecryption: (() => void) | undefined;
    const encrypted = makeMatrixEvent({ eventId: "$pending" });
    const sdkDecryption = new Promise<void>((resolve) => {
      releaseSdkDecryption = () => {
        encrypted.markDecrypted({
          type: "m.room.message",
          content: { msgtype: "m.text", body: "decrypted before shutdown" },
        });
        encrypted.setDecryptionPromise(null);
        encrypted.emit("decrypted", encrypted);
        resolve();
      };
    });
    encrypted.setDecryptionPromise(sdkDecryption);
    client.on("room.message", (_roomId, event) => {
      delivered.push(event.type);
    });
    await client.start();
    matrixJsClient.emit("event", encrypted);
    let drained = false;
    const drain = client.drainPendingDecryptions("test shutdown").then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(delivered).toHaveLength(0);
    expect(matrixJsClient.stopClient).not.toHaveBeenCalled();
    releaseSdkDecryption?.();
    await drain;
    expect(delivered).toEqual(["m.room.message"]);
    expect(matrixJsClient.stopClient).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a never-settling SDK decryption drain", async () => {
    vi.useFakeTimers();
    const client = createSdkClient();
    let rejectSdkDecryption: ((reason?: unknown) => void) | undefined;
    const encrypted = makeMatrixEvent({ eventId: "$pending" });
    encrypted.setDecryptionPromise(
      new Promise<void>((_, reject) => {
        rejectSdkDecryption = reject;
      }),
    );
    await client.start();
    matrixJsClient.emit("event", encrypted);
    const drain = client.drainPendingDecryptions("test shutdown");
    const rejection = expect(drain).rejects.toThrow(
      "Matrix decryption drain did not finish within 5000ms",
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(matrixJsClient.stopClient).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
    rejectSdkDecryption?.(new Error("late SDK decryption failure"));
    await Promise.resolve();
    expect(matrixJsClient.stopClient).not.toHaveBeenCalled();
    await client.stopWithoutPersist();
  });

  it("does not keep retrying terminal historical decryption failures", async () => {
    vi.useFakeTimers();
    const client = createSdkClient();
    const failed: string[] = [];
    client.on("room.failed_decryption", (_roomId, eventValue, error) => {
      failed.push(error.message);
    });
    const encrypted = makeMatrixEvent({
      eventId: "$historical",
      ts: Date.now() - 60_000,
      decryptionFailure: true,
      decryptionFailureReason: DecryptionFailureCode.HISTORICAL_MESSAGE_NO_KEY_BACKUP,
    });
    matrixJsClient.decryptEventIfNeeded = vi.fn(async () => {});
    await client.start();
    matrixJsClient.emit("event", encrypted);
    encrypted.emit("decrypted", encrypted, new Error("historical key missing"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failed).toEqual(["historical key missing"]);
    expect(matrixJsClient.decryptEventIfNeeded).not.toHaveBeenCalled();
  });

  it("retries encrypted events that already failed before the bridge attaches", async () => {
    vi.useFakeTimers();
    const client = createEncryptedSdkClient();
    const failed: string[] = [];
    const delivered: string[] = [];
    client.on("room.failed_decryption", (_roomId, eventValue, error) => {
      failed.push(error.message);
    });
    client.on("room.message", (_roomId, event) => {
      delivered.push(event.type);
    });
    const encrypted = makeMatrixEvent({ decryptionFailure: true });
    matrixJsClient.decryptEventIfNeeded = vi.fn(async () => {
      encrypted.markDecrypted({
        type: "m.room.message",
        content: { msgtype: "m.text", body: "hello" },
      });
    });
    await client.start();
    matrixJsClient.emit("event", encrypted);
    expect(failed).toHaveLength(0);
    expect(delivered).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(matrixJsClient.decryptEventIfNeeded).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual(["m.room.message"]);
  });

  registerDecryptRetentionTests({ createSdkClient, getMatrixJsClient: () => matrixJsClient });

  it("retries an exhausted missing-key decryption when a crypto key signal arrives", async () => {
    vi.useFakeTimers();
    const { client, delivered, cryptoListeners } = createCryptoSignalClient(
      "matrix-sdk-exhausted-retry-",
    );
    const encrypted = makeMatrixEvent({ decryptionFailure: true });
    matrixJsClient.decryptEventIfNeeded = vi.fn(
      async (event: FakeMatrixEvent, options?: { isRetry?: boolean }) => {
        if (!event.shouldAttemptDecryption()) {
          return;
        }
        await event.attemptDecryption(matrixJsClient.getCrypto(), options);
      },
    );
    await client.start();
    try {
      matrixJsClient.emit("event", encrypted);
      encrypted.markDecryptionFailed("missing room key");
      await vi.advanceTimersByTimeAsync(200_000);
      expect(encrypted.attemptDecryption).toHaveBeenCalledTimes(8);
      const deviceUpdate = cryptoListeners.get(CryptoEvent.DevicesUpdated);
      expect(deviceUpdate).toBeTypeOf("function");
      deviceUpdate?.();
      await Promise.resolve();
      expect(encrypted.attemptDecryption).toHaveBeenCalledTimes(8);
      encrypted.attemptDecryption.mockClear();
      encrypted.onAttemptDecryption(() => {
        encrypted.markDecrypted({
          type: "m.room.message",
          content: { msgtype: "m.text", body: "hello" },
        });
      });
      const trigger = cryptoListeners.get("crypto.keyBackupDecryptionKeyCached");
      expect(trigger).toBeTypeOf("function");
      trigger?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(encrypted.attemptDecryption).toHaveBeenCalledTimes(1);
      expect(delivered).toEqual(["m.room.message"]);
    } finally {
      await client.stopWithoutPersist();
    }
  });

  it("does not start duplicate retries when crypto signals fire while retry is in-flight", async () => {
    const { client, delivered, cryptoListeners } = createCryptoSignalClient(
      "matrix-sdk-duplicate-retry-",
    );
    const encrypted = makeMatrixEvent({ decryptionFailure: true });
    const decrypted = makeDecryptedMessageEvent();
    const releaseRetryRef: { current?: () => void } = {};
    encrypted.onAttemptDecryption(
      async () =>
        await new Promise<void>((resolve) => {
          releaseRetryRef.current = () => {
            encrypted.emit("decrypted", decrypted);
            resolve();
          };
        }),
    );
    await client.start();
    try {
      matrixJsClient.emit("event", encrypted);
      encrypted.emit("decrypted", encrypted, new Error("missing room key"));
      const trigger = cryptoListeners.get("crypto.keyBackupDecryptionKeyCached");
      expect(trigger).toBeTypeOf("function");
      trigger?.();
      trigger?.();
      await Promise.resolve();
      expect(encrypted.attemptDecryption).toHaveBeenCalledTimes(1);
      releaseRetryRef.current?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(delivered).toEqual(["m.room.message"]);
    } finally {
      await client.stopWithoutPersist();
    }
  });

  it.each(["live event", "startup replay"])("emits own invites from %s", async (source) => {
    const roomId = source === "live event" ? ROOM : "!pending:example.org";
    if (source === "startup replay") {
      matrixJsClient.getRooms = vi.fn(() => [
        { roomId, getMyMembership: () => "invite" },
        { roomId: "!joined:example.org", getMyMembership: () => "join" },
      ]);
    }
    const client = createSdkClient();
    const invites: string[] = [];
    client.on("room.invite", (room) => invites.push(room));
    await client.start();
    if (source === "live event") {
      matrixJsClient.emit(
        "event",
        makeMatrixEvent({
          eventId: "$invite",
          type: "m.room.member",
          stateKey: USER,
          content: { membership: "invite" },
        }),
      );
    }
    expect(invites).toEqual([roomId]);
  });

  it("emits room.invite when SDK emits Room event with invite membership", async () => {
    const client = createSdkClient();
    const invites: string[] = [];
    client.on("room.invite", (roomId) => {
      invites.push(roomId);
    });

    await client.start();

    matrixJsClient.emit("Room", {
      roomId: "!invite:example.org",
      getMyMembership: () => "invite",
    });

    expect(invites).toEqual(["!invite:example.org"]);
  });

  it("waits for a ready sync state before resolving startup", async () => {
    let releaseSyncReady: (() => void) | undefined;
    matrixJsClient.startClient = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseSyncReady = () => {
          matrixJsClient.emit("sync", "PREPARED", null, undefined);
          resolve();
        };
      });
    });

    const client = createSdkClient();
    let resolved = false;
    const startPromise = client.start().then(() => {
      resolved = true;
    });

    await vi.waitFor(() => {
      if (!releaseSyncReady) {
        throw new Error("expected Matrix sync ready release callback");
      }
    });
    expect(resolved).toBe(false);

    const release = releaseSyncReady;
    if (!release) {
      throw new Error("expected Matrix sync ready release callback");
    }
    release();
    await startPromise;

    expect(resolved).toBe(true);
  });

  it("does not start Matrix RTC membership scans for a headless messaging client", async () => {
    const startMatrixRtc = vi.fn();
    const stopMatrixRtc = vi.fn();
    Object.assign(matrixJsClient, {
      startMatrixRTC: startMatrixRtc,
      matrixRTC: { stop: stopMatrixRtc },
    });
    matrixJsClient.on("sync", startMatrixRtc);
    matrixJsClient.startClient = vi.fn(async () => {
      const rtcCallback = (
        matrixJsClient as unknown as { startMatrixRTC: (...args: unknown[]) => void }
      ).startMatrixRTC;
      matrixJsClient.on("sync", rtcCallback);
      queueMicrotask(() => {
        matrixJsClient.emit("sync", "PREPARED", null, undefined);
      });
    });

    const client = new MatrixClient("https://matrix.example.org", "token");
    await client.start();

    expect(stopMatrixRtc).toHaveBeenCalledOnce();
    expect(startMatrixRtc).not.toHaveBeenCalled();
  });

  it("rejects startup when sync reports an unexpected error before ready", async () => {
    matrixJsClient.startClient = vi.fn(async () => {
      const timer = setTimeout(() => {
        matrixJsClient.emit("sync.unexpectedError", new Error("sync exploded"));
      }, 0);
      timer.unref?.();
    });
    const client = createSdkClient();
    await expect(client.start()).rejects.toThrow("sync exploded");
  });

  it("allows transient startup ERROR to recover into PREPARED", async () => {
    matrixJsClient.startClient = vi.fn(async () => {
      queueMicrotask(() => {
        matrixJsClient.emit("sync", "ERROR", null, new Error("temporary outage"));
        queueMicrotask(() => {
          matrixJsClient.emit("sync", "PREPARED", "ERROR", undefined);
        });
      });
    });
    const client = createSdkClient();
    await expect(client.start()).resolves.toBeUndefined();
  });

  it("rejects structured invalid-token ERROR during startup without waiting for timeout", async () => {
    const invalidToken = Object.assign(new Error("Invalid access token"), {
      statusCode: 401,
      data: { errcode: "M_UNKNOWN_TOKEN" },
    });
    matrixJsClient.startClient = vi.fn(async () => {
      queueMicrotask(() => {
        matrixJsClient.emit("sync", "ERROR", null, { error: invalidToken });
      });
    });
    const client = new MatrixClient(HOMESERVER, "invalid-token");
    await expect(client.start()).rejects.toBe(invalidToken);
  });

  it("aborts before post-ready startup work when shutdown races ready sync", async () => {
    matrixJsClient.startClient = vi.fn(async () => {
      queueMicrotask(() => {
        matrixJsClient.emit("sync", "PREPARED", null, undefined);
      });
    });
    const abortController = new AbortController();
    const client = createSdkClient();
    const bootstrapCryptoSpy = vi.spyOn(
      client as unknown as { bootstrapCryptoIfNeeded: () => Promise<void> },
      "bootstrapCryptoIfNeeded",
    );
    bootstrapCryptoSpy.mockImplementation(async () => {});
    client.on("sync.state", (state) => {
      if (state === "PREPARED") {
        abortController.abort();
      }
    });
    await expectAbortError(client.start({ abortSignal: abortController.signal }));
    expect(bootstrapCryptoSpy).not.toHaveBeenCalled();
  });

  it("times out startup when no ready sync state arrives", async () => {
    vi.useFakeTimers();
    matrixJsClient.startClient = vi.fn(async () => {});
    const client = createSdkClient();
    const startPromise = client.start();
    const startExpectation = expect(startPromise).rejects.toThrow(
      "Matrix client did not reach a ready sync state within 30000ms",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await startExpectation;
  });
});
