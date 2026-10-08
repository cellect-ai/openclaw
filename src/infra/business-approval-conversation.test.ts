import { describe, expect, it } from "vitest";
import { resolveBusinessApprovalConversation } from "./business-approval-conversation.js";

describe("business approval conversation copy", () => {
  it("describes payment, recipient and publication scope without execution metadata", () => {
    expect(
      resolveBusinessApprovalConversation({
        scope: { kind: "payment", amount: "49.99", currency: "EUR", target: "supplier" },
      }),
    ).toEqual({ title: "Approve a payment", summary: "Pay 49.99 EUR to supplier" });
    expect(
      resolveBusinessApprovalConversation({
        scope: {
          kind: "message-send",
          target: "mail",
          recipientCount: 2,
          recipients: ["one@example.test"],
          audience: "external",
        },
      })?.summary,
    ).toBe("Send to 2 recipients via mail (external): one@example.test, +1 more");
    expect(
      resolveBusinessApprovalConversation({
        scope: { kind: "external-post", target: "investor portal", visibility: "restricted" },
      })?.summary,
    ).toBe("Post restricted to investor portal");
  });
  it("never derives human copy from a standing command grant or diagnostic text", () => {
    expect(
      resolveBusinessApprovalConversation({
        scope: { kind: "standing-grant", automation: "nightly", command: "cat private.txt" },
      }),
    ).toBeUndefined();
    expect(resolveBusinessApprovalConversation({})).toBeUndefined();
  });
  it("rejects oversized, invisible or empty action text instead of silently truncating it", () => {
    for (const summary of ["x".repeat(281), "Pay 49.99\u202e EUR", " ", "Pay\n49.99 EUR"]) {
      expect(
        resolveBusinessApprovalConversation({
          conversation: { title: "Approve a payment", summary },
        }),
      ).toBeUndefined();
    }
    expect(
      resolveBusinessApprovalConversation({
        scope: {
          kind: "message-send",
          target: "x".repeat(128),
          recipientCount: 2,
          recipients: ["a".repeat(128), "b".repeat(128)],
        },
      }),
    ).toBeUndefined();
  });
  it("redacts secrets from explicit business copy before it can reach a conversation", () => {
    const token = `ghp_${"a".repeat(40)}`;
    const copy = resolveBusinessApprovalConversation({
      conversation: { title: "Confirm sharing", summary: `Share the reference ${token}` },
    });
    expect(copy).toBeDefined();
    expect(copy?.summary).not.toContain(token);
  });
});
