import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  postSlackText,
  sendSlackDm,
  sendSlackReviewerCard,
  updateSlackMessage,
} from "./admin-action-slack.js";

const config = {
  channels: { slack: { accounts: { admin: { botToken: "synthetic-account-token" } } } },
};

function transport() {
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("retired invocation");
    }
  };
  const send = vi.fn(async (_input: unknown) => ({
    messageId: "100.1",
    target: { kind: "channel" as const, id: "DADMIN001" },
  }));
  const loadAdapter = vi.fn(async () => ({ sendText: send, sendPayload: send }));
  const api = {
    runtime: { config: { current: () => config }, channel: { outbound: { loadAdapter } } },
  } as unknown as OpenClawPluginApi;
  return {
    api,
    send,
    loadAdapter,
    assertCurrent,
    retire: () => {
      current = false;
    },
  };
}

const sends = {
  card: (h: ReturnType<typeof transport>) =>
    sendSlackReviewerCard(h.api, {
      accountId: "admin",
      teamId: "TWORK001",
      reviewerSlackUserId: "UADMIN001",
      text: "Approval",
      blocks: [],
      assertCurrent: h.assertCurrent,
    }),
  dm: (h: ReturnType<typeof transport>) =>
    sendSlackDm(h.api, {
      accountId: "admin",
      teamId: "TWORK001",
      userId: "UADMIN001",
      text: "Private receipt",
      assertCurrent: h.assertCurrent,
    }),
  thread: (h: ReturnType<typeof transport>) =>
    postSlackText(h.api, {
      accountId: "admin",
      teamId: "TWORK001",
      channelId: "CCHANNEL1",
      threadTs: "99.1",
      text: "Outcome",
      assertCurrent: h.assertCurrent,
    }),
};

afterEach(() => vi.unstubAllGlobals());

describe("Slack approval native transport authority", () => {
  it.each(Object.keys(sends) as Array<keyof typeof sends>)(
    "%s retains the workspace and currentness assertion at native handoff",
    async (kind) => {
      const h = transport();
      await sends[kind](h);
      const input = h.send.mock.calls[0]![0] as {
        to: string;
        assertDirectAdapterHandoff: () => void;
      };
      expect(input.to).toBe(
        kind === "thread" ? "team:TWORK001:channel:CCHANNEL1" : "team:TWORK001:user:UADMIN001",
      );
      expect(input.assertDirectAdapterHandoff).toBe(h.assertCurrent);
      h.retire();
      expect(input.assertDirectAdapterHandoff).toThrow("retired invocation");
    },
  );

  it.each(Object.keys(sends) as Array<keyof typeof sends>)(
    "%s refuses retirement during adapter loading",
    async (kind) => {
      const h = transport();
      const pending = createDeferred<Awaited<ReturnType<typeof h.loadAdapter>>>();
      h.loadAdapter.mockReturnValueOnce(pending.promise);
      const result = sends[kind](h);
      h.retire();
      pending.resolve({ sendText: h.send, sendPayload: h.send });
      await expect(result).rejects.toThrow("retired invocation");
      expect(h.send).not.toHaveBeenCalled();
    },
  );

  it("does not edit through a root token when the recorded account is unavailable", async () => {
    const h = transport();
    h.api.runtime.config.current = () => ({ channels: { slack: { botToken: "synthetic-root" } } });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      updateSlackMessage(h.api, {
        accountId: "admin",
        channelId: "DADMIN001",
        ts: "100.1",
        text: "Updated",
        blocks: [],
        assertCurrent: h.assertCurrent,
      }),
    ).rejects.toThrow("token unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a direct card edit after invocation retirement", async () => {
    const h = transport();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    h.retire();
    await expect(
      updateSlackMessage(h.api, {
        accountId: "admin",
        channelId: "DADMIN001",
        ts: "100.1",
        text: "Updated",
        blocks: [],
        assertCurrent: h.assertCurrent,
      }),
    ).rejects.toThrow("retired invocation");
    expect(fetch).not.toHaveBeenCalled();
  });
});
