import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const mocks = vi.hoisted(() => {
  const listJoinedMembers = vi.fn();
  const resolveAccount = vi.fn((_cfg: unknown, accountId: string) => ({
    userId:
      accountId === "fi-user" ? "@bot_shape_cellect-fi-user:matrix.test" : "@other:matrix.test",
  }));
  const getLoadedChannelPlugin = vi.fn(() => ({
    config: { resolveAccount },
    groups: { listJoinedMembers },
  }));
  return { listJoinedMembers, resolveAccount, getLoadedChannelPlugin };
});

vi.mock("../../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: mocks.getLoadedChannelPlugin,
}));

import { readFiUserMatrixRoom } from "./fi-shadow-matrix-room.js";

const cfg = {
  bindings: [{ agentId: "cellect-fi-user", match: { channel: "matrix", accountId: "fi-user" } }],
} as OpenClawConfig;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getLoadedChannelPlugin.mockReturnValue({
    config: { resolveAccount: mocks.resolveAccount },
    groups: { listJoinedMembers: mocks.listJoinedMembers },
  });
  mocks.listJoinedMembers.mockResolvedValue([
    "@alex=40example=2ecom:matrix.test",
    "@bot_shape_cellect-fi-user:matrix.test",
  ]);
});

it("reads joined members through the cellect-fi-user Matrix account", async () => {
  const assertCurrent = vi.fn();
  await expect(
    readFiUserMatrixRoom({ cfg, roomId: "!room:example.org", assertCurrent }),
  ).resolves.toEqual({
    ok: true,
    accountId: "fi-user",
    accountUserId: "@bot_shape_cellect-fi-user:matrix.test",
    members: ["@alex=40example=2ecom:matrix.test", "@bot_shape_cellect-fi-user:matrix.test"],
  });
  expect(mocks.listJoinedMembers).toHaveBeenCalledWith(
    expect.objectContaining({
      accountId: "fi-user",
      expectedAccountUserId: "@bot_shape_cellect-fi-user:matrix.test",
      groupId: "!room:example.org",
      assertCurrent,
    }),
  );
});

it("reports unavailable when the Matrix plugin has no joined-member read", async () => {
  mocks.getLoadedChannelPlugin.mockReturnValue({
    config: { resolveAccount: mocks.resolveAccount },
    groups: {},
  } as unknown as ReturnType<typeof mocks.getLoadedChannelPlugin>);
  await expect(
    readFiUserMatrixRoom({ cfg, roomId: "!room:example.org", assertCurrent: () => {} }),
  ).resolves.toEqual({ ok: false, reason: "unavailable" });
});

it("reports unjoined when the account's read throws", async () => {
  mocks.listJoinedMembers.mockRejectedValue(new Error("Native Matrix account is not joined"));
  await expect(
    readFiUserMatrixRoom({ cfg, roomId: "!room:example.org", assertCurrent: () => {} }),
  ).resolves.toEqual({ ok: false, reason: "unjoined" });
});
