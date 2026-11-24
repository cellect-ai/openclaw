import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import { SOURCE_AUTHORIZED_PROJECTION } from "../projection-reply-authorization.js";
import {
  removeBindingRecord,
  setBindingRecord,
  type MatrixThreadBindingRecord,
} from "../thread-bindings-shared.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";

const roomId = "!source:example.org";
const senderId = "@member:example.org";
const binding: MatrixThreadBindingRecord = {
  accountId: "ops",
  conversationId: "$root",
  parentConversationId: roomId,
  targetKind: "subagent",
  targetSessionKey: "agent:ops:slack:channel:c123:thread:1700000000.000001",
  agentId: "ops",
  boundBy: SOURCE_AUTHORIZED_PROJECTION,
  sourceReplyAuthorization: "fi-v1",
  boundAt: 1,
  lastActivityAt: 1,
};
let runtime: ReturnType<typeof createPluginRuntimeMock>;
const authorize = vi.fn();
const handlerRuntime = {
  log: vi.fn(),
  error: (...messages: unknown[]) => {
    throw new Error(messages.map(String).join(" "));
  },
  exit: (code: number) => {
    throw new Error(`Unexpected handler exit: ${code}`);
  },
};
beforeEach(() => {
  runtime = createPluginRuntimeMock();
  runtime.channel.runtimeContexts.register({
    channelId: "matrix",
    capability: "source-session-authorization",
    context: { protocol: "fi-v1", authorize },
  });
  installMatrixTestRuntime({
    channel: runtime.channel,
  });
  setBindingRecord(binding);
  authorize.mockReset().mockResolvedValue("allowed");
});
afterEach(() => removeBindingRecord(binding));

it("carries the exact source guard admission in the emitted native event context", async () => {
  const { handler, runPrepared } = createMatrixHandlerTestHarness({
    runtime: handlerRuntime,
    isDirectMessage: false,
    roomsConfig: { [roomId]: { requireMention: false } },
    runtimeContexts: runtime.channel.runtimeContexts,
  });
  await handler(
    roomId,
    createMatrixTextMessageEvent({
      eventId: "$reply",
      sender: senderId,
      body: "recheck actual transactions",
    }),
  );
  const context = runPrepared.mock.calls[0]?.[0].ctxPayload;
  expect(context?.SessionKey).toBe(binding.targetSessionKey);
  expect(context?.ChannelContext).toMatchObject({
    sender: { id: senderId },
    chat: {
      id: roomId,
      eventId: "$reply",
      sourceReplyAdmission: {
        version: 1,
        sessionKey: binding.targetSessionKey,
        roomId,
        eventId: "$reply",
        senderId,
        accountId: "ops",
        authorizedAt: expect.any(Number),
      },
    },
  });
  expect(authorize).toHaveBeenCalledWith({
    binding: expect.objectContaining({ targetSessionKey: binding.targetSessionKey }),
    matrixRoomId: roomId,
    matrixSenderId: senderId,
  });
});

it.each(["denied", "unavailable"])(
  "does not emit agent context when source authorization is %s",
  async (outcome) => {
    authorize.mockResolvedValue(outcome);
    const sendMessage = vi.fn().mockResolvedValue("$notice");
    const { handler, runPrepared } = createMatrixHandlerTestHarness({
      runtime: handlerRuntime,
      isDirectMessage: false,
      roomsConfig: { [roomId]: { requireMention: false } },
      runtimeContexts: runtime.channel.runtimeContexts,
      client: { sendMessage },
    });
    await handler(
      roomId,
      createMatrixTextMessageEvent({
        eventId: "$reply",
        sender: senderId,
        body: "recheck actual transactions",
      }),
    );
    expect(runPrepared).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalled();
  },
);
