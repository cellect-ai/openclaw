import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  testing as sessionBindingTesting,
  registerSessionBindingAdapter,
} from "openclaw/plugin-sdk/session-binding-runtime";
import {
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { peekSystemEventEntries } from "openclaw/plugin-sdk/system-event-runtime";
import { resetSystemEventsForTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import { registerMatrixLiveAllowlistTests } from "./handler.live-allowlist.test-support.js";
import { createMatrixHandlerTestHarness } from "./handler.test-helpers.js";
import { createMatrixTextMessageEvent } from "./handler.test-helpers.js";
import {
  createMatrixHandlerTestHarness as createHarness,
  createMatrixReactionEvent,
  createMatrixReactionTestHarness,
  createMatrixRoomMessageEvent,
  createMatrixTextMessageEvent as textEvent,
} from "./handler.test-helpers.js";

const ROOM = "!room:example.org";

const sendMock = vi.hoisted(() => vi.fn<typeof import("../send.js").sendMessageMatrix>());

const sendDraftMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ messageId: "$draft1", roomId: "!room" })),
);

const editMock = vi.hoisted(() =>
  vi.fn<typeof import("../send.js").editMessageMatrix>(async () => "$edited"),
);

const typingMock = vi.hoisted(() => vi.fn(async () => {}));

const { prepareMock, prepareSingleText } = vi.hoisted(() => {
  const prepare = (text: string) => {
    const trimmedText = text.trim();
    return {
      trimmedText,
      convertedText: trimmedText,
      singleEventLimit: 4000,
      fitsInSingleEvent: true,
    };
  };
  return { prepareMock: vi.fn(prepare), prepareSingleText: prepare };
});

