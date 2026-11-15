import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { EventEmitter } from "node:events";
import path from "node:path";
import { ClientEvent, MatrixEvent, createClient } from "matrix-js-sdk/lib/matrix.js";
import {
  createChannelIngressQueueForTests,
  observeChannelIngressQueueWrite,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { closeOpenClawStateDatabaseByPathAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { MatrixAdmissionRefusedError } from "../projection-execution.js";
import { registerMatrixClientBridge } from "../sdk/client-event-bridge.js";
import { MatrixDecryptBridge } from "../sdk/decrypt-bridge.js";
import { matrixEventToRaw } from "../sdk/event-helpers.js";
import type { MatrixRawEvent } from "../sdk/types.js";
import { createMatrixIngressMonitor } from "./ingress.js";

const stateDirs: string[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const stateDir of stateDirs.splice(0)) {
      await closeOpenClawStateDatabaseByPathAsync(path.join(stateDir, "state", "openclaw.sqlite"));
    }
    cleanup();
  }),
);

function createQueue() {
  const stateDir = tempDirs.make("matrix-ingress-protocol-");
  stateDirs.push(stateDir);
  return createChannelIngressQueueForTests<{ version: 1; rawEvent: string }>({
    channelId: "matrix",
    accountId: "sut",
    stateDir,
  });
}

it("does not retain SDK protocol receipts or block the following application message", async () => {
  const queue = createQueue();
  const delivered = createDeferred<void>();
  const dispatch = vi.fn(async () => delivered.resolve());
  const onError = vi.fn();
  const monitor = createMatrixIngressMonitor({ accountId: "sut", queue, dispatch, onError });
  const client = createClient({
    baseUrl: "https://matrix.example.org",
    userId: "@sut:example.org",
  });
  const emitter = new EventEmitter();
  const admissions: ReturnType<typeof monitor.receive>[] = [];
  emitter.on("room.message", (roomId: string, event: MatrixRawEvent) => {
    admissions.push(monitor.receive({ roomId, event }));
  });
  registerMatrixClientBridge({
    client,
    emitter,
    decryptBridge: new MatrixDecryptBridge({
      client,
      toRaw: matrixEventToRaw,
      emitDecryptedEvent() {},
      emitMessage() {},
      emitFailedDecryption() {},
    }),
    emitMembershipForRoom() {},
    getSelfUserId: () => "@sut:example.org",
    setCurrentSyncState() {},
  });
  monitor.start();
  try {
    client.emit(
      ClientEvent.Event,
      new MatrixEvent({ room_id: "!room:example.org", type: "m.receipt", content: {} }),
    );
    expect(await Promise.all(admissions.splice(0))).toEqual([{ kind: "ignored" }]);
    expect(await queue.listPending()).toEqual([]);
    const message = new MatrixEvent({
      room_id: "!room:example.org",
      event_id: "$after-receipt",
      sender: "@person:example.org",
      type: "m.room.message",
      origin_server_ts: 12345,
      content: { body: "deliver after receipt", msgtype: "m.text" },
    });
    client.emit(ClientEvent.Event, message);
    expect(await Promise.all(admissions.splice(0))).toEqual([{ kind: "durable" }]);
    await delivered.promise;
    await monitor.waitForIdle();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      "!room:example.org",
      matrixEventToRaw(message, { contentMode: "original" }),
      expect.any(Object),
    );
    expect(onError).not.toHaveBeenCalled();
    expect(await queue.listPending()).toEqual([]);
  } finally {
    await monitor.stop();
    client.removeAllListeners();
  }
});

it("retains a malformed supported message and rejects its dispatch rather than ignoring it", async () => {
  const queue = createQueue();
  const released = observeChannelIngressQueueWrite(queue, "release");
  const dispatch = vi.fn(async () => {});
  const monitor = createMatrixIngressMonitor({
    accountId: "sut",
    queue,
    dispatch,
    onError: vi.fn(),
  });
  monitor.start();
  try {
    expect(
      await monitor.receive({
        roomId: "!room:example.org",
        event: matrixEventToRaw(
          new MatrixEvent({
            room_id: "!room:example.org",
            type: "m.room.message",
            content: { body: "malformed supported event", msgtype: "m.text" },
          }),
        ),
      }),
    ).toEqual({ kind: "durable" });
    expect(await released).toBe(true);
    await monitor.waitForIdle();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await queue.listPending()).toEqual([
      expect.objectContaining({
        id: JSON.stringify(["!room:example.org", ""]),
        attempts: 1,
        lastError: "Invalid Matrix durable ingress event",
      }),
    ]);
  } finally {
    await monitor.stop();
  }
});

it("fails a non-canonical thread event on its first attempt and dispatches the next in its lane", async () => {
  const queue = createQueue();
  const delivered = createDeferred<void>();
  const dispatch = vi.fn(async (_roomId: string, event: MatrixRawEvent) => {
    if (event.event_id === "$off-thread") {
      throw new MatrixAdmissionRefusedError("thread_not_canonical");
    }
    delivered.resolve();
  });
  const monitor = createMatrixIngressMonitor({
    accountId: "sut",
    queue,
    dispatch,
    onError: vi.fn(),
  });
  const event = (eventId: string, ts: number) =>
    matrixEventToRaw(
      new MatrixEvent({
        room_id: "!room:example.org",
        event_id: eventId,
        sender: "@person:example.org",
        type: "m.room.message",
        origin_server_ts: ts,
        content: { body: "text", msgtype: "m.text" },
      }),
    );
  monitor.start();
  try {
    await monitor.receive({ roomId: "!room:example.org", event: event("$off-thread", 1) });
    await monitor.receive({ roomId: "!room:example.org", event: event("$next", 2) });
    await delivered.promise;
    await monitor.waitForIdle();
    expect(dispatch.mock.calls.map(([, raw]) => raw.event_id)).toEqual(["$off-thread", "$next"]);
    expect(await queue.listPending()).toEqual([]);
    expect(await queue.listFailed?.({ limit: "all" })).toEqual([
      expect.objectContaining({
        id: JSON.stringify(["!room:example.org", "$off-thread"]),
        // Failed on its first claim: no retry released it back to the lane.
        attempts: 0,
        reason: "matrix-thread-not-canonical",
        message: "Matrix execution admission refused: thread_not_canonical",
      }),
    ]);
  } finally {
    await monitor.stop();
  }
});
