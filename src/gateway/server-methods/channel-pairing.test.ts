import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  approve: vi.fn(),
  bootstrapOwner: vi.fn(),
  dismiss: vi.fn(),
  hasOwners: vi.fn(),
  listPlugins: vi.fn(),
  listRequests: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: mocks.listPlugins,
}));
vi.mock("../../channels/plugins/pairing.js", () => ({
  notifyPairingApproved: mocks.notify,
}));
vi.mock("../../commands/doctor-command-owner.js", () => ({
  hasConfiguredCommandOwners: mocks.hasOwners,
}));
vi.mock("../../pairing/command-owner.js", () => ({
  bootstrapCommandOwnerFromPairing: mocks.bootstrapOwner,
}));
// Store access is mocked; the retention helpers are pure and their output is
// part of what these handlers are expected to publish.
vi.mock("../../pairing/pairing-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../pairing/pairing-store.js")>()),
  approveChannelPairingRequest: mocks.approve,
  dismissChannelPairingRequest: mocks.dismiss,
  listChannelPairingRequests: mocks.listRequests,
  resolveChannelPairingRequestId: vi.fn(() => "opaque-request-id"),
}));

import {
  CHANNEL_PAIRING_HISTORY_MAX,
  CHANNEL_PAIRING_PENDING_MAX,
  CHANNEL_PAIRING_PENDING_TTL_MS,
  CHANNEL_PAIRING_STALE_AFTER_MS,
} from "../../pairing/pairing-store.js";
import { channelPairingHandlers } from "./channel-pairing.js";

const notifyApproval = vi.fn(async () => undefined);
const pairingPlugin = {
  id: "whatsapp",
  meta: { label: "WhatsApp" },
  pairing: { idLabel: "Phone number", notifyApproval },
  config: {
    listAccountIds: () => ["personal", "public", "unconfigured"],
    resolveAccount: (_cfg: unknown, accountId: string) => ({
      configured: accountId !== "unconfigured",
      dmPolicy: accountId === "public" ? "open" : "pairing",
      name: accountId === "personal" ? "Personal" : accountId,
    }),
    isConfigured: (account: { configured: boolean }) => account.configured,
    describeAccount: (account: { name: string }) => ({
      accountId: account.name,
      name: account.name,
    }),
  },
  security: {
    resolveDmPolicy: ({ account }: { account: { dmPolicy: string } }) => ({
      policy: account.dmPolicy,
      allowFromPath: "channels.whatsapp.allowFrom",
      approveHint: "approve",
    }),
  },
};

function createContext() {
  return {
    getRuntimeConfig: () => ({}),
    logGateway: { warn: vi.fn() },
  };
}

async function invoke(
  method: keyof typeof channelPairingHandlers,
  params: Record<string, unknown>,
) {
  const respond = vi.fn();
  const handler = expectDefined(channelPairingHandlers[method], `${method} test invariant`);
  await handler({
    params,
    respond,
    context: createContext(),
  } as unknown as Parameters<typeof handler>[0]);
  return respond;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listPlugins.mockReturnValue([pairingPlugin]);
  mocks.hasOwners.mockReturnValue(false);
  mocks.listRequests.mockResolvedValue([]);
  mocks.bootstrapOwner.mockResolvedValue({ ownerEntry: "whatsapp:+1555", status: "configured" });
});

