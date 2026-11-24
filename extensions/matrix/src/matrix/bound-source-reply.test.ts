import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverBoundSourceReply } from "./bound-source-reply.js";
import { SOURCE_AUTHORIZED_PROJECTION } from "./projection-reply-authorization.js";
import {
  removeBindingRecord,
  setBindingRecord,
  type MatrixThreadBindingRecord,
} from "./thread-bindings-shared.js";

const runtime = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../runtime.js", () => ({
  getOptionalMatrixRuntime: () => ({ channel: { runtimeContexts: { get: runtime.get } } }),
}));

const roomId = "!XKX92xMmIr1GIiZAKX:matrix.cellect.ai";
const sessionKey = "agent:cellect-fi-admin:slack:channel:c0acl2xfrk9:thread:1795024539.012959";
const binding: MatrixThreadBindingRecord = {
  accountId: "shapeadminprod",
  conversationId: "$root",
  parentConversationId: roomId,
  targetKind: "subagent",
  targetSessionKey: sessionKey,
  agentId: "cellect-fi-admin",
  boundBy: SOURCE_AUTHORIZED_PROJECTION,
  sourceReplyAuthorization: "fi-v1",
  sourceAccountId: "fi-admin",
  externalSource: {
    provider: "slack",
    workspaceId: "T09",
    channelId: "C0ACL2XFRK9",
    rootMessageId: "1795024539.012959",
  },
  boundAt: 1,
  lastActivityAt: 1,
};

describe("bound source reply", () => {
  afterEach(() => {
    removeBindingRecord(binding);
    runtime.get.mockReset();
  });

  it("delivers an admitted room reply into the bound Slack thread", async () => {
    setBindingRecord(binding);
    const deliver = vi.fn().mockResolvedValue(undefined);
    runtime.get.mockReturnValue({ deliver });
    await deliverBoundSourceReply({
      matrixAccountId: "shapeadminprod",
      roomId,
      sessionKey,
      triggerEventId: "$yes",
      partIndex: 0,
      text: "The wire details are on file.",
    });
    expect(runtime.get).toHaveBeenCalledWith({
      channelId: "slack",
      accountId: "fi-admin",
      capability: "bound-source-reply",
    });
    expect(deliver).toHaveBeenCalledWith({
      channelId: "C0ACL2XFRK9",
      threadTs: "1795024539.012959",
      text: "The wire details are on file.",
      idempotencyKey: `bound-source-reply:${roomId}:$yes:0`,
    });
  });

  it("leaves a native room reply off the Slack thread", async () => {
    const deliver = vi.fn();
    runtime.get.mockReturnValue({ deliver });
    await deliverBoundSourceReply({
      matrixAccountId: "shapeadminprod",
      roomId,
      sessionKey,
      triggerEventId: "$yes",
      partIndex: 0,
      text: "Only in Fi.",
    });
    expect(deliver).not.toHaveBeenCalled();
  });
});
