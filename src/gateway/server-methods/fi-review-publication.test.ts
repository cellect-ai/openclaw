import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getDeliveryQueueEntryStatus } from "../../infra/delivery-queue-sqlite.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../../infra/outbound/delivery-queue-media-staging.js";
import { installDeliveryQueueTmpDirHooks } from "../../infra/outbound/delivery-queue.test-helpers.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { publishPersonalReviewReport } from "./fi-review-publication.js";

const { roomRead, platformSend, beforeEffect } = vi.hoisted(() => ({
  roomRead: vi.fn(),
  platformSend: vi.fn(),
  beforeEffect: vi.fn(),
}));
vi.mock("./fi-shadow-matrix-room.js", () => ({ readFiUserMatrixRoom: roomRead }));
const fixture = installDeliveryQueueTmpDirHooks();
const owner = {
  ownerEmail: "owner@example.test",
  roomId: "!main:example.test",
  jobId: "review-job",
};
const bot = "@bot_fixture_cellect-fi-user:example.test";
const room = () => ({
  ok: true,
  accountId: "fi-user",
  accountUserId: bot,
  members: ["@owner=40example=2etest:example.test", bot],
});
const report = "1. Review permit.\n\nA. Expedite\nB. Keep waiting";
const key = `review:${"a".repeat(64)}`;
const current = vi.fn();
function publish() {
  return publishPersonalReviewReport({
    getConfig: () => ({}),
    owner,
    resultText: report,
    idempotencyKey: key,
    assertOwnerCurrent: current,
  });
}
beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", fixture.tmpDir());
  vi.clearAllMocks();
  roomRead.mockResolvedValue(room());
  current.mockResolvedValue(undefined);
  platformSend.mockResolvedValue({ channel: "matrix", messageId: "$native-report:example.test" });
  beforeEffect.mockResolvedValue(undefined);
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: {
          ...createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              deliveryCapabilities: {
                durableFinal: {
                  text: true,
                  messageSendingHooks: true,
                  afterCommit: true,
                  reconcileUnknownSend: true,
                },
              },
              sendText: async (input) => {
                await beforeEffect();
                await input.onPlatformSendDispatch?.();
                return platformSend({ text: input.text, to: input.to, accountId: input.accountId });
              },
            },
          }),
          message: {
            durableFinal: {
              capabilities: {
                text: true,
                messageSendingHooks: true,
                afterCommit: true,
                reconcileUnknownSend: true,
              },
              reconcileUnknownSendKinds: { text: true },
              reconcileUnknownSend: async () => null,
            },
          },
        },
      },
    ]),
  );
});
afterEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
  vi.unstubAllEnvs();
});
it("publishes the frozen body through the real durable native owner with identified receipt", async () => {
  await expect(publish()).resolves.toMatchObject({
    path: "direct",
    messageId: "$native-report:example.test",
  });
  expect(platformSend).toHaveBeenCalledExactlyOnceWith({
    text: report,
    to: owner.roomId,
    accountId: "fi-user",
  });
  expect(current.mock.calls.length).toBeGreaterThanOrEqual(4);
  expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, key, fixture.tmpDir())).toBe(
    "completed",
  );
});
it("reuses a completed native receipt without republishing the same job", async () => {
  await publish();
  closeOpenClawStateDatabaseForTest();
  await publish();
  expect(platformSend).toHaveBeenCalledTimes(1);
});
it("rejects a revoked or expired Fi grant before native publication", async () => {
  current.mockRejectedValue(new Error("review_delivery_forbidden"));
  await expect(publish()).rejects.toThrow("review_delivery_forbidden");
  expect(platformSend).not.toHaveBeenCalled();
});
it("rejects another human in the native room", async () => {
  roomRead.mockResolvedValue({
    ...room(),
    members: [...room().members, "@other=40example=2etest:example.test"],
  });
  await expect(publish()).rejects.toThrow("review_publication_audience_changed");
  expect(platformSend).not.toHaveBeenCalled();
});
it("rechecks the current grant at the final provider effect boundary", async () => {
  beforeEffect.mockImplementation(() =>
    current.mockRejectedValue(new Error("review_delivery_forbidden")),
  );
  await expect(publish()).rejects.toThrow("review_delivery_forbidden");
  expect(platformSend).not.toHaveBeenCalled();
});
it("rechecks native membership at the final provider effect boundary", async () => {
  beforeEffect.mockImplementation(() => roomRead.mockResolvedValue({ ...room(), members: [] }));
  await expect(publish()).rejects.toThrow("review_publication_audience_changed");
  expect(platformSend).not.toHaveBeenCalled();
});
it("never reports a missing native identity as a confirmed publication", async () => {
  platformSend.mockResolvedValue({ channel: "matrix" });
  await expect(publish()).rejects.toThrow();
});
it("closes a Fi grant revoked while the native audience read is in flight", async () => {
  roomRead.mockImplementation(async () => {
    current.mockRejectedValue(new Error("review_delivery_forbidden"));
    return room();
  });
  await expect(publish()).rejects.toThrow("review_delivery_forbidden");
  expect(platformSend).not.toHaveBeenCalled();
});
it("rejects a changed native account at the final provider effect boundary", async () => {
  beforeEffect.mockImplementation(() =>
    roomRead.mockResolvedValue({ ...room(), accountId: "other" }),
  );
  await expect(publish()).rejects.toThrow("review_publication_audience_changed");
  expect(platformSend).not.toHaveBeenCalled();
});
it("never resends a prior unknown native publication", async () => {
  platformSend.mockRejectedValue(
    Object.assign(new Error("provider timeout"), { code: "ETIMEDOUT" }),
  );
  await expect(publish()).rejects.toThrow();
  await expect(publish()).rejects.toThrow();
  current.mockRejectedValue(new Error("review_delivery_forbidden"));
  await expect(publish()).rejects.toThrow();
  expect(platformSend).toHaveBeenCalledTimes(1);
});
