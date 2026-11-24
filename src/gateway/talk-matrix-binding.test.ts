import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listAccountIds: vi.fn(),
  resolveAccount: vi.fn(),
  getLoadedChannelPlugin: vi.fn(),
  resolveRoute: vi.fn(),
  resolveOwner: vi.fn(),
  assertBindingCurrent: vi.fn(),
  dispose: vi.fn(),
  prepareBindings: vi.fn(),
}));
vi.mock("../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: mocks.getLoadedChannelPlugin,
}));
vi.mock("../infra/outbound/outbound-session.js", () => ({
  resolveOutboundSessionRoute: mocks.resolveRoute,
}));
vi.mock("../infra/outbound/session-binding-service.js", () => ({
  prepareSessionBindingInspections: mocks.prepareBindings,
}));
import { prepareMatrixTalkBinding, resolveMatrixTalkBinding } from "./talk-matrix-binding.js";

const request = {
  cfg: {},
  roomId: "!room:matrix.test",
  threadRootEventId: "$root",
  agentMxid: "@admin:matrix.test",
};
function plugin() {
  return {
    config: { listAccountIds: mocks.listAccountIds, resolveAccount: mocks.resolveAccount },
    messaging: {
      prepareConversationRouteOwnersAsync: async (
        inputs: unknown[],
        inspect: (refs: unknown[]) => Promise<() => unknown>,
      ) => {
        const read = await inspect([]);
        return inputs.map(() => () => {
          read();
          return mocks.resolveOwner();
        });
      },
    },
  };
}

describe("native Matrix Talk binding owner", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.listAccountIds.mockReturnValue(["user-prod", "admin-prod"]);
    mocks.resolveAccount.mockImplementation((_cfg, id) => ({
      userId: id === "admin-prod" ? "@admin:matrix.test" : "@user:matrix.test",
    }));
    mocks.getLoadedChannelPlugin.mockReturnValue(plugin());
    mocks.resolveRoute.mockResolvedValue({ sessionKey: "agent:admin:matrix:room:thread:root" });
    mocks.resolveOwner.mockReturnValue({ kind: "agent", agentId: "admin" });
    mocks.prepareBindings.mockResolvedValue({
      inspect: () => {
        mocks.assertBindingCurrent();
        return [];
      },
      dispose: mocks.dispose,
    });
  });
  it("uses exact native worker-backed ownership and releases one-shot reads", async () => {
    await expect(resolveMatrixTalkBinding(request)).resolves.toEqual({
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
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it("uses exact room ownership rather than an account default", async () => {
    mocks.resolveOwner.mockReturnValue({ kind: "agent", agentId: "room-admin" });
    await resolveMatrixTalkBinding(request);
    expect(mocks.resolveRoute).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "room-admin" }),
    );
  });
  it("identifies token-only accounts through the operational hook", async () => {
    const selected = plugin();
    const sync = vi.fn(() => ({ userId: undefined }));
    const asyncResolve = vi.fn(async (_cfg: unknown, id?: string | null) => ({
      userId: id === "admin-prod" ? "@admin:matrix.test" : "@user:matrix.test",
    }));
    mocks.getLoadedChannelPlugin.mockReturnValue({
      ...selected,
      config: { ...selected.config, resolveAccount: sync, resolveAccountAsync: asyncResolve },
    });
    await expect(resolveMatrixTalkBinding(request)).resolves.toMatchObject({
      accountId: "admin-prod",
    });
    expect(sync).not.toHaveBeenCalled();
  });
  it.each(["missing plugin", "ambiguous account", "unavailable binding", "plugin-owned"])(
    "refuses %s before outbound routing",
    async (kind) => {
      if (kind === "missing plugin") mocks.getLoadedChannelPlugin.mockReturnValue(undefined);
      if (kind === "ambiguous account") mocks.listAccountIds.mockReturnValue([]);
      if (kind === "unavailable binding")
        mocks.resolveOwner.mockReturnValue({ kind: "unavailable" });
      if (kind === "plugin-owned")
        mocks.resolveOwner.mockReturnValue({
          kind: "plugin",
          pluginId: "other",
          fallbackAgentId: "admin",
        });
      await expect(resolveMatrixTalkBinding(request)).rejects.toThrow();
      expect(mocks.resolveRoute).not.toHaveBeenCalled();
    },
  );
  it("retains exact binding generation through outbound preparation and disposal", async () => {
    const retained = await prepareMatrixTalkBinding(request);
    expect(mocks.dispose).not.toHaveBeenCalled();
    mocks.assertBindingCurrent.mockImplementation(() => {
      throw new Error("binding generation changed");
    });
    expect(retained.assertCurrent).toThrow("binding generation changed");
    retained.dispose();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(retained.assertCurrent).toThrow("owner changed");
  });
  it("rejects reload after asynchronous routing and disposes captured snapshots", async () => {
    mocks.resolveRoute.mockImplementation(async () => {
      mocks.getLoadedChannelPlugin.mockReturnValue(plugin());
      return { sessionKey: "agent:admin:matrix:room:thread:root" };
    });
    await expect(prepareMatrixTalkBinding(request)).rejects.toThrow("owner changed");
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});
