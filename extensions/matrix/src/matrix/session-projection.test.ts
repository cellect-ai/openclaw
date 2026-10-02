// Matrix tests cover canonical-session projection into Matrix threads.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindReplyPublication } from "../../../../src/auto-reply/reply-publication.js";
import {
  createMatrixSessionProjection,
  inspectMatrixSessionProjection,
  handleMatrixSessionProjectionMessageReceived,
  handleMatrixSessionProjectionReplyPayloadSending as handleUntrustedReply,
  MATRIX_SESSION_PROJECTION_BOUND_BY,
} from "./session-projection.js";

const mocks = vi.hoisted(() => ({
  bind: vi.fn(),
  getSessionEntry: vi.fn(),
  getThreadBindingManager: vi.fn(),
  listBySession: vi.fn(),
  resolveAgentId: vi.fn(() => "cellect-fi-user"),
  sendMessageMatrix: vi.fn(async (_to: string, _message: string, _opts: unknown) => ({
    messageId: "$sent",
    roomId: "!room",
  })),
  touch: vi.fn(),
  sourceGuard: vi.fn(),
  globalSourceGuard: vi.fn(),
  resolveByConversation: vi.fn(),
  owner: vi.fn(),
  reconcileSnapshot: vi.fn(),
}));

vi.mock("./session-projection-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-projection-snapshot.js")>();
  return { ...actual, reconcileMatrixProjectionSnapshot: mocks.reconcileSnapshot };
});

vi.mock("../runtime.js", () => ({
  getMatrixRuntime: () => ({ channel: { runtimeContexts: { get: mocks.globalSourceGuard } } }),
}));

vi.mock("openclaw/plugin-sdk/agent-scope-runtime", () => ({
  resolveSessionAgentIdStrict: mocks.resolveAgentId,
}));
vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", () => ({
  getSessionBindingService: () => ({
    bind: mocks.bind,
    listBySession: mocks.listBySession,
    touch: mocks.touch,
    resolveByConversation: mocks.resolveByConversation,
  }),
}));
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  getSessionEntry: mocks.getSessionEntry,
}));
vi.mock("./accounts.js", () => ({
  resolveDefaultMatrixAccountId: () => "fi-user",
}));
vi.mock("./send.js", () => ({ sendMessageMatrix: mocks.sendMessageMatrix }));
vi.mock("./projection-lifecycle.js", () => ({
  resolveMatrixProjectionRun: mocks.owner,
  noteMatrixProjectionFinalResult: vi.fn(),
}));
vi.mock("./thread-bindings-shared.js", () => ({
  getMatrixThreadBindingManager: mocks.getThreadBindingManager,
  toSessionBindingRecord: (record: {
    conversationId: string;
    parentConversationId: string;
    boundBy: string;
  }) => ({
    ...projectionBinding,
    conversation: {
      ...projectionBinding.conversation,
      conversationId: record.conversationId,
      parentConversationId: record.parentConversationId,
    },
    metadata: { boundBy: record.boundBy },
  }),
}));

const cfg = {} as never;
const sessionKey = "agent:cellect-fi-user:slack:channel:C1:thread:1700000000.000001";
const projectionBinding = {
  bindingId: "fi-user:!room:$root",
  targetSessionKey: sessionKey,
  targetKind: "session" as const,
  conversation: {
    channel: "matrix",
    accountId: "fi-user",
    conversationId: "$root",
    parentConversationId: "!room",
  },
  status: "active" as const,
  boundAt: 1,
  metadata: {
    boundBy: MATRIX_SESSION_PROJECTION_BOUND_BY,
    environment: "test",
    projectedConversationId: "conversation",
  },
};
// Simulate the real host admission boundary, not caller-selected JSON metadata.
async function handleMatrixSessionProjectionReplyPayloadSending(
  event: Parameters<typeof handleUntrustedReply>[0],
  context: Parameters<typeof handleUntrustedReply>[1],
  config: Parameters<typeof handleUntrustedReply>[2],
) {
  if (event.kind === "block" || event.kind === "final" || event.kind === "tool") {
    bindReplyPublication(event, {
      payload: event.payload,
      kind: event.kind,
      channel: context.channelId,
      sessionKey: event.sessionKey,
      runId: event.runId,
      context: { accountId: "fi-user" },
    });
  }
  return handleUntrustedReply(event, context, config);
}

