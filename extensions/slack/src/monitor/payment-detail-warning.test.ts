// Slack tests cover the deterministic payment-detail warning.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../types.js";
import type { SlackMonitorContext } from "./context.js";
import {
  clearSlackPaymentDetailWarningsForTest,
  detectSlackPaymentDetails,
  maybeWarnSlackPaymentDetails,
  SLACK_PAYMENT_DETAIL_WARNING_TEXT,
} from "./payment-detail-warning.js";

describe("detectSlackPaymentDetails", () => {
  it.each([
    [
      "routing and account",
      "Routing: 021000021 Account: 123456789012",
      ["aba-routing", "bank-account"],
    ],
    ["ABA prefix", "Please use ABA 026009593 for the wire", ["aba-routing"]],
    [
      "account with bank context",
      "Please wire to our bank account 4455667788 today",
      ["bank-account"],
    ],
    ["acct abbreviation", "Checking acct# 000123456789, routing below", ["bank-account"]],
    ["spaced IBAN", "IBAN GB82 WEST 1234 5698 7654 32 please", ["iban"]],
    ["compact IBAN", "Beneficiary DE89370400440532013000", ["iban"]],
    ["SWIFT code", "SWIFT: CHASUS33", ["swift"]],
    ["BIC with branch", "bic DEUTDEFF500 for the transfer", ["swift"]],
  ])("flags %s", (_name, text, expected) => {
    expect(detectSlackPaymentDetails(text).toSorted()).toEqual([...expected].toSorted());
  });

  it.each([
    ["an invoice number near 'routing'", "Invoice #123456789 is routing to Alex for approval"],
    ["a checksum-valid invoice number without banking words", "Invoice 021000021 attached"],
    ["a dashed phone number", "Call me at 212-555-0199 about the account"],
    ["a bare phone number", "Account manager: 2125550199"],
    ["a parenthesized phone number", "Bank rep (212) 555 0199 re: account"],
    ["an accounting account", "QBO account 1234567 for Soho meals"],
    ["an ACH batch id", "ACH batch 123456789 approved"],
    ["an ordinary word near SWIFT", "Send via SWIFT TRANSFER tomorrow"],
    ["an amount", "Wire $1,234,567.00 to the account on file"],
    ["an invalid IBAN", "Ref GB00 WEST 1234 5698 7654 32"],
    ["a date and PO", "PO 4500012345 dated 2026-09-24"],
  ])("ignores %s", (_name, text) => {
    expect(detectSlackPaymentDetails(text)).toEqual([]);
  });
});

describe("maybeWarnSlackPaymentDetails", () => {
  const postMessage = vi.fn(async () => ({ ok: true }));

  function createCtx(enabled = true) {
    return {
      accountId: "fi-admin",
      teamId: "T1",
      cfg: {
        channels: { slack: enabled ? { paymentDetailWarning: true } : {} },
      } as OpenClawConfig,
      app: { client: { chat: { postMessage } } },
      runtime: { error: vi.fn() },
      resolveChannelName: async () => ({ name: "46-coles", type: "channel" }),
      isChannelAllowed: () => true,
    } as unknown as SlackMonitorContext;
  }

  function message(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
    return {
      type: "message",
      channel: "C1",
      channel_type: "channel",
      user: "U_VENDOR",
      ts: "1789000000.000100",
      text: "Our new wire details: routing 021000021, account 123456789012",
      ...overrides,
    } as SlackMessageEvent;
  }

  beforeEach(() => {
    clearSlackPaymentDetailWarningsForTest();
    postMessage.mockClear();
  });

  it("posts one threaded warning that never echoes the numbers", async () => {
    await expect(
      maybeWarnSlackPaymentDetails({ ctx: createCtx(), message: message() }),
    ).resolves.toBe(true);

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      channel: "C1",
      thread_ts: "1789000000.000100",
      text: SLACK_PAYMENT_DETAIL_WARNING_TEXT,
    });
    expect(SLACK_PAYMENT_DETAIL_WARNING_TEXT).not.toMatch(/\d{4,}/u);
  });

  it("warns once per message across accounts and replays", async () => {
    const ctx = createCtx();
    await maybeWarnSlackPaymentDetails({ ctx, message: message() });
    await maybeWarnSlackPaymentDetails({
      ctx: { ...ctx, accountId: "fi-user" },
      message: message(),
    });
    await maybeWarnSlackPaymentDetails({ ctx, message: message() });

    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("replies in the existing thread and scans file titles", async () => {
    await maybeWarnSlackPaymentDetails({
      ctx: createCtx(),
      message: message({
        subtype: "file_share",
        thread_ts: "1788990000.000001",
        text: "see attached",
        files: [
          { id: "F1", title: "IBAN DE89370400440532013000" },
        ] as unknown as SlackMessageEvent["files"],
      }),
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: "1788990000.000001" }),
    );
  });

  it.each([
    ["the setting is off", { enabled: false, overrides: {} }],
    ["the message is a DM", { enabled: true, overrides: { channel: "D1", channel_type: "im" } }],
    ["the message is from a bot", { enabled: true, overrides: { bot_id: "B1" } }],
    ["the message is an edit", { enabled: true, overrides: { subtype: "message_changed" } }],
    ["the message has no bank details", { enabled: true, overrides: { text: "invoice 4455" } }],
  ] as const)("stays quiet when %s", async (_name, { enabled, overrides }) => {
    await maybeWarnSlackPaymentDetails({
      ctx: createCtx(enabled),
      message: message(overrides as Partial<SlackMessageEvent>),
    });

    expect(postMessage).not.toHaveBeenCalled();
  });
});
