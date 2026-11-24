import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSourceReplyAuthorization } from "./source-reply-authorization.js";

const entry = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  getSessionEntry: entry,
  sessionDeliveryOrigin: (value: unknown) => value,
}));

describe("source reply authorization", () => {
  it("recovers a legacy Matrix-continued DM only with one explicit account and exact live peer proof", async () => {
    entry.mockReturnValue({
      provider: "matrix",
      accountId: "fiuserprod",
      nativeChannelId: "!room:example.test",
    });
    const sessionKey = "agent:cellect-fi-user:slack:direct:u123";
    const source = {
      provider: "slack",
      workspaceId: "T123",
      channelId: "D123",
      rootMessageId: sessionKey,
      peerSenderId: "U123",
    };
    const readDirectIdentity = vi
      .fn()
      .mockResolvedValue({ workspaceId: "T123", channelId: "D123", peerSenderId: "U123" });
    const bindings = [
      { agentId: "cellect-fi-user", match: { channel: "slack", accountId: "fi-user" } },
    ];
    let guard:
      | {
          resolveSource: (params: {
            targetSessionKey: string;
            externalSource?: typeof source;
          }) => Promise<{ sourceAccountId: string }>;
        }
      | undefined;
    const api = {
      config: { bindings },
      runtime: {
        channel: {
          runtimeContexts: {
            get: () => ({ workspaceId: "T123", readDirectIdentity }),
            register: (params: { context: typeof guard }) => {
              guard = params.context;
            },
          },
        },
      },
    } as unknown as OpenClawPluginApi;
    registerSourceReplyAuthorization(api, () => ({
      baseUrl: "https://fi.example.test",
      token: "test-bridge",
    }));
    if (!guard) {
      throw new Error("Expected source guard");
    }
    await expect(
      guard.resolveSource({ targetSessionKey: sessionKey, externalSource: source }),
    ).resolves.toMatchObject({ sourceAccountId: "fi-user" });
    expect(readDirectIdentity).toHaveBeenCalledWith("D123", "U123");
    await expect(guard.resolveSource({ targetSessionKey: sessionKey })).rejects.toThrow(
      "Source account identity is unavailable",
    );
    await expect(
      guard.resolveSource({
        targetSessionKey: sessionKey,
        externalSource: { ...source, peerSenderId: "U456" },
      }),
    ).rejects.toThrow("identity mismatch");
    readDirectIdentity.mockRejectedValueOnce(new Error("Slack DM peer mismatch"));
    await expect(
      guard.resolveSource({ targetSessionKey: sessionKey, externalSource: source }),
    ).rejects.toThrow("peer mismatch");
    bindings.push({
      agentId: "cellect-fi-user",
      match: { channel: "slack", accountId: "other-account" },
    });
    await expect(
      guard.resolveSource({ targetSessionKey: sessionKey, externalSource: source }),
    ).rejects.toThrow("Source account identity is unavailable");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    entry.mockReset();
  });
  it("rechecks Slack and Fi on every send, preserving native identity after Matrix continuation", async () => {
    const source = {
      provider: "slack",
      workspaceId: "T123",
      channelId: "C123",
      rootMessageId: "1700000000.000001",
    };
    const binding = {
      targetSessionKey: "agent:cellect-fi-admin:slack:channel:c123:thread:1700000000.000001",
      sourceAccountId: "fi-admin",
      externalSource: source,
    };
    entry.mockReturnValue({
      provider: "matrix",
      accountId: "fiuserprod",
      nativeChannelId: "!room:example.test",
    });
    const readChannel = vi
      .fn()
      .mockResolvedValue({ workspaceId: "T123", channelId: "C123", memberSenderIds: ["U123"] });
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ allowed: true }) })
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ allowed: false }) });
    vi.stubGlobal("fetch", request);
    let guard:
      | {
          authorize: (params: {
            binding: typeof binding;
            matrixRoomId: string;
            matrixSenderId: string;
          }) => Promise<"allowed" | "denied" | "unavailable">;
        }
      | undefined;
    const api = {
      config: {
        bindings: [
          { agentId: "cellect-fi-admin", match: { channel: "slack", accountId: "fi-admin" } },
        ],
      },
      runtime: {
        channel: {
          runtimeContexts: {
            get: () => ({ workspaceId: "T123", readChannel }),
            register: (params: { context: typeof guard }) => {
              guard = params.context;
            },
          },
        },
      },
    } as unknown as OpenClawPluginApi;
    registerSourceReplyAuthorization(api, () => ({
      baseUrl: "https://fi.example.test",
      token: "test-bridge",
    }));
    if (!guard) {
      throw new Error("Expected source guard registration");
    }
    const send = {
      binding,
      matrixRoomId: "!room:example.test",
      matrixSenderId: "@member:example.test",
    };
    await expect(guard.authorize(send)).resolves.toBe("allowed");
    await expect(guard.authorize(send)).resolves.toBe("denied");
    expect(readChannel).toHaveBeenCalledTimes(2);
    expect(JSON.parse(request.mock.calls[0]?.[1].body ?? "null")).toMatchObject({
      sessionKey: binding.targetSessionKey,
      agentId: "cellect-fi-admin",
      matrixSenderId: send.matrixSenderId,
      source: { memberSenderIds: ["U123"] },
    });
    await expect(
      guard.authorize({ ...send, binding: { ...binding, sourceAccountId: "other-account" } }),
    ).rejects.toThrow("not authorized");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("preserves superadmin channel and private DM identities through Matrix continuation", async () => {
    const source = {
      provider: "slack",
      workspaceId: "T123",
      channelId: "C123",
      rootMessageId: "1700000000.000001",
    };
    const sessionKey = "agent:cellect-main:slack:channel:c123:thread:1700000000.000001";
    const readChannel = vi.fn().mockResolvedValue({
      workspaceId: "T123",
      channelId: "C123",
      memberSenderIds: ["U123"],
    });
    const readDirectIdentity = vi.fn().mockResolvedValue({
      workspaceId: "T123",
      channelId: "D123",
      peerSenderId: "U123",
    });
    const bindings = [
      { agentId: "cellect-main", match: { channel: "slack", accountId: "superadmin" } },
    ];
    let guard:
      | {
          resolveSource: (params: {
            targetSessionKey: string;
            externalSource?: typeof source & { peerSenderId?: string };
          }) => Promise<{ sourceAccountId: string }>;
        }
      | undefined;
    entry.mockReturnValue({ provider: "slack", accountId: "superadmin", nativeChannelId: "C123" });
    const api = {
      config: { bindings },
      runtime: {
        channel: {
          runtimeContexts: {
            get: () => ({ workspaceId: "T123", readChannel, readDirectIdentity }),
            register: (params: { context: typeof guard }) => {
              guard = params.context;
            },
          },
        },
      },
    } as unknown as OpenClawPluginApi;
    registerSourceReplyAuthorization(api, () => ({
      baseUrl: "https://fi.example.test",
      token: "test-bridge",
    }));
    if (!guard) {
      throw new Error("Expected source guard");
    }
    await expect(
      guard.resolveSource({ targetSessionKey: sessionKey, externalSource: source }),
    ).resolves.toMatchObject({ sourceAccountId: "superadmin", externalSource: source });
    expect(readChannel).toHaveBeenCalledWith("C123");
    entry.mockReturnValue({ provider: "slack", accountId: "superadmin", nativeChannelId: "D123" });
    await expect(
      guard.resolveSource({
        targetSessionKey: "agent:cellect-main:slack:direct:u123",
        externalSource: {
          ...source,
          channelId: "D123",
          rootMessageId: "agent:cellect-main:slack:direct:u123",
          peerSenderId: "U123",
        },
      }),
    ).resolves.toMatchObject({
      sourceAccountId: "superadmin",
      externalSource: {
        workspaceId: "T123",
        channelId: "D123",
        peerSenderId: "U123",
      },
    });
    expect(readDirectIdentity).toHaveBeenCalledWith("D123", "U123");
  });
  it("authorizes a legacy channel-thread binding by the channel in its session key", async () => {
    // Conversation 05fd8c16: the binding predates sourceAccountId and the
    // session's delivery origin has since moved off the thread's channel.
    entry.mockReturnValue({ provider: "slack", accountId: "fi-admin", nativeChannelId: "D0MOVED" });
    const sessionKey = "agent:cellect-fi-admin:slack:channel:c0bjlaws49h:thread:1789671390.087299";
    const source = {
      provider: "slack",
      workspaceId: "T123",
      channelId: "C0BJLAWS49H",
      rootMessageId: "1789671390.087299",
    };
    const readChannel = vi.fn(async (channelId: string) => ({
      workspaceId: "T123",
      channelId,
      memberSenderIds: ["U123"],
    }));
    let guard:
      | {
          resolveSource: (params: {
            targetSessionKey: string;
            externalSource?: typeof source;
            sourceAccountId?: string;
          }) => Promise<{ sourceAccountId: string }>;
        }
      | undefined;
    const api = {
      config: {
        bindings: [
          { agentId: "cellect-fi-admin", match: { channel: "slack", accountId: "fi-admin" } },
        ],
      },
      runtime: {
        channel: {
          runtimeContexts: {
            get: () => ({ workspaceId: "T123", readChannel }),
            register: (params: { context: typeof guard }) => {
              guard = params.context;
            },
          },
        },
      },
    } as unknown as OpenClawPluginApi;
    registerSourceReplyAuthorization(api, () => ({
      baseUrl: "https://fi.example.test",
      token: "test-bridge",
    }));
    if (!guard) {
      throw new Error("Expected source guard");
    }
    await expect(
      guard.resolveSource({ targetSessionKey: sessionKey, externalSource: source }),
    ).resolves.toMatchObject({ sourceAccountId: "fi-admin", externalSource: source });
    expect(readChannel).toHaveBeenCalledWith("C0BJLAWS49H");
    await expect(guard.resolveSource({ targetSessionKey: sessionKey })).resolves.toMatchObject({
      externalSource: source,
    });
    // A binding naming another channel is still refused.
    await expect(
      guard.resolveSource({
        targetSessionKey: sessionKey,
        externalSource: { ...source, channelId: "C0OTHER" },
      }),
    ).rejects.toThrow("Source origin mismatch");
    // Every other check still applies: an unconfigured origin account is refused.
    entry.mockReturnValue({ provider: "slack", accountId: "fi-user", nativeChannelId: "D0MOVED" });
    await expect(
      guard.resolveSource({ targetSessionKey: sessionKey, externalSource: source }),
    ).rejects.toThrow("Source account is not authorized for this agent");
    // A durable binding keeps using its recorded account and source.
    entry.mockReturnValue({ provider: "slack", accountId: "fi-admin", nativeChannelId: "D0MOVED" });
    await expect(
      guard.resolveSource({
        targetSessionKey: sessionKey,
        externalSource: { ...source, channelId: "C0OTHER" },
        sourceAccountId: "fi-admin",
      }),
    ).rejects.toThrow("Source channel identity mismatch");
  });
});
