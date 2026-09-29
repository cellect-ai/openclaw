import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveAgentRoute,
  type OpenClawConfig,
} from "../test-support/monitor-route-test-support.js";
import { resolveMatrixInboundRoute } from "./monitor/route.js";
import {
  authorizeProjectionReply,
  SOURCE_AUTHORIZED_PROJECTION,
  sendProjectionReplyRejection,
} from "./projection-reply-authorization.js";
import { getMatrixProjectionStatus } from "./projection-source.js";
import {
  removeBindingRecord,
  isMatrixReadOnlyProjectionRoom,
  setBindingRecord,
  type MatrixThreadBindingRecord,
} from "./thread-bindings-shared.js";

const runtime = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../runtime.js", () => ({
  getOptionalMatrixRuntime: () => ({ channel: { runtimeContexts: { get: runtime.get } } }),
}));

const binding: MatrixThreadBindingRecord = {
  accountId: "source-transport",
  conversationId: "$root",
  parentConversationId: "!source:example.test",
  targetKind: "subagent",
  targetSessionKey: "agent:admin:slack:channel:c123:thread:1700000000.000001",
  agentId: "admin",
  boundBy: SOURCE_AUTHORIZED_PROJECTION,
  sourceReplyAuthorization: "fi-v1",
  boundAt: 1,
  lastActivityAt: 1,
};
describe("source-authorized Matrix continuation", () => {
  it("reports denial and outages as idempotent non-dispatching notices", async () => {
    const sendMessage = vi.fn().mockResolvedValue("$notice");
    const params = {
      client: { sendMessage },
      roomId: "!source:example.test",
      messageId: "$attempt",
      threadRootId: "$root",
    };
    await sendProjectionReplyRejection({ ...params, reason: "denied" });
    await sendProjectionReplyRejection({ ...params, reason: "unavailable" });
    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({
      msgtype: "m.notice",
      body: expect.stringContaining("permission"),
      "m.relates_to": { event_id: "$root" },
    });
    expect(sendMessage.mock.calls[1]?.[1]).toMatchObject({
      msgtype: "m.notice",
      body: expect.stringContaining("try again"),
    });
    expect(sendMessage.mock.calls[0]?.[2]).toBe(sendMessage.mock.calls[1]?.[2]);
  });
  afterEach(() => {
    removeBindingRecord(binding);
    runtime.get.mockReset();
  });
  it("routes room-level sends to the same native target while requiring fresh authorization", async () => {
    setBindingRecord(binding);
    expect(binding.boundBy).toBe("session-projection-read-only");
    expect(isMatrixReadOnlyProjectionRoom(binding.accountId, "!source:example.test")).toBe(true);
    const authorize = vi
      .fn()
      .mockResolvedValueOnce("allowed")
      .mockResolvedValueOnce("denied")
      .mockRejectedValueOnce(new Error("offline"));
    const get = runtime.get.mockReturnValue({ protocol: "fi-v1", authorize });
    expect(isMatrixReadOnlyProjectionRoom(binding.accountId, "!source:example.test")).toBe(false);
    const core = { channel: { runtimeContexts: { get } } } as unknown as PluginRuntime;
    const params = {
      core,
      accountId: binding.accountId,
      roomId: binding.parentConversationId!,
      senderId: "@member:example.test",
    };
    await expect(authorizeProjectionReply(params)).resolves.toBe("allowed");
    await expect(authorizeProjectionReply(params)).resolves.toBe("denied");
    await expect(authorizeProjectionReply(params)).resolves.toBe("unavailable");
    get.mockReturnValue(undefined);
    expect(isMatrixReadOnlyProjectionRoom(binding.accountId, "!source:example.test")).toBe(true);
    await expect(authorizeProjectionReply(params)).resolves.toBe("unavailable");
    get.mockReturnValue({ protocol: "unknown-protocol", authorize });
    expect(isMatrixReadOnlyProjectionRoom(binding.accountId, "!source:example.test")).toBe(true);
    await expect(authorizeProjectionReply(params)).resolves.toBe("unavailable");
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main" }, { id: "admin" }] },
      bindings: [{ agentId: "main", match: { channel: "matrix", accountId: binding.accountId } }],
    };
    const route = resolveMatrixInboundRoute({
      cfg,
      accountId: binding.accountId,
      roomId: params.roomId,
      senderId: params.senderId,
      isDirectMessage: false,
      resolveAgentRoute,
    });
    expect(route.route.sessionKey).toBe(binding.targetSessionKey);
    expect(route.route.agentId).toBe("admin");
    expect(getMatrixProjectionStatus(params.roomId)).toMatchObject({
      targetSessionKey: binding.targetSessionKey,
      threadRootEventId: "$root",
      sourceReplyAuthorization: "fi-v1",
    });
  });
});
