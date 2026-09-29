import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  rebaseMatrixSessionProjection,
  createMatrixSessionProjection,
} from "./session-projection.js";

const mocks = vi.hoisted(() => ({
  records: [] as Array<{
    accountId: string;
    conversationId: string;
    parentConversationId: string;
    targetSessionKey: string;
    boundAt: number;
    boundBy: string;
  }>,
  bind: vi.fn(),
  unbind: vi.fn(),
  send: vi.fn(),
  reconcile: vi.fn(),
  request: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/agent-scope-runtime", () => ({
  resolveSessionAgentIdStrict: () => "fi-agent",
}));
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  getSessionEntry: () => ({ sessionId: "native" }),
}));
vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", () => ({
  getSessionBindingService: () => ({
    bind: mocks.bind,
    unbind: mocks.unbind,
    listBySession: () => [],
  }),
}));
vi.mock("./accounts.js", () => ({ resolveDefaultMatrixAccountId: () => "transport" }));
vi.mock("./send.js", () => ({ sendMessageMatrix: mocks.send }));
vi.mock("./send/client.js", () => ({
  withResolvedMatrixSendClient: async (
    _options: unknown,
    run: (client: unknown) => Promise<unknown>,
  ) => run({ doRequest: mocks.request }),
}));
vi.mock("./session-projection-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-projection-snapshot.js")>()),
  reconcileMatrixProjectionSnapshot: mocks.reconcile,
}));
vi.mock("./thread-bindings-shared.js", () => ({
  getMatrixThreadBindingManager: () => ({ listBindings: () => mocks.records }),
  toSessionBindingRecord: (record: {
    conversationId: string;
    parentConversationId: string;
    boundBy: string;
  }) => ({
    bindingId: record.conversationId,
    conversation: {
      channel: "matrix",
      accountId: "transport",
      conversationId: record.conversationId,
      parentConversationId: record.parentConversationId,
    },
    metadata: { boundBy: record.boundBy },
  }),
}));
const options = {
  cfg: {} as never,
  targetSessionKey: "agent:fi-agent:slack:channel:c123:thread:1700000000.000001",
  roomId: "!room",
  accountId: "transport",
  expectedThreadRootEventId: "$old",
  sourceSnapshot: { complete: true as const, messages: [] },
};
describe("Matrix projection history generation repair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.records.splice(0, mocks.records.length, {
      accountId: "transport",
      conversationId: "$old",
      parentConversationId: "!room",
      targetSessionKey: options.targetSessionKey,
      boundAt: 1,
      boundBy: "session-projection-read-only",
    });
    mocks.request.mockImplementation(async (_method: string, path: string) =>
      path.includes("/state/")
        ? { history_visibility: "shared" }
        : { content: { "com.openclaw.projection_rebase": { previousRootId: "$old" } } },
    );
    mocks.send.mockResolvedValue({ messageId: "$new" });
    mocks.bind.mockImplementation(async () => {
      const existing = mocks.records[0];
      if (!existing) {
        throw new Error("Missing test binding");
      }
      mocks.records.push({ ...existing, conversationId: "$new", boundAt: 2 });
      return {
        bindingId: "$new",
        conversation: {
          channel: "matrix",
          accountId: "transport",
          conversationId: "$new",
          parentConversationId: "!room",
        },
        metadata: { boundBy: "session-projection-slack-direct" },
      };
    });
    mocks.unbind.mockImplementation(async () => {
      const index = mocks.records.findIndex((record) => record.conversationId === "$old");
      if (index >= 0) {
        mocks.records.splice(index, 1);
      }
    });
    mocks.reconcile.mockResolvedValue(undefined);
  });
  it("requires a matching read-only native parent for detached source history", async () => {
    const detached = {
      ...options,
      sourceDetached: true,
      externalSource: {
        provider: "slack",
        workspaceId: "T123",
        channelId: "C123",
        rootMessageId: "1700000000.000001",
      },
    };
    await expect(createMatrixSessionProjection({ ...detached, readOnly: true })).rejects.toThrow(
      "matching read-only parent",
    );
    await expect(
      createMatrixSessionProjection({
        ...detached,
        targetSessionKey: "agent:fi-agent:slack:group:c123",
      }),
    ).rejects.toThrow("matching read-only parent");
  });
  it("requires shared policy before creating a replacement root", async () => {
    mocks.request.mockResolvedValue({ history_visibility: "joined" });
    await expect(rebaseMatrixSessionProjection(options)).rejects.toThrow("Shared history policy");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.bind).not.toHaveBeenCalled();
  });
  it("allows source-backed writable history only for an existing native direct session", async () => {
    await expect(createMatrixSessionProjection({ ...options, sourceDirect: true })).rejects.toThrow(
      "canonical Slack DM",
    );
    const result = await createMatrixSessionProjection({
      ...options,
      targetSessionKey: "agent:fi-agent:slack:direct:w111",
      sourceDirect: true,
    });
    expect(result.threadRootEventId).toBe("$new");
    expect(mocks.bind).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ boundBy: "session-projection-slack-direct" }),
      }),
    );
    // Direct history reconciles into the new generation; legacy reply retirement was
    // removed with durable projection receipts.
    expect(mocks.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: expect.any(String), threadId: "$new" }),
    );
  });
  it("resumes the persisted new generation after replay failure without making another root", async () => {
    mocks.reconcile.mockRejectedValueOnce(new Error("replay failed"));
    await expect(rebaseMatrixSessionProjection(options)).rejects.toThrow("replay failed");
    expect(mocks.unbind).not.toHaveBeenCalled();
    const result = await rebaseMatrixSessionProjection(options);
    expect(result.threadRootEventId).toBe("$new");
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.bind).toHaveBeenCalledTimes(1);
    expect(mocks.reconcile).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadId: "$new", retireThreadId: "$old" }),
    );
    expect(mocks.unbind).toHaveBeenCalledWith({
      bindingId: "$old",
      reason: "projection-history-rebased",
    });
  });
});
