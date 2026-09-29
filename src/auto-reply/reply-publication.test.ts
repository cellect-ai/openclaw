import { describe, expect, it, vi } from "vitest";
import {
  bindReplyPublication,
  copyReplyPublication,
  resolveReplyPublication,
  emitReplyPublicationAccepted,
  registerReplyPublicationReceiptListener,
  requireReplyPublicationReceipt,
} from "./reply-publication.js";
describe("private reply publication custody", () => {
  it("preserves required producer custody while its durable receipt listener is unavailable", async () => {
    const payload = { text: "answer" };
    bindReplyPublication(
      {},
      { payload, kind: "final", channel: "slack", context: { accountId: "account" } },
    );
    requireReplyPublicationReceipt(payload);
    await expect(
      emitReplyPublicationAccepted(payload, {
        channel: "slack",
        accountId: "account",
        conversationId: "C1",
        messageId: "1.000001",
      }),
    ).rejects.toThrow("preserving producer custody");
  });
  it("freezes distinct UUIDs and original time without content-hash identity", () => {
    const first = { text: "Same" },
      second = { text: "Same" },
      event = {};
    const one = bindReplyPublication(event, {
      payload: first,
      kind: "final",
      channel: "slack",
      runId: "run",
      sessionKey: "session",
    });
    expect(Object.isFrozen(one)).toBe(true);
    expect(resolveReplyPublication(first)).toBe(one);
    expect(resolveReplyPublication({ ...one })).toBeUndefined();
    const two = bindReplyPublication({}, { payload: second, kind: "final" });
    expect(two.publicationId).not.toBe(one.publicationId);
    expect(bindReplyPublication({}, { payload: first, kind: "final" }).publishedAtMs).toBe(
      one.publishedAtMs,
    );
  });
  it("retains custody only through canonical host copying", () => {
    const payload = { text: "answer" },
      event = {};
    bindReplyPublication(event, { payload, kind: "final" });
    const isolated = {};
    copyReplyPublication(event, isolated);
    expect(resolveReplyPublication(isolated)).toBe(resolveReplyPublication(event));
    expect(resolveReplyPublication(JSON.parse(JSON.stringify(payload)))).toBeUndefined();
  });
  it("awaits receipt persistence and rejects forged payload or foreign account", async () => {
    const payload = { text: "answer" };
    bindReplyPublication(
      {},
      { payload, kind: "final", channel: "slack", context: { accountId: "account" } },
    );
    const listener = vi.fn(async () => {});
    const stop = registerReplyPublicationReceiptListener(listener);
    try {
      await emitReplyPublicationAccepted(
        { ...payload },
        { channel: "slack", accountId: "account", conversationId: "C1", messageId: "1.000001" },
      );
      await emitReplyPublicationAccepted(payload, {
        channel: "slack",
        accountId: "foreign",
        conversationId: "C1",
        messageId: "1.000001",
      });
      expect(listener).not.toHaveBeenCalled();
      await emitReplyPublicationAccepted(payload, {
        channel: "slack",
        accountId: "account",
        conversationId: "C1",
        messageId: "1.000001",
      });
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });
});