describe("Matrix session projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionEntry.mockReturnValue({ sessionId: "session-1" });
    mocks.getThreadBindingManager.mockReturnValue({});
    mocks.listBySession.mockReturnValue([]);
    mocks.bind.mockResolvedValue(projectionBinding);
    mocks.resolveByConversation.mockReturnValue(projectionBinding);
    mocks.owner.mockReturnValue({
      generation: "opaque-owning-generation",
      bindings: [
        {
          environment: "test",
          conversationId: "conversation",
          roomId: "!room",
          bindingId: projectionBinding.bindingId,
          accountId: "fi-user",
          threadRootEventId: "$root",
          agentId: "cellect-fi-user",
        },
      ],
    });
    mocks.reconcileSnapshot.mockResolvedValue(undefined);
  });

  it("creates one durable child-thread binding for an existing canonical session", async () => {
    await expect(
      createMatrixSessionProjection({
        cfg,
        targetSessionKey: sessionKey,
        roomId: "!room",
        label: "Slack invoice thread",
        sourceActorId: "user-123",
      }),
    ).resolves.toEqual({
      status: "created",
      accountId: "fi-user",
      agentId: "cellect-fi-user",
      roomId: "!room",
      threadRootEventId: "$root",
      targetSessionKey: sessionKey,
      sourceReplyAuthorization: undefined,
      bindingId: projectionBinding.bindingId,
      environment: "test",
      conversationId: "conversation",
    });

    expect(mocks.bind).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionKey: sessionKey,
        targetKind: "session",
        placement: "child",
        conversation: {
          channel: "matrix",
          accountId: "fi-user",
          conversationId: "!room",
        },
        metadata: expect.objectContaining({
          boundBy: MATRIX_SESSION_PROJECTION_BOUND_BY,
          label: "Slack invoice thread",
          sourceActorId: "user-123",
          idleTimeoutMs: 0,
          maxAgeMs: 0,
        }),
      }),
    );
  });

  it("converts the same root only with an installed guard and durable source identity", async () => {
    const source = {
      provider: "slack",
      workspaceId: "T123",
      channelId: "C1",
      rootMessageId: "1700000000.000001",
    };
    const readonly = {
      ...projectionBinding,
      metadata: { boundBy: "session-projection-read-only" },
    };
    mocks.listBySession.mockReturnValue([readonly]);
    const params = {
      cfg,
      channelRuntime: { runtimeContexts: { get: mocks.sourceGuard } } as never,
      targetSessionKey: sessionKey,
      roomId: "!room",
      externalSource: source,
      sourceReplyAuthorization: "fi-v1",
    };
    mocks.sourceGuard.mockReturnValue(undefined);
    await expect(createMatrixSessionProjection(params)).rejects.toThrow("unavailable");
    expect(mocks.bind).not.toHaveBeenCalled();
    mocks.sourceGuard.mockReturnValue({
      protocol: "fi-v1",
      resolveSource: async () => ({ externalSource: source, sourceAccountId: "fi-user" }),
    });
    mocks.bind.mockImplementation(async (input) => {
      const converted = { ...projectionBinding, metadata: input.metadata };
      mocks.listBySession.mockReturnValue([converted]);
      return converted;
    });
    await expect(createMatrixSessionProjection(params)).resolves.toMatchObject({
      threadRootEventId: "$root",
      targetSessionKey: sessionKey,
      sourceReplyAuthorization: "fi-v1",
    });
    expect(mocks.globalSourceGuard).not.toHaveBeenCalled();
    await expect(createMatrixSessionProjection(params)).resolves.toMatchObject({
      threadRootEventId: "$root",
      sourceReplyAuthorization: "fi-v1",
    });
    expect(mocks.bind).toHaveBeenCalledTimes(1);
    expect(mocks.bind).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: "current",
        targetSessionKey: sessionKey,
        metadata: expect.objectContaining({
          boundBy: "session-projection-read-only",
          externalSource: source,
          sourceAccountId: "fi-user",
        }),
      }),
    );
  });

  it("reports a missing projection without repairing or delivering anything", () => {
    expect(
      inspectMatrixSessionProjection({ cfg, targetSessionKey: sessionKey, roomId: "!room" }),
    ).toEqual({
      status: "missing",
      accountId: "fi-user",
      agentId: "cellect-fi-user",
      roomId: "!room",
    });
    expect(mocks.bind).not.toHaveBeenCalled();
    expect(mocks.touch).not.toHaveBeenCalled();
    expect(mocks.sendMessageMatrix).not.toHaveBeenCalled();
  });

  it("keeps channel mirrors read-only and delivers only source-identified snapshots", async () => {
    const binding = { ...projectionBinding, metadata: { boundBy: "session-projection-read-only" } };
    mocks.bind.mockResolvedValue(binding);
    await createMatrixSessionProjection({
      cfg,
      targetSessionKey: sessionKey,
      roomId: "!room",
      readOnly: true,
      initialMessage: {
        sourceChannel: "slack",
        role: "assistant",
        senderId: "U123",
        agentId: "agent-example",
        content: "Source answer",
        messageId: "snapshot-1",
      },
    });
    expect(mocks.bind).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ boundBy: "session-projection-read-only" }),
      }),
    );
    expect(mocks.sendMessageMatrix).toHaveBeenCalledWith(
      "room:!room",
      "**Slack · agent-example**\nSource answer",
      expect.objectContaining({
        publication: undefined,
      }),
    );
    mocks.sendMessageMatrix.mockClear();
    mocks.listBySession.mockReturnValue([binding]);
    await handleMatrixSessionProjectionReplyPayloadSending(
      { kind: "final", payload: { text: "Source answer" }, sessionKey, runId: "run-other" },
      { channelId: "slack" },
      cfg,
    );
    expect(mocks.sendMessageMatrix).not.toHaveBeenCalled();
  });

  it("reads an existing projection without touching or replaying it", () => {
    mocks.listBySession.mockReturnValue([projectionBinding]);
    expect(
      inspectMatrixSessionProjection({ cfg, targetSessionKey: sessionKey, roomId: "!room" }),
    ).toMatchObject({
      status: "existing",
      threadRootEventId: "$root",
      bindingId: "fi-user:!room:$root",
      environment: "test",
      conversationId: "conversation",
    });
    expect(mocks.bind).not.toHaveBeenCalled();
    expect(mocks.touch).not.toHaveBeenCalled();
    expect(mocks.sendMessageMatrix).not.toHaveBeenCalled();
  });

  it("does not expose bindings from another room, account, or binding purpose", () => {
    mocks.listBySession.mockReturnValue([
      {
        ...projectionBinding,
        conversation: { ...projectionBinding.conversation, parentConversationId: "!other" },
      },
      {
        ...projectionBinding,
        conversation: { ...projectionBinding.conversation, accountId: "other" },
      },
      { ...projectionBinding, metadata: { boundBy: "subagent" } },
    ]);
    expect(
      inspectMatrixSessionProjection({ cfg, targetSessionKey: sessionKey, roomId: "!room" }).status,
    ).toBe("missing");
    expect(mocks.bind).not.toHaveBeenCalled();
    expect(mocks.sendMessageMatrix).not.toHaveBeenCalled();
  });

  it("requires an existing canonical session before inspecting bindings", () => {
    mocks.getSessionEntry.mockReturnValue(undefined);
    expect(() =>
      inspectMatrixSessionProjection({ cfg, targetSessionKey: sessionKey, roomId: "!room" }),
    ).toThrow("target OpenClaw session does not exist");
    expect(mocks.listBySession).not.toHaveBeenCalled();
  });

  it("returns the existing projection instead of creating a duplicate Matrix thread", async () => {
    mocks.listBySession.mockReturnValue([projectionBinding]);

    await expect(
      createMatrixSessionProjection({ cfg, targetSessionKey: sessionKey, roomId: "!room" }),
    ).resolves.toMatchObject({ status: "existing", threadRootEventId: "$root" });
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it("adds an authenticated source actor to an existing projection without replaying it", async () => {
    mocks.listBySession.mockReturnValue([projectionBinding]);
    mocks.bind.mockImplementation(async (input) => ({
      ...projectionBinding,
      metadata: input.metadata,
    }));

    await expect(
      createMatrixSessionProjection({
        cfg,
        targetSessionKey: sessionKey,
        roomId: "!room",
        sourceActorId: "user-123",
      }),
    ).resolves.toMatchObject({ status: "existing", threadRootEventId: "$root" });
    expect(mocks.bind).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: "current",
        metadata: expect.objectContaining({
          sourceActorId: "user-123",
          introText: false,
        }),
      }),
    );
    expect(mocks.sendMessageMatrix).not.toHaveBeenCalled();
  });

  it("refuses to replace an existing projection's authenticated source actor", async () => {
    mocks.listBySession.mockReturnValue([
      {
        ...projectionBinding,
        metadata: { ...projectionBinding.metadata, sourceActorId: "user-123" },
      },
    ]);

    await expect(
      createMatrixSessionProjection({
        cfg,
        targetSessionKey: sessionKey,
        roomId: "!room",
        sourceActorId: "different-user",
      }),
    ).rejects.toThrow("source actor cannot change");
    expect(mocks.bind).not.toHaveBeenCalled();
  });
  it("adopts a checkpoint without replaying an existing projection", async () => {
    const snapshot = {
      complete: true as const,
      messages: [
        {
          messageId: "1700000000.000001",
          senderId: "U123",
          role: "user" as const,
          content: "Already mirrored",
        },
      ],
    };
    let current = {
      ...projectionBinding,
      metadata: { ...projectionBinding.metadata, boundBy: "session-projection-read-only" },
    };
    mocks.listBySession.mockImplementation(() => [current]);
    mocks.bind.mockImplementation(async (input) => {
      current = { ...current, metadata: input.metadata };
      return current;
    });

    const params = {
      cfg,
      targetSessionKey: sessionKey,
      roomId: "!room",
      readOnly: true,
      sourceSnapshot: snapshot,
    };
    await createMatrixSessionProjection(params);
    await createMatrixSessionProjection(params);

    expect(mocks.reconcileSnapshot).not.toHaveBeenCalled();
    expect(mocks.bind).toHaveBeenCalledTimes(1);
    expect(current.metadata).toEqual(
      expect.objectContaining({
        sourceSnapshotDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        sourceSnapshotReconciledAtMs: expect.any(Number),
      }),
    );
  });
  it("explicitly refreshes an adopted snapshot in an existing projection", async () => {
    const snapshot = {
      complete: true as const,
      messages: [
        {
          messageId: "1700000000.000001",
          senderId: "U123",
          displayName: "Alex",
          role: "user" as const,
          content: "Already mirrored",
        },
      ],
    };
    let current = {
      ...projectionBinding,
      metadata: {
        ...projectionBinding.metadata,
        boundBy: "session-projection-read-only",
      },
    };
    mocks.listBySession.mockImplementation(() => [current]);
    mocks.bind.mockImplementation(async (input) => {
      current = { ...current, metadata: input.metadata };
      return current;
    });

    const params = {
      cfg,
      targetSessionKey: sessionKey,
      roomId: "!room",
      readOnly: true,
      sourceSnapshot: snapshot,
    };
    await createMatrixSessionProjection(params);
    expect(mocks.reconcileSnapshot).not.toHaveBeenCalled();
    const adoptedDigest = (current.metadata as Record<string, unknown>).sourceSnapshotDigest;

    await createMatrixSessionProjection({
      ...params,
      refreshSourceSnapshot: true,
    });

    expect(mocks.reconcileSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "fi-user",
        roomId: "!room",
        threadId: "$root",
        snapshot,
      }),
    );
    expect((current.metadata as Record<string, unknown>).sourceSnapshotDigest).toBe(adoptedDigest);
    expect((current.metadata as Record<string, unknown>).sourceSnapshotReconciledAtMs).toEqual(
      expect.any(Number),
    );
  });
  it("shares one canonical read-only room root across concurrent agent sessions", async () => {
    const records: Array<{
      conversationId: string;
      parentConversationId: string;
      boundBy: string;
    }> = [];
    mocks.getThreadBindingManager.mockReturnValue({ listBindings: () => records });
    mocks.bind.mockImplementation(async () => {
      records.push({
        conversationId: "$root",
        parentConversationId: "!room",
        boundBy: "session-projection-read-only",
      });
      return { ...projectionBinding, metadata: { boundBy: "session-projection-read-only" } };
    });
    const results = await Promise.all([
      createMatrixSessionProjection({
        cfg,
        targetSessionKey: sessionKey,
        roomId: "!room",
        readOnly: true,
      }),
      createMatrixSessionProjection({
        cfg,
        targetSessionKey: sessionKey.replace("cellect-fi-user", "cellect-fi-admin"),
        roomId: "!room",
        readOnly: true,
      }),
    ]);
    expect(mocks.bind).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.threadRootEventId)).toEqual(["$root", "$root"]);
  });

  it("projects the triggering source message as part of binding creation", async () => {
    await createMatrixSessionProjection({
      cfg,
      targetSessionKey: sessionKey,
      roomId: "!room",
      initialMessage: {
        sourceChannel: "slack",
        content: "Please check this invoice",
        messageId: "initial-1",
      },
    });

    expect(mocks.sendMessageMatrix).toHaveBeenCalledWith(
      "room:!room",
      "**Slack · User**\nPlease check this invoice",
      expect.objectContaining({
        deliveryQueueId: "matrix-session-projection:fi-user:!room:$root:user:initial-1",
        deliveryPartIndex: 0,
        deliveryPartCount: 1,
      }),
    );
  });

  it("does not double-post the triggering message when the ordinary hook follows creation", async () => {
    await createMatrixSessionProjection({
      cfg,
      targetSessionKey: sessionKey,
      roomId: "!room",
      initialMessage: { sourceChannel: "slack", content: "One message", messageId: "initial-2" },
    });
    mocks.listBySession.mockReturnValue([projectionBinding]);

    await handleMatrixSessionProjectionMessageReceived(
      { content: "One message", messageId: "initial-2", sessionKey },
      { channelId: "slack", sessionKey },
      cfg,
    );

    expect(mocks.sendMessageMatrix).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent creates so only one Matrix root is posted", async () => {
    let releaseBind: (() => void) | undefined;
    mocks.bind.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseBind = () => {
            mocks.listBySession.mockReturnValue([projectionBinding]);
            resolve(projectionBinding);
          };
        }),
    );

    const first = createMatrixSessionProjection({
      cfg,
      targetSessionKey: sessionKey,
      roomId: "!room",
    });
    const second = createMatrixSessionProjection({
      cfg,
      targetSessionKey: sessionKey,
      roomId: "!room",
    });
    await vi.waitFor(() => expect(mocks.bind).toHaveBeenCalledTimes(1));
    releaseBind?.();

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { status: "created" },
      { status: "existing" },
    ]);
    expect(mocks.bind).toHaveBeenCalledTimes(1);
  });

  it("fails closed before creating a thread for an unknown session", async () => {
    mocks.getSessionEntry.mockReturnValue(undefined);

    await expect(
      createMatrixSessionProjection({ cfg, targetSessionKey: sessionKey, roomId: "!room" }),
    ).rejects.toThrow("target OpenClaw session does not exist");
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it("fails with recovery guidance when the selected Matrix account is not running", async () => {
    mocks.getThreadBindingManager.mockReturnValue(null);

    await expect(
      createMatrixSessionProjection({ cfg, targetSessionKey: sessionKey, roomId: "!room" }),
    ).rejects.toThrow("Matrix account fi-user is not running");
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it("projects Slack user messages with a stable delivery identity and semantic metadata", async () => {
    mocks.listBySession.mockReturnValue([projectionBinding]);

    await handleMatrixSessionProjectionMessageReceived(
      {
        content: "Please check this invoice",
        messageId: "1700000000.000001",
        runId: "run-1",
        sessionKey,
        from: "U123",
      },
      { channelId: "slack", sessionKey },
      cfg,
    );

    expect(mocks.sendMessageMatrix).toHaveBeenCalledWith(
      "room:!room",
      "**Slack · U123**\nPlease check this invoice",
      expect.objectContaining({
        accountId: "fi-user",
        threadId: "$root",
        deliveryQueueId:
          "matrix-session-projection:fi-user:!room:$root:user:1700000000.000001:1700000000.000001:1",
        deliveryPartIndex: 0,
        deliveryPartCount: 1,
        publication: expect.objectContaining({
          version: 2,
          role: "user",
          origin: expect.objectContaining({
            provider: "slack",
            messageId: "1700000000.000001",
            actorId: "U123",
          }),
        }),
      }),
    );
    expect(mocks.touch).toHaveBeenCalledWith(projectionBinding.bindingId);
  });

  it("uses the stable run identity for native chat user messages without a message id", async () => {
    mocks.listBySession.mockReturnValue([projectionBinding]);

    await handleMatrixSessionProjectionMessageReceived(
      {
        content: "Continue this OpenClaw conversation",
        runId: "native-chat-run-1",
        sessionKey,
        senderId: "gateway-client",
      },
      { channelId: "webchat", sessionKey, runId: "native-chat-run-1" },
      cfg,
    );

    expect(mocks.sendMessageMatrix).toHaveBeenCalledWith(
      "room:!room",
      "**OpenClaw · User**\nContinue this OpenClaw conversation",
      expect.objectContaining({
        deliveryQueueId:
          "matrix-session-projection:fi-user:!room:$root:user:native-chat-run-1:native-chat-run-1:1",
        deliveryPartIndex: 0,
        deliveryPartCount: 1,
        publication: expect.objectContaining({
          version: 2,
          role: "user",
          origin: expect.objectContaining({
            provider: "webchat",
            messageId: "native-chat-run-1",
            actorId: "gateway-client",
          }),
        }),
      }),
    );
    expect(mocks.touch).toHaveBeenCalledWith(projectionBinding.bindingId);
  });

  it("uses the binding's authenticated actor for native chat hooks that omit sender identity", async () => {
    const browserBinding = {
      ...projectionBinding,
      metadata: { ...projectionBinding.metadata, sourceActorId: "fi-user-123" },
    };
    mocks.listBySession.mockReturnValue([browserBinding]);
    mocks.resolveByConversation.mockReturnValue(browserBinding);

    await handleMatrixSessionProjectionMessageReceived(
      {
        content: "Continue this OpenClaw conversation",
        runId: "native-chat-run-2",
        sessionKey,
      },
      { channelId: "webchat", sessionKey, runId: "native-chat-run-2" },
      cfg,
    );

    expect(mocks.sendMessageMatrix).toHaveBeenCalledWith(
      "room:!room",
      "**OpenClaw · User**\nContinue this OpenClaw conversation",
      expect.objectContaining({
        publication: expect.objectContaining({
          role: "user",
          origin: expect.objectContaining({
            provider: "webchat",
            messageId: "native-chat-run-2",
            actorId: "fi-user-123",
          }),
        }),
      }),
    );
  });

  it("projects only final visible assistant answers", async () => {
    mocks.listBySession.mockReturnValue([projectionBinding]);
    const context = { channelId: "slack", sessionKey, runId: "run-1" };

    await handleMatrixSessionProjectionReplyPayloadSending(
      { kind: "progress", payload: { text: "Working…" }, sessionKey, runId: "run-1" },
      context,
      cfg,
    );
    await handleMatrixSessionProjectionReplyPayloadSending(
      {
        kind: "final",
        payload: { text: "internal", isReasoning: true },
        sessionKey,
        runId: "run-1",
      },
      context,
      cfg,
    );
    await handleMatrixSessionProjectionReplyPayloadSending(
      { kind: "final", payload: { text: "Invoice is approved." }, sessionKey, runId: "run-1" },
      context,
      cfg,
    );

    expect(mocks.sendMessageMatrix).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessageMatrix).toHaveBeenCalledWith(
      "room:!room",
      "**Slack · Assistant**\nInvoice is approved.",
      expect.objectContaining({
        deliveryQueueId: expect.stringMatching(
          /^matrix-session-projection:fi-user:!room:\$root:assistant:[a-f0-9-]{36}:/,
        ),
        deliveryPartIndex: 0,
        deliveryPartCount: 1,
      }),
    );
  });

  it("projects completed answer blocks without exposing technical or commentary lanes", async () => {
    mocks.listBySession.mockReturnValue([projectionBinding]);
    const context = { channelId: "webchat", sessionKey, runId: "run-block" };
    for (const payload of [
      { text: "reasoning", isReasoning: true },
      { text: "commentary", isCommentary: true },
      { text: "compaction", isCompactionNotice: true },
      { text: "fallback", isFallbackNotice: true },
    ]) {
      await handleMatrixSessionProjectionReplyPayloadSending(
        { kind: "block", payload, sessionKey, runId: "run-block" },
        context,
        cfg,
      );
    }
    await handleMatrixSessionProjectionReplyPayloadSending(
      { kind: "tool", payload: { text: "tool output" }, sessionKey, runId: "run-block" },
      context,
      cfg,
    );
    const answerPayload = { text: "The completed answer." };
    await handleMatrixSessionProjectionReplyPayloadSending(
      { kind: "block", payload: answerPayload, sessionKey, runId: "run-block" },
      context,
      cfg,
    );
    expect(mocks.sendMessageMatrix).toHaveBeenCalledTimes(1);
    // Retrying this exact host payload preserves its immutable publication UUID.
    await handleMatrixSessionProjectionReplyPayloadSending(
      { kind: "block", payload: answerPayload, sessionKey, runId: "run-block" },
      context,
      cfg,
    );
    expect(mocks.sendMessageMatrix).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessageMatrix).toHaveBeenCalledWith(
      "room:!room",
      "**OpenClaw · Assistant**\nThe completed answer.",
      expect.objectContaining({ deliveryPartIndex: 0, deliveryPartCount: 1 }),
    );
  });

  it("mirrors a Slack status ack as an unmentioned room notice, not an assistant answer", async () => {
    mocks.listBySession.mockReturnValue([projectionBinding]);
    const context = { channelId: "slack", sessionKey, runId: "run-status" };
    await handleMatrixSessionProjectionReplyPayloadSending(
      {
        kind: "block",
        payload: { text: "Thinking level set to low.", isStatusNotice: true },
        sessionKey,
        runId: "run-status",
      },
      context,
      cfg,
    );
    await handleMatrixSessionProjectionReplyPayloadSending(
      { kind: "final", payload: { text: "Invoice is approved." }, sessionKey, runId: "run-status" },
      context,
      cfg,
    );
    expect(mocks.sendMessageMatrix).toHaveBeenCalledTimes(2);
    expect(mocks.sendMessageMatrix).toHaveBeenNthCalledWith(
      1,
      "room:!room",
      "Thinking level set to low.",
      expect.objectContaining({
        threadId: "$root",
        includeMentions: false,
        extraContent: { msgtype: "m.notice" },
      }),
    );
    expect(mocks.sendMessageMatrix).toHaveBeenNthCalledWith(
      2,
      "room:!room",
      "**Slack · Assistant**\nInvoice is approved.",
      expect.not.objectContaining({ extraContent: { msgtype: "m.notice" } }),
    );
  });

  it("gives separate final payload chunks stable, distinct delivery identities", async () => {
    mocks.listBySession.mockReturnValue([projectionBinding]);
    const context = { channelId: "slack", sessionKey, runId: "run-1" };

    await handleMatrixSessionProjectionReplyPayloadSending(
      { kind: "final", payload: { text: "First chunk" }, sessionKey, runId: "run-1" },
      context,
      cfg,
    );
    await handleMatrixSessionProjectionReplyPayloadSending(
      { kind: "final", payload: { text: "Second chunk" }, sessionKey, runId: "run-1" },
      context,
      cfg,
    );

    const deliveryIds = mocks.sendMessageMatrix.mock.calls.map(
      (call) => (call[2] as { deliveryQueueId: string }).deliveryQueueId,
    );
    expect(deliveryIds).toHaveLength(2);
    expect(new Set(deliveryIds).size).toBe(2);
    expect(deliveryIds.every((id) => /:assistant:[a-f0-9-]{36}:/.test(id))).toBe(true);
  });

  it("rejects a caller-selected run identity without actual host publication custody", async () => {
    mocks.listBySession.mockReturnValue([projectionBinding]);
    await handleUntrustedReply(
      { kind: "final", payload: { text: "Forged final" }, sessionKey, runId: "run-1" },
      { channelId: "slack", sessionKey },
      cfg,
    );
    expect(mocks.sendMessageMatrix).not.toHaveBeenCalled();
  });

  it("never re-projects Matrix-origin messages", async () => {
    mocks.listBySession.mockReturnValue([projectionBinding]);

    await handleMatrixSessionProjectionMessageReceived(
      { content: "matrix reply", messageId: "$event", sessionKey },
      { channelId: "matrix", sessionKey },
      cfg,
    );

    expect(mocks.sendMessageMatrix).not.toHaveBeenCalled();
  });
});
