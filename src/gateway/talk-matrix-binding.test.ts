import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const listAccountIds = vi.fn(() => ["user-prod", "admin-prod"]);
  const resolveAccount = vi.fn((_cfg: unknown, accountId: string) => ({
    userId: accountId === "admin-prod" ? "@admin:matrix.test" : "@user:matrix.test",
  }));
  const getLoadedChannelPlugin = vi.fn<
    () =>
      | { config: { listAccountIds: typeof listAccountIds; resolveAccount: typeof resolveAccount } }
      | undefined
  >(() => ({ config: { listAccountIds, resolveAccount } }));
  return {
    listAccountIds,
    resolveAccount,
    getLoadedChannelPlugin,
    resolveRoute: vi.fn(async () => ({ sessionKey: "agent:admin:matrix:room:thread:root" })),
    resolveOwner: vi.fn(() => ({ agentId: "admin" })),
  };
});

vi.mock("../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: mocks.getLoadedChannelPlugin,
}));
vi.mock("../infra/outbound/outbound-session.js", () => ({
  resolveOutboundSessionRoute: mocks.resolveRoute,
}));
vi.mock("./conversation-route-ownership.js", () => ({
  resolveLoadedPluginConversationRouteOwner: mocks.resolveOwner,
}));

import { resolveMatrixTalkBinding } from "./talk-matrix-binding.js";

describe("resolveMatrixTalkBinding", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the configured Matrix account and canonical outbound thread resolver", async () => {
    const cfg = {
      bindings: [{ agentId: "admin", match: { channel: "matrix", accountId: "admin-prod" } }],
    } as never;
    await expect(
      resolveMatrixTalkBinding({
        cfg,
        roomId: "!room:matrix.test",
        threadRootEventId: "$root",
        agentMxid: "@admin:matrix.test",
      }),
    ).resolves.toEqual({
      sessionKey: "agent:admin:matrix:room:thread:root",
      agentId: "admin",
      accountId: "admin-prod",
    });
    expect(mocks.resolveRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "matrix",
        agentId: "admin",
        accountId: "admin-prod",
        target: "room:!room:matrix.test",
        threadId: "$root",
      }),
    );
    expect(mocks.resolveOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          accountId: "admin-prod",
          nativeChannelId: "!room:matrix.test",
          threadId: "$root",
        }),
      }),
    );
  });

  it("uses the exact room owner instead of the first account-wide binding", async () => {
    mocks.resolveOwner.mockReturnValueOnce({ agentId: "room-admin" });
    await resolveMatrixTalkBinding({
      cfg: {
        bindings: [
          {
            agentId: "wrong-account-default",
            match: { channel: "matrix", accountId: "admin-prod" },
          },
          {
            agentId: "room-admin",
            match: {
              channel: "matrix",
              accountId: "admin-prod",
              peer: { kind: "channel", id: "!room:matrix.test" },
            },
          },
        ],
      } as never,
      roomId: "!room:matrix.test",
      threadRootEventId: "$root",
      agentMxid: "@admin:matrix.test",
    });
    expect(mocks.resolveRoute).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "room-admin", target: "room:!room:matrix.test" }),
    );
  });

  it("fails closed when an MXID does not identify exactly one account", async () => {
    mocks.listAccountIds.mockReturnValueOnce([]);
    await expect(
      resolveMatrixTalkBinding({
        cfg: {} as never,
        roomId: "!room:matrix.test",
        threadRootEventId: "$root",
        agentMxid: "@unknown:matrix.test",
      }),
    ).rejects.toThrow("did not resolve uniquely");
    expect(mocks.resolveRoute).not.toHaveBeenCalled();
  });

  it("fails closed when the Matrix plugin is not loaded", async () => {
    mocks.getLoadedChannelPlugin.mockReturnValueOnce(undefined);
    await expect(
      resolveMatrixTalkBinding({
        cfg: {} as never,
        roomId: "!room:matrix.test",
        threadRootEventId: "$root",
        agentMxid: "@admin:matrix.test",
      }),
    ).rejects.toThrow("Matrix Talk channel is unavailable");
    expect(mocks.resolveRoute).not.toHaveBeenCalled();
  });
});