describe("channel DM pairing gateway handlers", () => {
  it("lists only pairing-policy accounts without exposing the human code", async () => {
    // Status and staleness are relative to now, so pin it against the fixture.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T10:10:00.000Z"));
    mocks.listRequests.mockResolvedValue([
      {
        id: "workspace:personal:user:+15551234567",
        code: "SECRET12",
        createdAt: "2026-07-20T10:00:00.000Z",
        lastSeenAt: "2026-07-20T10:05:00.000Z",
        status: "pending",
        meta: { accountId: "personal", name: "Alice", senderId: "+15551234567" },
      },
    ]);

    const respond = await invoke("channels.pairing.list", {});

    expect(mocks.listRequests).toHaveBeenCalledTimes(1);
    expect(mocks.listRequests).toHaveBeenCalledWith("whatsapp", process.env, "personal");
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        accounts: [
          {
            channel: "whatsapp",
            channelLabel: "WhatsApp",
            accountId: "personal",
            accountLabel: "Personal",
            notifySupported: true,
          },
        ],
        requests: [
          {
            requestId: "opaque-request-id",
            channel: "whatsapp",
            channelLabel: "WhatsApp",
            accountId: "personal",
            accountLabel: "Personal",
            senderId: "+15551234567",
            senderLabel: "Phone number",
            metadata: { name: "Alice" },
            createdAt: "2026-07-20T10:00:00.000Z",
            lastSeenAt: "2026-07-20T10:05:00.000Z",
            expiresAt: "2026-07-27T10:00:00.000Z",
            status: "pending",
            stale: false,
            notifySupported: true,
          },
        ],
        history: [],
        commandOwnerConfigured: false,
        limits: {
          pendingPerAccount: CHANNEL_PAIRING_PENDING_MAX,
          historyPerAccount: CHANNEL_PAIRING_HISTORY_MAX,
          ttlMs: CHANNEL_PAIRING_PENDING_TTL_MS,
          staleAfterMs: CHANNEL_PAIRING_STALE_AFTER_MS,
        },
      },
      undefined,
    );
    expect(JSON.stringify(respond.mock.calls)).not.toContain("SECRET12");
    vi.useRealTimers();
  });

  it("lists an expired request as history rather than dropping it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T10:00:00.000Z"));
    mocks.listRequests.mockResolvedValue([
      {
        id: "workspace:personal:user:+15551234567",
        code: "SECRET12",
        createdAt: "2026-07-20T10:00:00.000Z",
        lastSeenAt: "2026-07-20T10:05:00.000Z",
        status: "pending",
        meta: { accountId: "personal", senderId: "+15551234567" },
      },
    ]);

    const respond = await invoke("channels.pairing.list", {});

    const result = respond.mock.calls[0]?.[1] as {
      requests: unknown[];
      history: Array<{ status: string; senderId: string }>;
    };
    // An approver must never be handed an unapprovable row as pending.
    expect(result.requests).toEqual([]);
    expect(result.history).toHaveLength(1);
    expect(result.history[0]?.status).toBe("expired");
    expect(result.history[0]?.senderId).toBe("+15551234567");
    expect(JSON.stringify(respond.mock.calls)).not.toContain("SECRET12");
    vi.useRealTimers();
  });

  it("approves access even when the optional notification fails", async () => {
    mocks.approve.mockResolvedValue({
      id: "workspace:personal:user:+15551234567",
      entry: {
        id: "workspace:personal:user:+15551234567",
        code: "SECRET12",
        createdAt: "2026-07-20T10:00:00.000Z",
        lastSeenAt: "2026-07-20T10:00:00.000Z",
        status: "pending",
        meta: { accountId: "personal", senderId: "+15551234567" },
      },
    });
    mocks.notify.mockRejectedValue(new Error("offline"));

    const respond = await invoke("channels.pairing.approve", {
      channel: "whatsapp",
      accountId: "personal",
      requestId: "opaque-request-id",
      notify: true,
      bootstrapCommandOwner: true,
    });

    expect(mocks.approve).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "personal",
      requestId: "opaque-request-id",
      pairingAdapter: pairingPlugin.pairing,
    });
    expect(mocks.bootstrapOwner).toHaveBeenCalledWith({
      channel: "whatsapp",
      id: "workspace:personal:user:+15551234567",
    });
    expect(mocks.notify).toHaveBeenCalledWith({
      channelId: "whatsapp",
      accountId: "personal",
      id: "workspace:personal:user:+15551234567",
      cfg: expect.any(Object),
      pairingAdapter: pairingPlugin.pairing,
      meta: { accountId: "personal", senderId: "+15551234567" },
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        requestId: "opaque-request-id",
        senderId: "+15551234567",
        notification: "failed",
        commandOwnerBootstrap: "configured",
      },
      undefined,
    );
  });

  it("reports command-owner setup failure without rolling back DM approval", async () => {
    mocks.approve.mockResolvedValue({
      id: "+15551234567",
      entry: {
        id: "+15551234567",
        code: "SECRET12",
        createdAt: "2026-07-20T10:00:00.000Z",
        lastSeenAt: "2026-07-20T10:00:00.000Z",
      },
    });
    mocks.bootstrapOwner.mockRejectedValue(new Error("config write failed"));

    const respond = await invoke("channels.pairing.approve", {
      channel: "whatsapp",
      accountId: "personal",
      requestId: "opaque-request-id",
      bootstrapCommandOwner: true,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        requestId: "opaque-request-id",
        senderId: "+15551234567",
        notification: "not-requested",
        commandOwnerBootstrap: "unavailable",
      },
      undefined,
    );
  });

  it("dismisses a request without approving the sender", async () => {
    mocks.dismiss.mockResolvedValue({
      id: "+15551234567",
      entry: {
        id: "+15551234567",
        code: "SECRET12",
        createdAt: "2026-07-20T10:00:00.000Z",
        lastSeenAt: "2026-07-20T10:00:00.000Z",
      },
    });

    const respond = await invoke("channels.pairing.dismiss", {
      channel: "whatsapp",
      accountId: "personal",
      requestId: "opaque-request-id",
    });

    expect(mocks.dismiss).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "personal",
      requestId: "opaque-request-id",
    });
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      { requestId: "opaque-request-id", senderId: "+15551234567" },
      undefined,
    );
  });
});
