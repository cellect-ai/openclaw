// Covers the direct owner notice that makes a pairing request discoverable
// without tailing the gateway log or running the CLI speculatively.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn<(message: string) => void>(),
}));

const pluginMocks = vi.hoisted(() => ({
  getLoadedChannelPlugin: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    warn: loggerMocks.warn,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: pluginMocks.getLoadedChannelPlugin,
}));

import {
  buildStalePairingOwnerText,
  notifyPairingRequestedOwner,
  notifyPairingStaleOwner,
  registerPairingOwnerRequestNotifications,
  resolvePairingOwnerTarget,
} from "./pairing-owner-notify.js";
import {
  recordChannelPairingRequested,
  resetChannelPairingRequestedListeners,
} from "./pairing-request-notice.js";

type FakeSlackPlugin = {
  id: "slack";
  config: {
    resolveAllowFrom: (params: { cfg: unknown; accountId?: string }) => string[] | undefined;
  };
};

type DeliverCall = {
  cfg: unknown;
  channel: string;
  to: string;
  accountId?: string;
  text: string;
};

function fakeDeliver(result: { ok: boolean; error?: unknown } = { ok: true }) {
  return vi.fn((_params: DeliverCall) => Promise.resolve(result));
}

function slackPluginWithAllowFrom(byAccount: Record<string, string[]>): FakeSlackPlugin {
  return {
    id: "slack",
    config: {
      resolveAllowFrom: ({ accountId }) => (accountId ? byAccount[accountId] : undefined),
    },
  };
}

beforeEach(() => {
  loggerMocks.warn.mockClear();
  pluginMocks.getLoadedChannelPlugin.mockReset();
  resetChannelPairingRequestedListeners();
});

afterEach(() => {
  resetChannelPairingRequestedListeners();
});

describe("resolvePairingOwnerTarget", () => {
  it("prefers a configured owner scoped to this channel", () => {
    pluginMocks.getLoadedChannelPlugin.mockReturnValue(
      slackPluginWithAllowFrom({ "fi-user": ["U-FALLBACK"] }),
    );
    const target = resolvePairingOwnerTarget({
      cfg: { commands: { ownerAllowFrom: ["telegram:999", "slack:U-OWNER"] } } as never,
      channel: "slack",
      accountId: "fi-user",
    });
    expect(target).toEqual({ channel: "slack", to: "U-OWNER" });
  });

  it("treats an unprefixed configured owner as channel-agnostic", () => {
    pluginMocks.getLoadedChannelPlugin.mockReturnValue(slackPluginWithAllowFrom({}));
    const target = resolvePairingOwnerTarget({
      cfg: { commands: { ownerAllowFrom: ["U-GLOBAL-OWNER"] } } as never,
      channel: "slack",
      accountId: "fi-user",
    });
    expect(target).toEqual({ channel: "slack", to: "U-GLOBAL-OWNER" });
  });

  it("ignores a configured owner scoped to a different channel", () => {
    pluginMocks.getLoadedChannelPlugin.mockReturnValue(
      slackPluginWithAllowFrom({ "fi-user": ["U-FALLBACK"] }),
    );
    const target = resolvePairingOwnerTarget({
      cfg: { commands: { ownerAllowFrom: ["telegram:999"] } } as never,
      channel: "slack",
      accountId: "fi-user",
    });
    expect(target).toEqual({ channel: "slack", to: "U-FALLBACK" });
  });

  it("falls back to this exact account's own allowlist when no owner is configured", () => {
    pluginMocks.getLoadedChannelPlugin.mockReturnValue(
      slackPluginWithAllowFrom({ "fi-user": ["U-FI-USER-1", "U-FI-USER-2"] }),
    );
    const target = resolvePairingOwnerTarget({
      cfg: {} as never,
      channel: "slack",
      accountId: "fi-user",
    });
    expect(target).toEqual({ channel: "slack", to: "U-FI-USER-1" });
  });

  it("never uses another account's allowlist (tenant isolation)", () => {
    const plugin = slackPluginWithAllowFrom({
      "fi-user": ["U-FI-USER"],
      "fi-admin": ["U-FI-ADMIN"],
    });
    pluginMocks.getLoadedChannelPlugin.mockReturnValue(plugin);

    const fiUserTarget = resolvePairingOwnerTarget({
      cfg: {} as never,
      channel: "slack",
      accountId: "fi-user",
    });
    const fiAdminTarget = resolvePairingOwnerTarget({
      cfg: {} as never,
      channel: "slack",
      accountId: "fi-admin",
    });

    expect(fiUserTarget).toEqual({ channel: "slack", to: "U-FI-USER" });
    expect(fiAdminTarget).toEqual({ channel: "slack", to: "U-FI-ADMIN" });
  });

  it("resolves nothing when the channel plugin is not loaded", () => {
    pluginMocks.getLoadedChannelPlugin.mockReturnValue(undefined);
    const target = resolvePairingOwnerTarget({
      cfg: {} as never,
      channel: "slack",
      accountId: "fi-user",
    });
    expect(target).toBeUndefined();
  });

  it("resolves nothing when neither a configured owner nor an account allowlist exists", () => {
    pluginMocks.getLoadedChannelPlugin.mockReturnValue(slackPluginWithAllowFrom({}));
    const target = resolvePairingOwnerTarget({
      cfg: {} as never,
      channel: "slack",
      accountId: "fi-user",
    });
    expect(target).toBeUndefined();
  });
});

