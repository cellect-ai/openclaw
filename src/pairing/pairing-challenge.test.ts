import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import {
  issuePairingChallenge,
  PAIRING_REPLY_INTERVAL_MS,
  resetPairingReplyThrottle,
} from "./pairing-challenge.js";

async function issue(
  code: string,
  overrides: Partial<Parameters<typeof issuePairingChallenge>[0]> = {},
  created = true,
) {
  const result = await issuePairingChallenge({
    channel: "forum",
    senderId: "123",
    senderIdLine: "Your forum user id: 123",
    upsertPairingRequest: async () => ({ code, created }),
    sendPairingReply: async () => {},
    ...overrides,
  });
  expect(result).toEqual(
    created ? { created: true, code } : { created: false, ...(code ? { code } : {}) },
  );
}
function hooks(...entries: Parameters<typeof createMockPluginRegistry>[0]) {
  initializeGlobalHookRunner(createMockPluginRegistry(entries));
}

afterEach(() => {
  resetGlobalHookRunner();
  resetPairingReplyThrottle();
  vi.useRealTimers();
});

it("notifies and replies only when creating a request, preserving metadata and context", async () => {
  const handler = vi.fn(async () => {});
  hooks({ hookName: "channel_pairing_requested", handler });
  const meta = { name: "alice" };
  const sendPairingReply = vi.fn(async (_text: string) => {});
  const onCreated = vi.fn();
  const upsertPairingRequest = vi.fn(async () => ({ code: "1111", created: true }));
  const options = { accountId: "alerts", meta, onCreated, sendPairingReply };
  await issue("1111", {
    ...options,
    upsertPairingRequest,
    buildReplyText: ({ code }) => `custom ${code}`,
  });
  await issue("EXISTS12", options, false);
  expect(upsertPairingRequest).toHaveBeenCalledWith({ id: "123", meta });
  expect(onCreated).toHaveBeenCalledExactlyOnceWith({ code: "1111" });
  expect(sendPairingReply.mock.calls).toEqual([["custom 1111"]]);
  expect(handler).toHaveBeenCalledExactlyOnceWith(
    { channel: "forum", accountId: "alerts", senderId: "123", code: "1111", metadata: meta },
    { channelId: "forum", accountId: "alerts", senderId: "123" },
  );
});

it("captures reply errors through onReplyError", async () => {
  const error = new Error("send failed");
  const onReplyError = vi.fn();
  await issue("9999", {
    onReplyError,
    sendPairingReply: () => Promise.reject(error),
  });
  expect(onReplyError).toHaveBeenCalledExactlyOnceWith(error);
});

it("does not block pairing replies when pairing-request hooks fail or stall", async () => {
  const throwingHook = vi.fn(() => {
    throw new Error("notification failed");
  });
  const stallingHook = vi.fn(() => new Promise<void>(() => {}));
  hooks(
    { hookName: "channel_pairing_requested", handler: throwingHook, pluginId: "throwing" },
    { hookName: "channel_pairing_requested", handler: stallingHook, pluginId: "stalling" },
  );
  const sendPairingReply = vi.fn(async () => {});

  await issue("FAST1234", { sendPairingReply });
  expect(throwingHook).toHaveBeenCalledTimes(1);
  expect(stallingHook).toHaveBeenCalledTimes(1);
  expect(sendPairingReply).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("FAST1234"));
});

describe("issuePairingChallenge reply throttling", () => {
  const startMs = Date.UTC(2026, 0, 1);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(startMs);
    resetPairingReplyThrottle();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetPairingReplyThrottle();
  });

  function createRepeatSenderHarness() {
    const sent: string[] = [];
    const onReminded = vi.fn();
    let created = true;
    const sendDirectMessage = async () =>
      await issuePairingChallenge({
        channel: "forum",
        senderId: "u-repeat",
        senderIdLine: "Your forum user id: u-repeat",
        upsertPairingRequest: async () => {
          const result = { code: "PEND1234", created };
          // The store only creates on first contact; later calls reuse the code.
          created = false;
          return result;
        },
        sendPairingReply: async (text) => {
          sent.push(text);
        },
        onReminded,
      });
    return { sent, onReminded, sendDirectMessage };
  }

  it("challenges first, then reminds a repeat sender without spamming", async () => {
    const { sent, onReminded, sendDirectMessage } = createRepeatSenderHarness();

    await sendDirectMessage();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("access not configured");
    expect(sent[0]).toContain("PEND1234");

    // Writing again right away must not re-issue anything.
    vi.setSystemTime(startMs + 60_000);
    await sendDirectMessage();
    vi.setSystemTime(startMs + 5 * 60_000);
    await sendDirectMessage();
    expect(sent).toHaveLength(1);
    expect(onReminded).not.toHaveBeenCalled();

    // Once the interval has passed, a repeat sender is answered again.
    vi.setSystemTime(startMs + PAIRING_REPLY_INTERVAL_MS + 1);
    await sendDirectMessage();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("still waiting for approval");
    expect(sent[1]).toContain("PEND1234");
    expect(sent[1]).not.toContain("access not configured");
    expect(onReminded).toHaveBeenCalledTimes(1);

    // Further messages inside the new interval stay quiet.
    vi.setSystemTime(startMs + PAIRING_REPLY_INTERVAL_MS + 60_000);
    await sendDirectMessage();
    expect(sent).toHaveLength(2);

    // ...and the next interval reminds once more.
    vi.setSystemTime(startMs + 2 * PAIRING_REPLY_INTERVAL_MS + 2);
    await sendDirectMessage();
    expect(sent).toHaveLength(3);
    expect(sent[2]).toContain("still waiting for approval");
    expect(onReminded).toHaveBeenCalledTimes(2);
  });

  it("throttles each sender and account separately", async () => {
    const sent: Array<{ senderId: string; text: string }> = [];
    const issueFor = async (params: { senderId: string; accountId: string }) =>
      await issuePairingChallenge({
        channel: "forum",
        accountId: params.accountId,
        senderId: params.senderId,
        senderIdLine: `Your forum user id: ${params.senderId}`,
        upsertPairingRequest: async () => ({ code: "SHARED12", created: false }),
        sendPairingReply: async (text) => {
          sent.push({ senderId: params.senderId, text });
        },
      });

    await issueFor({ senderId: "u-one", accountId: "alpha" });
    await issueFor({ senderId: "u-two", accountId: "alpha" });
    await issueFor({ senderId: "u-one", accountId: "beta" });
    // Repeat of the first pair is the only one that must be suppressed.
    await issueFor({ senderId: "u-one", accountId: "alpha" });

    expect(sent).toHaveLength(3);
  });
});
