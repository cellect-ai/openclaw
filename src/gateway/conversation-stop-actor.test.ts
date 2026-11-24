import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "./server-methods/types.js";

const mocks = vi.hoisted(() => ({
  route: vi.fn(),
  member: vi.fn(),
  plugin: vi.fn(),
  routeCurrent: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("./talk-matrix-binding.js", () => ({ prepareMatrixTalkBinding: mocks.route }));
vi.mock("../channels/plugins/index.js", () => ({ getLoadedChannelPlugin: mocks.plugin }));
import { prepareConversationStopActor } from "./conversation-stop-actor.js";

async function resolveConversationStopActor(
  params: Parameters<typeof prepareConversationStopActor>[0],
) {
  const admission = await prepareConversationStopActor(params);
  try {
    admission?.assertCurrent();
    return admission?.actor;
  } finally {
    admission?.dispose();
  }
}

const deviceId = "a".repeat(64);
const assertion = {
  roomId: "!room:matrix.test",
  threadRootEventId: "$root",
  agentMxid: "@bot:matrix.test",
  userId: "@person:matrix.test",
};
const route = {
  sessionKey: "agent:bot:matrix:room:thread:root",
  agentId: "bot",
  accountId: "bot-account",
  assertCurrent: mocks.routeCurrent,
  dispose: mocks.dispose,
};
function request() {
  const client: GatewayClient = {
    pairedClientId: "gateway-client",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "gateway-client", version: "test", platform: "test", mode: "backend" },
      role: "operator",
      scopes: ["operator.admin"],
      device: {
        id: deviceId,
        publicKey: "paired-key",
        signature: "verified-signature",
        signedAt: 1,
        nonce: "nonce",
      },
    },
  };
  return {
    cfg: {},
    client,
    assertion: { ...assertion },
    sessionKey: route.sessionKey,
    agentId: route.agentId,
    assertCurrent: vi.fn(),
    env: { OPENCLAW_CONVERSATION_CONTROL_ISSUER_DEVICE_IDS: deviceId },
  };
}

describe("application Stop actor admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.routeCurrent.mockReset();
    mocks.route.mockResolvedValue(route);
    mocks.member.mockResolvedValue(true);
    mocks.plugin.mockReturnValue({ groups: { isJoinedMember: mocks.member } });
  });

  it("requires the configured paired issuer, exact route and native membership", async () => {
    const input = request();
    const actor = await resolveConversationStopActor(input);
    expect(actor).toEqual({
      userId: assertion.userId,
      roomId: assertion.roomId,
      threadRootEventId: assertion.threadRootEventId,
      sessionKey: route.sessionKey,
      agentId: route.agentId,
    });
    expect(Object.isFrozen(actor)).toBe(true);
    expect(mocks.route).toHaveBeenCalledWith({
      cfg: {},
      roomId: assertion.roomId,
      threadRootEventId: assertion.threadRootEventId,
      agentMxid: assertion.agentMxid,
      readCurrentConfig: undefined,
    });
    expect(mocks.member).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: route.accountId,
        expectedAccountUserId: assertion.agentMxid,
        groupId: assertion.roomId,
        userId: assertion.userId,
      }),
    );
  });

  it("keeps an unattributed legacy request distinct from an unverified person claim", async () => {
    await expect(
      resolveConversationStopActor({ ...request(), assertion: undefined, client: null }),
    ).resolves.toBeUndefined();
    expect(mocks.route).not.toHaveBeenCalled();
  });

  it.each([
    "unconfigured",
    "wildcard",
    "unpaired",
    "write-only",
    "invalidated",
    "synthetic",
    "node",
  ])("rejects %s issuer before native reads", async (kind) => {
    const input = request();
    if (kind === "unconfigured") {
      input.env.OPENCLAW_CONVERSATION_CONTROL_ISSUER_DEVICE_IDS = "";
    }
    if (kind === "wildcard") {
      input.env.OPENCLAW_CONVERSATION_CONTROL_ISSUER_DEVICE_IDS = "*";
    }
    if (kind === "unpaired") {
      delete input.client.pairedClientId;
    }
    if (kind === "write-only") {
      input.client.connect.scopes = ["operator.write"];
    }
    if (kind === "invalidated") {
      input.client.invalidated = true;
    }
    if (kind === "synthetic") {
      input.client.internal = { syntheticClient: true };
    }
    if (kind === "node") {
      input.client.connect.role = "node";
    }
    await expect(resolveConversationStopActor(input)).rejects.toThrow("issuer");
    expect(mocks.route).not.toHaveBeenCalled();
  });

  it.each(["session", "agent", "member", "unknown-membership", "missing-adapter"])(
    "refuses mismatched or unknown %s proof",
    async (kind) => {
      if (kind === "session") {
        mocks.route.mockResolvedValue({ ...route, sessionKey: "elsewhere" });
      }
      if (kind === "agent") {
        mocks.route.mockResolvedValue({ ...route, agentId: "other" });
      }
      if (kind === "member") {
        mocks.member.mockResolvedValue(false);
      }
      if (kind === "unknown-membership") {
        mocks.member.mockRejectedValue(new Error("native read failed"));
      }
      if (kind === "missing-adapter") {
        mocks.plugin.mockReturnValue({});
      }
      await expect(resolveConversationStopActor(request())).rejects.toThrow();
    },
  );

  it.each(["userId", "roomId", "threadRootEventId", "agentMxid"] as const)(
    "rejects malformed %s before native reads",
    async (field) => {
      const input = request();
      input.assertion[field] = "unverified display name";
      await expect(resolveConversationStopActor(input)).rejects.toThrow("invalid");
      expect(mocks.route).not.toHaveBeenCalled();
    },
  );

  it.each(["principal", "issuer", "scope", "transport"])(
    "rechecks %s after awaited native proof",
    async (kind) => {
      const input = request();
      let revoked = false;
      const controller = new AbortController();
      input.client.connectionSignal = controller.signal;
      input.assertCurrent.mockImplementation(() => {
        if (revoked) {
          throw new Error("revoked");
        }
      });
      mocks.member.mockImplementationOnce(async () => {
        if (kind === "principal") {
          revoked = true;
        }
        if (kind === "issuer") {
          input.env.OPENCLAW_CONVERSATION_CONTROL_ISSUER_DEVICE_IDS = "";
        }
        if (kind === "scope") {
          input.client.connect.scopes = [];
        }
        if (kind === "transport") {
          controller.abort();
        }
        return true;
      });
      await expect(resolveConversationStopActor(input)).rejects.toThrow();
    },
  );

  it("snapshots the issuer assertion across asynchronous proof", async () => {
    const input = request();
    mocks.route.mockImplementationOnce(async () => {
      input.assertion.userId = "@foreign:matrix.test";
      return route;
    });
    expect((await resolveConversationStopActor(input))?.userId).toBe(assertion.userId);
    expect(mocks.member).toHaveBeenCalledWith(
      expect.objectContaining({ userId: assertion.userId }),
    );
  });
  it("rejects a binding replacement during membership and disposes the prepared owner", async () => {
    mocks.member.mockImplementationOnce(async () => {
      mocks.routeCurrent.mockImplementation(() => {
        throw new Error("binding replaced");
      });
      return true;
    });
    await expect(prepareConversationStopActor(request())).rejects.toThrow("binding replaced");
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("retains route and issuer checks until cancellation effects settle", async () => {
    const input = request();
    const prepared = await prepareConversationStopActor(input);
    expect(prepared).toBeDefined();
    expect(mocks.dispose).not.toHaveBeenCalled();
    prepared!.assertCurrent();
    input.env.OPENCLAW_CONVERSATION_CONTROL_ISSUER_DEVICE_IDS = "";
    expect(() => prepared!.assertCurrent()).toThrow("issuer");
    input.env.OPENCLAW_CONVERSATION_CONTROL_ISSUER_DEVICE_IDS = deviceId;
    mocks.routeCurrent.mockImplementation(() => {
      throw new Error("binding replaced");
    });
    expect(() => prepared!.assertCurrent()).toThrow("binding replaced");
    prepared!.dispose();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});
