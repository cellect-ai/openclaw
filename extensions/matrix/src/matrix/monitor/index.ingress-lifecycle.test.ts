import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createChannelIngressQueueForTests,
  closeOpenClawStateDatabaseForTest,
  prepareGatewaySuspendForTest,
  resumeGatewaySuspendForTest,
  resetGatewaySuspendForTest,
  resetGatewayWorkAdmissionForTest,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { getMatrixMonitorIndexTestHarness } from "./index.test-helpers.js";

const harness = getMatrixMonitorIndexTestHarness();
import { monitorMatrixProvider } from "./index.js";

it("registered Matrix monitor retains suspended arrivals and replays them once after replacement", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-suspend-ingress-"));
  harness.ingressQueue = createChannelIngressQueueForTests<{ version: 1; rawEvent: string }>({
    channelId: "matrix",
    accountId: "default",
    stateDir,
  });
  harness.client.hasPersistedSyncState.mockReturnValue(true);
  const delivered = createDeferred<void>();
  const handler = vi.fn(async () => {
    delivered.resolve();
  });
  harness.createMatrixRoomMessageHandler.mockReturnValue(handler);
  const start = async () => {
    const started = createDeferred<void>();
    harness.resolveSharedMatrixClient.mockImplementation(async () => {
      const client = await harness.resolveSharedMatrixClientImpl();
      started.resolve();
      return client;
    });
    const abort = new AbortController();
    const running = monitorMatrixProvider({ abortSignal: abort.signal });
    await started.promise;
    return { abort, running };
  };
  let current: Awaited<ReturnType<typeof start>> | undefined;
  try {
    current = await start();
    const suspension = prepareGatewaySuspendForTest({
      requestId: "matrix-deploy",
      drain: true,
      pauseScheduling() {},
      resumeScheduling() {},
    });
    if (suspension.status !== "ready" && suspension.status !== "draining") {
      throw new Error(`Unexpected suspension status ${suspension.status}`);
    }
    const event = {
      event_id: "$during-suspend",
      sender: "@person:example.org",
      type: "m.room.message",
      origin_server_ts: 12345,
      content: { body: "keep exact sender and time", msgtype: "m.text" },
    };
    await harness.registeredOnRoomMessage!("!room:example.org", event);
    expect(handler).not.toHaveBeenCalled();
    expect(await harness.ingressQueue.listPending()).toHaveLength(1);

    current.abort.abort();
    await current.running;
    harness.state.monitorRetirement = null;
    harness.state.monitorRetirementPromise = null;
    harness.state.leaseAbortController = new AbortController();
    harness.client.hasPersistedSyncState.mockReturnValue(false);
    current = await start();
    expect(handler).not.toHaveBeenCalled();
    expect(resumeGatewaySuspendForTest(suspension.suspensionId).ok).toBe(true);
    await delivered.promise;
    expect(handler).toHaveBeenCalledWith("!room:example.org", event, expect.any(Object));
    await harness.registeredOnRoomMessage!("!room:example.org", event);
    current.abort.abort();
    await current.running;
    expect(handler).toHaveBeenCalledTimes(1);
    current = undefined;
  } finally {
    current?.abort.abort();
    await current?.running;
    resetGatewaySuspendForTest();
    resetGatewayWorkAdmissionForTest();
    harness.ingressQueue = null;
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
