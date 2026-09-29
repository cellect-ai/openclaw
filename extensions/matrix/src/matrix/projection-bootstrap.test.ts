import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../types.js";
import type { MatrixThreadBindingRecord } from "./thread-bindings-shared.js";

const mocks = vi.hoisted(() => ({
  rows: [] as MatrixThreadBindingRecord[],
  joined: vi.fn(),
  send: vi.fn(),
  bind: vi.fn(),
  persist: vi.fn(),
  running: true,
}));
vi.mock("./accounts.js", () => ({
  listMatrixAccountIds: () => ["test-account"],
  resolveMatrixAccount: () => ({ enabled: true, configured: true, config: {} }),
}));
vi.mock("./thread-bindings-shared.js", () => ({
  listAllBindings: () => mocks.rows,
  listBindingsForAccount: (id: string) => mocks.rows.filter((row) => row.accountId === id),
  getMatrixThreadBindingManager: () => (mocks.running ? { persist: mocks.persist } : undefined),
  resolveBindingKey: (row: MatrixThreadBindingRecord) =>
    `${row.accountId}:${row.parentConversationId}:${row.conversationId}`,
}));
vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/conversation-binding-runtime")>()),
  getSessionBindingService: () => ({ bind: mocks.bind }),
}));
vi.mock("openclaw/plugin-sdk/session-binding-runtime", () => ({
  inspectSessionBindingByConversation: () => ({ status: "available", binding: null }),
}));
vi.mock("./send/client.js", () => ({
  withResolvedMatrixSendClient: (_options: unknown, callback: (client: unknown) => unknown) =>
    callback({
      getJoinedRooms: mocks.joined,
      getUserId: async () => "@bot:example.org",
      sendEvent: mocks.send,
    }),
}));
import { bootstrapMatrixSessionProjection } from "./projection-bootstrap.js";

const cfg = {
  agents: { list: [{ id: "native-owner" }, { id: "other" }] },
  bindings: [{ agentId: "native-owner", match: { channel: "matrix", accountId: "test-account" } }],
} as CoreConfig;
const request = {
  accountId: "test-account",
  roomId: "!native:example.org",
  environment: "test",
  conversationId: "canonical-conversation",
  agentId: "native-owner",
};

describe("native Matrix projection bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rows.length = 0;
    mocks.running = true;
    mocks.persist.mockResolvedValue(undefined);
    mocks.joined.mockResolvedValue([request.roomId]);
    mocks.send.mockResolvedValue("$actual-root");
    mocks.bind.mockImplementation(async (input) => {
      mocks.rows.push({
        ...input.conversation,
        ...input.metadata,
        targetSessionKey: input.targetSessionKey,
        targetKind: "subagent",
        boundAt: 1,
        lastActivityAt: 1,
      });
    });
  });
  it("resolves the real native route without an existing session and is idempotent", async () => {
    const first = await bootstrapMatrixSessionProjection(cfg, request);
    expect(first).toMatchObject({
      environment: "test",
      conversationId: request.conversationId,
      threadRootEventId: "$actual-root",
      agentId: "native-owner",
      targetSessionKey: "agent:native-owner:matrix:channel:!native:example.org:thread:$actual-root",
    });
    expect(mocks.bind).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: "current",
        metadata: expect.objectContaining({ introText: false }),
      }),
    );
    expect(await bootstrapMatrixSessionProjection(cfg, request)).toEqual(first);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.bind).toHaveBeenCalledTimes(1);
  });
  it("rejects agent routing mismatch before publishing or binding", async () => {
    await expect(
      bootstrapMatrixSessionProjection(cfg, { ...request, agentId: "other" }),
    ).rejects.toThrow("route");
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("requires a running explicit account and existing bot membership", async () => {
    mocks.running = false;
    await expect(bootstrapMatrixSessionProjection(cfg, request)).rejects.toThrow("running");
    mocks.running = true;
    await expect(
      bootstrapMatrixSessionProjection(cfg, { ...request, accountId: "absent" }),
    ).rejects.toThrow("running");
    mocks.joined.mockResolvedValue([]);
    await expect(bootstrapMatrixSessionProjection(cfg, request)).rejects.toThrow(
      "already be joined",
    );
    expect(mocks.bind).not.toHaveBeenCalled();
  });
  it.each([
    { boundBy: "session-projection-read-only" },
    { environment: "other" },
    { projectedConversationId: "other" },
    { accountId: "other" },
    { targetSessionKey: "agent:native-owner:slack:direct:u123" },
    {
      externalSource: {
        provider: "slack",
        workspaceId: "T1",
        channelId: "C1",
        rootMessageId: "1.2",
      },
    },
  ])("does not overwrite a foreign/source owner %j", async (change) => {
    await bootstrapMatrixSessionProjection(cfg, request);
    const binding = mocks.rows[0];
    if (!binding) throw new Error("Expected persisted bootstrap binding");
    Object.assign(binding, change);
    await expect(bootstrapMatrixSessionProjection(cfg, request)).rejects.toThrow(
      "different or source-backed",
    );
    expect(mocks.bind).toHaveBeenCalledTimes(1);
  });
  it("rechecks the source fence after the root network operation", async () => {
    mocks.send.mockImplementationOnce(async () => {
      mocks.rows.push({
        accountId: "other",
        conversationId: request.roomId,
      } as MatrixThreadBindingRecord);
      return "$root";
    });
    await expect(bootstrapMatrixSessionProjection(cfg, request)).rejects.toThrow("owner");
    expect(mocks.bind).not.toHaveBeenCalled();
  });
  it("retries an unpersisted root with the same Matrix transaction identity", async () => {
    mocks.bind.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(bootstrapMatrixSessionProjection(cfg, request)).rejects.toThrow(
      "disk unavailable",
    );
    await bootstrapMatrixSessionProjection(cfg, request);
    expect(mocks.send.mock.calls[0]?.[3]).toBe(mocks.send.mock.calls[1]?.[3]);
  });
  it("does not accept a caller selected session key", async () => {
    await expect(
      bootstrapMatrixSessionProjection(cfg, { ...request, targetSessionKey: "arbitrary" }),
    ).rejects.toThrow("supplied session");
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("does not acknowledge an in-memory binding whose durable write still fails", async () => {
    await bootstrapMatrixSessionProjection(cfg, request);
    mocks.persist.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(bootstrapMatrixSessionProjection(cfg, request)).rejects.toThrow(
      "disk unavailable",
    );
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
});