describe("notifyPairingRequestedOwner", () => {
  it("delivers a plain-text notice naming who asked and the review command", async () => {
    const deliver = fakeDeliver();
    const resolveTarget = vi.fn(() => ({ channel: "slack", to: "U-OWNER" }));

    const result = await notifyPairingRequestedOwner(
      { channel: "slack", accountId: "fi-user", senderId: "U123" },
      { getConfig: () => ({}) as never, deliver, resolveTarget },
    );

    expect(result).toEqual({ sent: true });
    expect(resolveTarget).toHaveBeenCalledWith({
      cfg: {},
      channel: "slack",
      accountId: "fi-user",
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    const call = deliver.mock.calls[0]?.[0];
    expect(call?.channel).toBe("slack");
    expect(call?.to).toBe("U-OWNER");
    expect(call?.accountId).toBe("fi-user");
    expect(call?.text).toContain("slack:fi-user");
    expect(call?.text).toContain("U123");
    expect(call?.text).toContain("openclaw pairing list --channel slack --account fi-user");
  });

  it("never throws when no owner route resolves", async () => {
    const deliver = vi.fn();
    const resolveTarget = vi.fn(() => undefined);

    const result = await notifyPairingRequestedOwner(
      { channel: "slack", accountId: "fi-user", senderId: "U123" },
      { getConfig: () => ({}) as never, deliver, resolveTarget },
    );

    expect(result).toEqual({ sent: false, reason: "no-owner-route" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("never throws when delivery fails", async () => {
    const deliver = fakeDeliver({ ok: false, error: new Error("boom") });
    const resolveTarget = vi.fn(() => ({ channel: "slack", to: "U-OWNER" }));

    const result = await notifyPairingRequestedOwner(
      { channel: "slack", accountId: "fi-user", senderId: "U123" },
      { getConfig: () => ({}) as never, deliver, resolveTarget },
    );

    expect(result).toEqual({ sent: false, reason: "delivery-failed" });
    expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
  });

  it("never throws when the resolver itself throws", async () => {
    const deliver = vi.fn();
    const resolveTarget = vi.fn(() => {
      throw new Error("boom");
    });

    await expect(
      notifyPairingRequestedOwner(
        { channel: "slack", accountId: "fi-user", senderId: "U123" },
        { getConfig: () => ({}) as never, deliver, resolveTarget },
      ),
    ).resolves.toEqual({ sent: false, reason: "error" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("keeps two accounts' arrival notices from merging (tenant isolation)", async () => {
    const deliver = fakeDeliver();
    const resolveTarget = vi.fn(
      ({ accountId }: { accountId?: string }) =>
        ({
          channel: "slack",
          to: accountId === "fi-user" ? "U-FI-USER-OWNER" : "U-FI-ADMIN-OWNER",
        }) as { channel: string; to: string } | undefined,
    );

    await notifyPairingRequestedOwner(
      { channel: "slack", accountId: "fi-user", senderId: "U-REQUESTER-1" },
      { getConfig: () => ({}) as never, deliver, resolveTarget },
    );
    await notifyPairingRequestedOwner(
      { channel: "slack", accountId: "fi-admin", senderId: "U-REQUESTER-2" },
      { getConfig: () => ({}) as never, deliver, resolveTarget },
    );

    expect(deliver).toHaveBeenCalledTimes(2);
    const [fiUserCall, fiAdminCall] = deliver.mock.calls.map((call) => call[0]);
    expect(fiUserCall?.to).toBe("U-FI-USER-OWNER");
    expect(fiUserCall?.text).toContain("U-REQUESTER-1");
    expect(fiUserCall?.text).not.toContain("U-REQUESTER-2");
    expect(fiAdminCall?.to).toBe("U-FI-ADMIN-OWNER");
    expect(fiAdminCall?.text).toContain("U-REQUESTER-2");
    expect(fiAdminCall?.text).not.toContain("U-REQUESTER-1");
  });
});

describe("notifyPairingStaleOwner", () => {
  it("delivers a plain-text notice with age and the review command", async () => {
    const deliver = fakeDeliver();
    const resolveTarget = vi.fn(() => ({ channel: "slack", to: "U-OWNER" }));

    const result = await notifyPairingStaleOwner(
      { channel: "slack", accountId: "fi-user", senderId: "U123", ageLabel: "27h" },
      { getConfig: () => ({}) as never, deliver, resolveTarget },
    );

    expect(result).toEqual({ sent: true });
    const call = deliver.mock.calls[0]?.[0];
    expect(call?.text).toBe(
      buildStalePairingOwnerText({
        channel: "slack",
        accountId: "fi-user",
        senderId: "U123",
        ageLabel: "27h",
      }),
    );
    expect(call?.text).toContain("27h");
    expect(call?.text).toContain("openclaw pairing list --channel slack --account fi-user");
  });
});

describe("registerPairingOwnerRequestNotifications", () => {
  it("notifies on arrival through the shared core listener hook", async () => {
    const deliver = fakeDeliver();
    const resolveTarget = vi.fn(() => ({ channel: "slack", to: "U-OWNER" }));
    const dispose = registerPairingOwnerRequestNotifications({
      getConfig: () => ({}) as never,
      deliver,
      resolveTarget,
    });

    try {
      recordChannelPairingRequested({ channel: "slack", accountId: "fi-user", senderId: "U123" });
      // The listener fires the notify fire-and-forget; flush microtasks.
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      dispose();
    }

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[0]?.to).toBe("U-OWNER");
  });

  it("stops notifying once disposed", async () => {
    const deliver = fakeDeliver();
    const resolveTarget = vi.fn(() => ({ channel: "slack", to: "U-OWNER" }));
    const dispose = registerPairingOwnerRequestNotifications({
      getConfig: () => ({}) as never,
      deliver,
      resolveTarget,
    });
    dispose();

    recordChannelPairingRequested({ channel: "slack", accountId: "fi-user", senderId: "U123" });
    await Promise.resolve();
    await Promise.resolve();

    expect(deliver).not.toHaveBeenCalled();
  });
});