const mentionsMock = vi.hoisted(() =>
  vi.fn(async ({ body }: { body: string }) => {
    const userIds = Array.from(body.matchAll(/@[A-Za-z0-9._=/-]+:[^\s`<]+/g), (match) => match[0]);
    return {
      ...(body.includes("@room") ? { room: true } : {}),
      ...(userIds.length > 0 ? { user_ids: userIds } : {}),
    };
  }),
);

const hooksMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>();
  return { ...actual, getGlobalHookRunner: hooksMock };
});

vi.mock("../send.js", () => ({
  editMessageMatrix: editMock,
  prepareMatrixSingleText: prepareMock,
  reactMatrixMessage: vi.fn(async () => {}),
  resolveMatrixMentionsForBody: mentionsMock,
  sendMessageMatrix: sendMock,
  sendSingleTextMessageMatrix: sendDraftMock,
  sendReadReceiptMatrix: vi.fn(async () => {}),
  sendTypingMatrix: typingMock,
}));

function receiveText(
  handler: ReturnType<typeof createHarness>["handler"],
  event: Parameters<typeof textEvent>[0],
  roomId = ROOM,
) {
  return handler(roomId, textEvent(event));
}

type SessionOrigin = {
  chatType: "direct" | "group";
  from: string;
  to: string;
  nativeChannelId?: string;
};

function threadRoot(eventId = "$root", body = "Root topic") {
  return textEvent({ eventId, sender: "@alice:example.org", body });
}

function agentRoute(sessionKey = "agent:ops:main") {
  return {
    agentId: "ops",
    channel: "matrix",
    accountId: "ops",
    sessionKey,
    mainSessionKey: "agent:ops:main",
    matchedBy: "binding.account" as const,
  };
}

function threadRelation(root = "$root") {
  return { rel_type: "m.thread", event_id: root, "m.in_reply_to": { event_id: root } };
}

function dispatchResult(final = 0, block = 0) {
  return { queuedFinal: final > 0, counts: { final, block, tool: 0 } };
}

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  installMatrixMonitorTestRuntime();
  hooksMock.mockReset().mockReturnValue(null);
  prepareMock.mockReset().mockImplementation(prepareSingleText);
  mentionsMock.mockClear();
  sendMock.mockReset().mockImplementation(acceptMatrixReply());
  typingMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  resetSystemEventsForTest();
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mockCalls(mock: unknown, label: string): unknown[][] {
  if (!vi.isMockFunction(mock)) {
    throw new Error(`${label} was not a mock`);
  }
  return mock.mock.calls;
}

function callArg(mock: unknown, callIndex: number, argIndex: number, label = "mock call") {
  return expectDefined(mockCalls(mock, label).at(callIndex), label)[argIndex];
}

function expectNoCalls(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

function deliveryResult(messageId = "$reply1", content = "delivered") {
  return {
    messageIds: [messageId],
    receipt: {
      primaryPlatformMessageId: messageId,
      platformMessageIds: [messageId],
      parts: [{ platformMessageId: messageId, kind: "text" as const, index: 0 }],
      sentAt: 1,
    },
    visibleReplySent: true,
    content,
  };
}

function acceptMatrixReply(
  messageId = "$reply1",
  content = "delivered",
): typeof import("../send.js").sendMessageMatrix {
  return async (_room, _text, options) => {
    const result = {
      messageId,
      roomId: ROOM,
      primaryMessageId: messageId,
      receipt: deliveryResult(messageId, content).receipt,
      content,
    };
    await options.onDeliveryResult?.(result);
    return result;
  };
}

type HarnessOptions = NonNullable<Parameters<typeof createHarness>[0]>;

const noticeDirs = useSessionStoreTempDirs(afterAll, "matrix-dm-notice-");

function registerTestBinding(conversationId: string, parentConversationId?: string) {
  const touch = vi.fn();
  registerSessionBindingAdapter({
    channel: "matrix",
    accountId: "ops",
    listBySession: () => [],
    resolveByConversation: (ref) =>
      ref.conversationId === conversationId
        ? {
            bindingId: `ops:${parentConversationId ?? ""}:${conversationId}`,
            targetSessionKey: "agent:bound:session-1",
            targetKind: "session",
            conversation: {
              channel: "matrix",
              accountId: "ops",
              conversationId,
              parentConversationId,
            },
            status: "active",
            boundAt: Date.now(),
          }
        : null,
    touch,
  });
  return touch;
}

async function createDmNoticeHarness(
  options: HarnessOptions = {},
  params: {
    sessionKey?: string;
    origin?: SessionOrigin | null;
    sendNotice?: ReturnType<typeof vi.fn<() => Promise<string>>>;
  } = {},
) {
  const storePath = path.join(noticeDirs.make(), "sessions.json");
  const sessionKey = params.sessionKey ?? "agent:ops:main";
  const priorDm: SessionOrigin = {
    chatType: "direct",
    from: "matrix:@user:example.org",
    to: "room:!other:example.org",
    nativeChannelId: "!other:example.org",
  };
  const delivery =
    params.origin === null
      ? { context: { channel: "matrix", to: "room:!other:example.org", accountId: "ops" } }
      : {
          origin: {
            provider: "matrix",
            surface: "matrix",
            accountId: "ops",
            ...(params.origin ?? priorDm),
          },
        };
  await upsertSessionEntry({
    storePath,
    sessionKey,
    entry: {
      sessionId: `sess-${sessionKey}`,
      updatedAt: Date.now(),
      delivery: normalizeSessionDeliveryState(delivery),
    },
  });
  const sendNotice = params.sendNotice ?? vi.fn(async () => "$notice");
  const harness = createHarness({
    isDirectMessage: true,
    ...options,
    cfg: {
      session: { store: storePath },
      channels: { matrix: { dm: { allowFrom: options.allowFrom ?? ["*"] } } },
    },
    client: { ...options.client, sendMessage: sendNotice },
  });
  const receive = (eventId: string) =>
    receiveText(harness.handler, { eventId, body: "follow up" }, "!dm:example.org");
  return { ...harness, storePath, sendNotice, receive };
}

registerMatrixLiveAllowlistTests();

describe("matrix monitor handler pairing account scope", () => {
  it("logs inbound UTF-16 length without a message preview", async () => {
    const logVerboseMessage = vi.fn();
    const { handler } = createHarness({ logVerboseMessage });
    await receiveText(handler, { eventId: "$event-preview", body: `${"x".repeat(199)}🚀tail` });
    expect(logVerboseMessage).toHaveBeenCalledWith(
      "matrix inbound: room=!room:example.org from=@user:example.org chars=205",
    );
    expect(logVerboseMessage).not.toHaveBeenCalledWith(expect.stringContaining("x".repeat(199)));
  });

  it.each(["main", "per-channel-peer"])(
    "pins the configured DM owner only when live dmScope is %s",
    async (dmScope) => {
      const channels = { matrix: { dm: { allowFrom: ["@owner:example.org"] } } };
      const { handler, recordInboundSession } = createHarness({
        cfg: dmScope === "main" ? { channels } : { session: { dmScope: "main" }, channels },
        ...(dmScope === "main" ? {} : { liveCfg: { session: { dmScope }, channels } }),
        dmPolicy: "allowlist",
        allowFrom: ["@owner:example.org"],
        allowFromResolvedEntries: [{ input: "@owner:example.org", id: "@owner:example.org" }],
        isDirectMessage: true,
      });
      await receiveText(
        handler,
        { eventId: "$owner-dm", sender: "@owner:example.org", body: "hello" },
        "!dm:example.org",
      );
      expect(recordInboundSession).toHaveBeenCalledTimes(1);
      expect(callArg(recordInboundSession, 0, 0)).toMatchObject({
        updateLastRoute: {
          channel: "matrix",
          to: "room:!dm:example.org",
          mainDmOwnerPin:
            dmScope === "main"
              ? {
                  ownerRecipient: "@owner:example.org",
                  senderRecipient: "@owner:example.org",
                }
              : undefined,
        },
      });
    },
  );

  it("accepts room messages from configured Matrix bot accounts when allowBots is true", async () => {
    const { handler, recordInboundSession, runPrepared } = createHarness({
      isDirectMessage: false,
      accountAllowBots: true,
      accountConfig: { botLoopProtection: { windowSeconds: 120, cooldownSeconds: 240 } },
      configuredBotUserIds: new Set(["@ops:example.org"]),
      roomsConfig: {
        [ROOM]: { requireMention: false, botLoopProtection: { maxEventsPerWindow: 3 } },
      },
      getMemberDisplayName: async () => "ops-bot",
    });
    await receiveText(handler, {
      eventId: "$bot-on",
      sender: "@ops:example.org",
      body: "hello from bot",
      originServerTs: 123_456,
    });
    expect(recordInboundSession).toHaveBeenCalled();
    expect(runPrepared.mock.calls[0]?.[0].ctxPayload.GroupRequireMention).toBe(false);
    expect(runPrepared.mock.calls[0]?.[0].botLoopProtection).toEqual({
      scopeId: "ops",
      conversationId: ROOM,
      senderId: "@ops:example.org",
      receiverId: "@bot:example.org",
      config: { maxEventsPerWindow: 3, windowSeconds: 120, cooldownSeconds: 240 },
      defaultsConfig: undefined,
      defaultEnabled: true,
      nowMs: 123_456,
    });
  });

  it.each([
    { name: "room override", accountAllowBots: true, roomAllowBots: false },
    { name: "missing mention", accountAllowBots: "mentions", roomAllowBots: undefined },
  ] as const)("gates configured bot senders: $name", async (scenario) => {
    const { handler, recordInboundSession } = createHarness({
      isDirectMessage: false,
      accountAllowBots: scenario.accountAllowBots,
      configuredBotUserIds: new Set(["@ops:example.org"]),
      roomsConfig: { [ROOM]: { requireMention: false, allowBots: scenario.roomAllowBots } },
      mentionRegexes: [/@bot/i],
    });
    await receiveText(handler, { eventId: "$bot-gate", sender: "@ops:example.org", body: "hello" });
    expect(recordInboundSession).not.toHaveBeenCalled();
  });

  it.each(["paired", "configured"])(
    "blocks room control commands from %s DM-only senders",
    async (source) => {
      const configured = source === "configured";
      const readAllowFromStore = vi.fn(async () => ["@user:example.org"]);
      const hasControlCommand = vi.fn((text?: string) => !configured || text === "/new");
      const { handler, finalizeInboundContext, recordInboundSession } = createHarness({
        isDirectMessage: false,
        readAllowFromStore,
        roomsConfig: { [ROOM]: { requireMention: false } },
        shouldHandleTextCommands: () => true,
        hasControlCommand,
        cfg: {
          commands: { useAccessGroups: true },
          ...(configured
            ? {
                channels: {
                  matrix: {
                    dm: { allowFrom: ["@observer:example.org"] },
                    groupAllowFrom: ["@driver:example.org"],
                  },
                },
              }
            : {}),
        },
        groupPolicy: "open",
        getMemberDisplayName: async () => (configured ? "observer" : "sender"),
      });
      await receiveText(handler, {
        eventId: "$dm-only-room-command",
        sender: configured ? "@observer:example.org" : "@user:example.org",
        body: configured ? "@bot:example.org /new" : "/config",
      });
      expectNoCalls(recordInboundSession, finalizeInboundContext);
      if (configured) {
        expect(callArg(hasControlCommand, 0, 0)).toBe("/new");
      } else {
        expect(readAllowFromStore).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps require-mention decision for unmentioned room command", async () => {
    const body = "/new";
    const { handler, finalizeInboundContext } = createHarness({
      cfg: { channels: { matrix: { groupAllowFrom: ["@user:example.org"] } } },
      isDirectMessage: false,
      groupAllowFrom: ["@user:example.org"],
      mentionRegexes: [],
      shouldHandleTextCommands: () => true,
      hasControlCommand: (text?: string) => text === body,
      getMemberDisplayName: async () => "sender",
    });
    await receiveText(handler, { eventId: "$unmentioned-command", body });
    expect(finalizeInboundContext).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another homeserver", "hello @bot:evil.example", false, false, false],
    ["Unicode display name", "@欢欢 please reply", true, false, true],
    ["forged metadata only", "hello there", false, true, false],
  ] as const)(
    "validates native mentions: %s",
    async (_name, body, formatted, metadataOnly, accepted) => {
      const { handler, recordInboundSession } = createHarness({
        isDirectMessage: false,
        mentionRegexes: metadataOnly ? [/@bot/i] : [],
        getMemberDisplayName: async () => (formatted ? "欢欢" : "sender"),
      });
      await handler(
        ROOM,
        createMatrixRoomMessageEvent({
          eventId: "$native-mention",
          content: {
            msgtype: "m.text",
            body,
            ...(formatted
              ? {
                  formatted_body:
                    '<a href="https://matrix.to/#/@bot:example.org">@欢欢</a> please reply',
                }
              : {}),
            "m.mentions": { user_ids: ["@bot:example.org"] },
          },
        }),
      );
      if (accepted) {
        expect(recordInboundSession).toHaveBeenCalledOnce();
      } else {
        expect(recordInboundSession).not.toHaveBeenCalled();
      }
    },
  );

  it("drops root events that carry a bundled replacement relation", async () => {
    const { handler, recordInboundSession } = createHarness({
      isDirectMessage: false,
      mentionRegexes: [/@bot/i],
      getMemberDisplayName: async () => "sender",
    });
    await receiveText(handler, {
      eventId: "$edited-root",
      body: "@bot please reply",
      mentions: { user_ids: ["@bot:example.org"] },
      unsigned: { "m.relations": { "m.replace": { event_id: "$edit" } } },
    });
    expect(recordInboundSession).not.toHaveBeenCalled();
  });

  it("records thread context with flat DM routing", async () => {
    const getEvent = vi.fn(async (_roomId: string, eventId: string) =>
      eventId === "$root"
        ? threadRoot("$root", "Root topic")
        : textEvent({ eventId, sender: "@bot:example.org", body: "" }),
    );
    const { handler, finalizeInboundContext, recordInboundSession } = createHarness({
      client: { getEvent },
      isDirectMessage: true,
      threadReplies: "always",
      dmThreadReplies: "off",
      getMemberDisplayName: async (_roomId, userId) =>
        userId === "@alice:example.org" ? "Alice" : "sender",
    });
    await receiveText(
      handler,
      { eventId: "$reply1", body: "follow up", relatesTo: threadRelation("$root") },
      "!dm:example.org",
    );
    expect(callArg(finalizeInboundContext, 0, 0)).toMatchObject({
      ThreadStarterBody: "Matrix thread root $root from Alice:\nRoot topic",
      MessageThreadId: undefined,
      ReplyToId: "$root",
    });
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "agent:ops:main" }),
    );
  });

  it("waits for a shared-session notice before dispatch and sends it only once", async () => {
    const entered = createDeferred<void>();
    const notice = createDeferred<string>();
    const sendNotice = vi.fn(() => {
      entered.resolve();
      return notice.promise;
    });
    const dispatchInboundMessage = vi.fn(async () => dispatchResult(0, 0));
    const sessionKey = "agent:ops:matrix:direct:@user:example.org";
    const { receive } = await createDmNoticeHarness(
      {
        dispatchInboundMessage,
        resolveAgentRoute: () => agentRoute(sessionKey),
      },
      { sessionKey, sendNotice },
    );
    const handled = receive("$dm1");
    try {
      await entered.promise;
      expect(dispatchInboundMessage).not.toHaveBeenCalled();
      expect(callArg(sendNotice, 0, 0)).toBe("!dm:example.org");
      expect(callArg(sendNotice, 0, 1)).toMatchObject({
        msgtype: "m.notice",
        body: expect.stringContaining("channels.matrix.dm.sessionScope"),
      });
    } finally {
      notice.resolve("$notice");
      await handled;
    }
    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
    await receive("$dm2");
    expect(sendNotice).toHaveBeenCalledTimes(1);
  });

  it.each(["prior group", "per-room", "bound"])(
    "resolves shared DM collision notices for %s sessions",
    async (scenario) => {
      const touch = scenario === "bound" ? registerTestBinding("!dm:example.org") : undefined;
      const { receive, sendNotice, recordInboundSession } = await createDmNoticeHarness(
        scenario === "per-room" ? { dmSessionScope: "per-room" } : {},
        scenario === "prior group"
          ? {
              origin: {
                chatType: "group",
                from: "matrix:channel:!group:example.org",
                to: "room:!group:example.org",
                nativeChannelId: "!group:example.org",
              },
            }
          : scenario === "bound"
            ? { sessionKey: "agent:bound:session-1", origin: null }
            : scenario === "per-room"
              ? { origin: null }
              : {},
      );
      await receive("$dm1");
      expect(sendNotice).not.toHaveBeenCalled();
      if (scenario === "per-room") {
        expect(recordInboundSession).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionKey: "agent:ops:matrix:channel:!dm:example.org",
          }),
        );
      }
      if (touch) {
        expect(touch).toHaveBeenCalledOnce();
      }
    },
  );

  it("does not refresh bound Matrix thread bindings for room messages dropped before routing", async () => {
    const touch = registerTestBinding("$root", "!room:example");
    const { handler, recordInboundSession } = createHarness({
      client: {
        getEvent: async () => threadRoot("$root", "Root topic"),
      },
      isDirectMessage: false,
      getMemberDisplayName: async () => "sender",
    });
    await receiveText(
      handler,
      {
        eventId: "$reply-no-mention",
        body: "follow up without mention",
        relatesTo: threadRelation("$root"),
      },
      "!room:example",
    );
    expectNoCalls(recordInboundSession, touch);
  });

  it.each(["other author", "unauthorized DM"])("ignores reactions for %s", async (scenario) => {
    const { handler, resolveAgentRoute, upsertPairingRequest } = createMatrixReactionTestHarness({
      ...(scenario === "other author" ? { targetSender: "@other:example.org" } : {}),
      ...(scenario === "unauthorized DM" ? { dmPolicy: "pairing" } : {}),
    });
    await handler(
      ROOM,
      createMatrixReactionEvent({ eventId: "$reaction", targetEventId: "$msg", key: "👀" }),
    );
    expect(peekSystemEventEntries("agent:ops:main")).toEqual([]);
    if (scenario === "other author") {
      expect(resolveAgentRoute).not.toHaveBeenCalled();
    }
    if (scenario === "unauthorized DM") {
      expect(upsertPairingRequest).not.toHaveBeenCalled();
    }
  });

  it("does not cold-drop a previously retained ingress event after successor startup", async () => {
    const dispatchInboundMessage = vi.fn(async () => ({
      queuedFinal: false,
      counts: { final: 0, block: 0, tool: 0 },
    }));
    const { handler } = createMatrixHandlerTestHarness({
      dispatchInboundMessage,
      isDirectMessage: true,
    });
    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$durable-before-restart",
        body: "retained before restart",
        originServerTs: 999,
      }),
      {
        admission: "exclusive",
        abortSignal: new AbortController().signal,
        onAdopted: vi.fn(async () => {}),
        onDeferred: vi.fn(),
        onAdoptionFinalizing: vi.fn(),
        onAbandoned: vi.fn(async () => {}),
      },
    );
    expect(dispatchInboundMessage).toHaveBeenCalledOnce();
  });

  it.each(["fresh", "ordinary-quote", "wrong-issuer", "wrong-root"])(
    "carries only verified native question reply identity through ingress: %s",
    async (scenario) => {
      const error = vi.fn();
      const content = {
        msgtype: "m.text",
        body: "Which option?",
        "m.relates_to": {
          rel_type: "m.thread",
          event_id: scenario === "wrong-root" ? "$other" : "$root",
        },
        ...(scenario === "ordinary-quote"
          ? {}
          : {
              "com.openclaw.presentation": {
                version: 1,
                type: "message.presentation",
                blocks: [
                  {
                    type: "buttons",
                    buttons: [
                      {
                        label: "Blue",
                        action: {
                          type: "question",
                          questionId: "ask_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                          optionValue: "Blue",
                        },
                      },
                    ],
                  },
                ],
              },
            }),
      };
      const { handler, finalizeInboundContext, recordInboundSession } =
        createMatrixHandlerTestHarness({
          isDirectMessage: false,
          runtime: { error, log: vi.fn(), exit: vi.fn() },
          client: {
            getEvent: async (_room, eventId) =>
              eventId === "$root"
                ? createMatrixTextMessageEvent({ eventId: "$root", body: "Conversation root" })
                : createMatrixRoomMessageEvent({
                    eventId: "$question",
                    content,
                    sender:
                      scenario === "wrong-issuer" ? "@another-bot:example.org" : "@bot:example.org",
                  }),
          },
        });
      const receive = receiveText(handler, {
        eventId: "$answer",
        body: "@room Blue",
        mentions: { room: true },
        relatesTo: {
          rel_type: "m.thread",
          event_id: "$root",
          "m.in_reply_to": { event_id: "$question" },
        },
      });
      if (scenario === "wrong-root") {
        await expect(receive).rejects.toThrow("thread_mismatch");
        expect(recordInboundSession).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith(expect.stringContaining("thread_mismatch"));
      } else {
        await receive;
        const context = callArg(finalizeInboundContext, 0, 0, "context") as Record<string, unknown>;
        expect(context.ExpectedQuestionId).toBe(
          scenario === "fresh" ? "ask_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" : undefined,
        );
        expect(recordInboundSession).toHaveBeenCalledOnce();
      }
    },
  );
});
