import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  loadExactSessionEntry,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { isCanonicalSessionTranscriptEntry } from "../../config/sessions/transcript-tree.js";
import { loadCompletedDeliveryReceipt } from "../../infra/outbound/delivery-queue-storage.js";
import {
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
} from "../../infra/outbound/delivery-queue.test-helpers.js";
import type { ResolveOutboundSessionRouteParams } from "../../infra/outbound/outbound-session.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { publishPersonalReviewReport } from "./fi-review-publication.js";

const { roomRead, platformSend, beforeEffect, canonicalThread, routeRead } = vi.hoisted(() => ({
  roomRead: vi.fn(),
  platformSend: vi.fn(),
  beforeEffect: vi.fn(),
  canonicalThread: vi.fn(),
  routeRead:
    vi.fn<
      (
        params: ResolveOutboundSessionRouteParams,
      ) => Promise<import("../../infra/outbound/outbound-session.js").OutboundSessionRoute | null>
    >(),
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
async function reportMessages(threadId?: string) {
  const base = `agent:cellect-fi-user:matrix:channel:${owner.roomId}`;
  const scope = {
    agentId: "cellect-fi-user",
    sessionKey: threadId ? `${base}:thread:${threadId}` : base,
  };
  const session = expectDefined(loadExactSessionEntry(scope), "review destination session");
  return (await loadTranscriptEvents({ ...scope, sessionId: session.entry.sessionId })).filter(
    (event) => isCanonicalSessionTranscriptEntry(event) && event.type === "message",
  );
}
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
  canonicalThread.mockResolvedValue(undefined);
  routeRead.mockImplementation(async ({ threadId }) => {
    const baseSessionKey = `agent:cellect-fi-user:matrix:channel:${owner.roomId}`;
    return {
      baseSessionKey,
      sessionKey: threadId ? `${baseSessionKey}:thread:${threadId}` : baseSessionKey,
      peer: { kind: "channel", id: owner.roomId },
      chatType: "channel",
      from: `matrix:channel:${owner.roomId}`,
      to: `room:${owner.roomId}`,
      ...(threadId != null ? { threadId } : {}),
    };
  });
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
                  thread: true,
                  messageSendingHooks: true,
                  afterCommit: true,
                  reconcileUnknownSend: true,
                },
              },
              sendText: async (input) => {
                await beforeEffect();
                await input.onPlatformSendDispatch?.();
                return platformSend({
                  text: input.text,
                  to: input.to,
                  accountId: input.accountId,
                  ...(input.threadId != null ? { threadId: input.threadId } : {}),
                });
              },
            },
          }),
          groups: { resolveCanonicalThreadId: canonicalThread },
          messaging: { resolveOutboundSessionRoute: routeRead },
          message: {
            durableFinal: {
              capabilities: {
                text: true,
                thread: true,
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
  beforeEffect.mockImplementationOnce(async () => {
    const pending = await loadPendingDeliveries(fixture.tmpDir());
    expect(pending).toHaveLength(1);
    expect(pending[0]?.session).toEqual({
      policyKey: `agent:cellect-fi-user:matrix:channel:${owner.roomId}`,
      agentId: "cellect-fi-user",
      requesterAccountId: "fi-user",
      conversationType: "group",
      conversationKind: "channel",
    });
    expect(pending[0]?.session).not.toHaveProperty("key");
  });
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
  expect(await loadCompletedDeliveryReceipt(key, fixture.tmpDir())).toMatchObject({
    platformMessageId: "$native-report:example.test",
  });
});
it("reuses a completed native receipt without republishing the same job", async () => {
  await publish();
  closeOpenClawStateDatabaseForTest();
  await publish();
  expect(platformSend).toHaveBeenCalledTimes(1);
  expect(await reportMessages()).toEqual([
    expect.objectContaining({
      message: expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: report }],
      }),
    }),
  ]);
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
it("posts the briefing into the room's canonical conversation thread", async () => {
  canonicalThread.mockResolvedValue("$canonical-root:example.test");
  await expect(publish()).resolves.toMatchObject({ messageId: "$native-report:example.test" });
  expect(canonicalThread).toHaveBeenCalledWith(
    expect.objectContaining({ accountId: "fi-user", groupId: owner.roomId }),
  );
  expect(platformSend).toHaveBeenCalledExactlyOnceWith({
    text: report,
    to: owner.roomId,
    accountId: "fi-user",
    threadId: "$canonical-root:example.test",
  });
  expect(await reportMessages("$canonical-root:example.test")).toEqual([
    expect.objectContaining({
      message: expect.objectContaining({ content: [{ type: "text", text: report }] }),
    }),
  ]);
});
it("posts at room level when no canonical thread resolves", async () => {
  canonicalThread.mockRejectedValue(new Error("matrix runtime unavailable"));
  await expect(publish()).resolves.toMatchObject({ messageId: "$native-report:example.test" });
  expect(platformSend).toHaveBeenCalledExactlyOnceWith({
    text: report,
    to: owner.roomId,
    accountId: "fi-user",
  });
});
it("replays a recorded receipt without resolving a thread or republishing", async () => {
  await publish();
  canonicalThread.mockClear();
  closeOpenClawStateDatabaseForTest();
  canonicalThread.mockResolvedValue("$canonical-root:example.test");
  await expect(publish()).resolves.toMatchObject({ messageId: "$native-report:example.test" });
  expect(platformSend).toHaveBeenCalledTimes(1);
  expect(canonicalThread).not.toHaveBeenCalled();
});

it("refuses publication when the native transcript route is unavailable", async () => {
  routeRead.mockResolvedValue(null);
  await expect(publish()).rejects.toThrow("review_publication_route_unavailable");
  expect(platformSend).not.toHaveBeenCalled();
});
it("rechecks the Fi grant after awaiting native transcript routing", async () => {
  const resolve = routeRead.getMockImplementation()!;
  routeRead.mockImplementation(async (params) => {
    const route = await resolve(params);
    current.mockRejectedValue(new Error("review_delivery_forbidden"));
    return route;
  });
  await expect(publish()).rejects.toThrow("review_delivery_forbidden");
  expect(platformSend).not.toHaveBeenCalled();
});
