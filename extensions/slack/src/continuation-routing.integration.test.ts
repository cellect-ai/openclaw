// Exercises the durable continuation binding through SQLite and Slack's real routing resolver.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import { describe, expect, it } from "vitest";
import {
  listCurrentConversationBindingRecordsBySession,
  resolveCurrentConversationBindingRecord,
  updateCurrentConversationBindingRecord,
} from "../../../src/infra/outbound/current-conversation-bindings.js";
import { installDeliveryQueueTmpDirHooks } from "../../../src/infra/outbound/delivery-queue.test-helpers.js";
import type { ResolvedSlackAccount } from "./accounts.js";
import { resolveSlackRoutingContext } from "./monitor/message-handler/prepare-routing.js";
import type { SlackMessageEvent } from "./types.js";

describe("WebChat completion Slack continuation", () => {
  installDeliveryQueueTmpDirHooks();

  it("persists an exact DM-thread binding and routes only replies to that message", async () => {
    const targetSessionKey = "agent:cellect-fi-admin:acp:hermes-web-owner";
    const conversation = {
      channel: "slack",
      accountId: "default",
      conversationId: "1770408530.000000",
      parentConversationId: "user:U3",
    };
    updateCurrentConversationBindingRecord(conversation, () => ({
      bindingId: "generic:slack-test-continuation",
      targetSessionKey,
      targetKind: "session",
      conversation,
      status: "active",
      boundAt: Date.now(),
      metadata: { boundBy: "webchat-completion-delivery" },
    }));
    const adapter: SessionBindingAdapter = {
      channel: "slack",
      accountId: "default",
      listBySession: listCurrentConversationBindingRecordsBySession,
      resolveByConversation: resolveCurrentConversationBindingRecord,
    };
    registerSessionBindingAdapter(adapter);

    const ctx = {
      cfg: {
        session: { dmScope: "per-channel-peer" },
        channels: { slack: { enabled: true, replyToMode: "all" } },
      } as OpenClawConfig,
      teamId: "T1",
      threadInheritParent: false,
      threadHistoryScope: "thread" as const,
    } satisfies Parameters<typeof resolveSlackRoutingContext>[0]["ctx"];
    const account = {
      accountId: "default",
      enabled: true,
      identity: "bot",
      botTokenSource: "config",
      appTokenSource: "config",
      userTokenSource: "none",
      config: { replyToMode: "all" },
      replyToMode: "all",
    } satisfies ResolvedSlackAccount;
    const route = (threadTs?: string) =>
      resolveSlackRoutingContext({
        ctx,
        account,
        message: {
          channel: "D456",
          channel_type: "im",
          user: "U3",
          text: "continue",
          ts: "1770408540.000000",
          ...(threadTs ? { thread_ts: threadTs, parent_user_id: "B1" } : {}),
        } as SlackMessageEvent,
        isDirectMessage: true,
        isGroupDm: false,
        isRoom: false,
        isRoomish: false,
      });

    try {
      expect(route("1770408530.000000").sessionKey).toBe(targetSessionKey);
      expect(route("1770408599.000000").sessionKey).not.toBe(targetSessionKey);
      expect(route().sessionKey).not.toBe(targetSessionKey);
    } finally {
      unregisterSessionBindingAdapter({ channel: "slack", accountId: "default", adapter });
    }
  });
});
