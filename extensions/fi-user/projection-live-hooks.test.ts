import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";

const repair = vi.hoisted(() => ({
  wake: vi.fn(),
  noteActivity: vi.fn(),
  retryChannelProjection: vi.fn(),
  channelProjectionSucceeded: vi.fn(),
}));
vi.mock("./channel-projection.js", async (original) => ({
  ...(await original<typeof import("./channel-projection.js")>()),
  registerSlackProjectionReconciler: () => repair,
}));
import fiUserPlugin from "./index.js";

describe("registered live Slack projection hooks", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });
  it.each(["message_received", "message_sent"])(
    "queues failed %s snapshots without blocking Slack",
    async (kind) => {
      vi.stubEnv("TEST_PROJECTION_BROKER", "fixture-broker-token");
      const hooks = new Map<string, Array<(event: never, context: never) => unknown>>();
      let rejectRead: ((error: Error) => void) | undefined;
      const read = new Promise<never>((_resolve, reject) => {
        rejectRead = reject;
      });
      const readThread = vi.fn(() => read);
      const warn = vi.fn();
      fiUserPlugin.register?.(
        createTestPluginApi({
          id: "fi-user",
          name: "Fi User Delegation",
          config: {
            plugins: {
              entries: {
                "fi-user": {
                  config: {
                    baseUrl: "https://fi.example.test",
                    brokerTokenEnv: "TEST_PROJECTION_BROKER",
                  },
                },
              },
            },
          },
          logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
          runtime: {
            channel: {
              runtimeContexts: {
                register: vi.fn(),
                get: () => ({ workspaceId: "T123", botUserId: "U222", readThread }),
              },
            },
          } as unknown as OpenClawPluginApi["runtime"],
          on: (name, handler) => {
            hooks.set(name, [...(hooks.get(name) ?? []), handler as never]);
          },
        }),
      );
      const sessionKey = "agent:cellect-fi-admin:slack:channel:c123:thread:1700000000.000001";
      for (const hook of hooks.get(kind) ?? []) {
        await hook(
          {
            content: "private user text",
            senderId: "U12345678",
            success: true,
            sessionKey,
          } as never,
          { channelId: "slack", accountId: "fi-admin", sessionKey } as never,
        );
      }
      expect(repair.retryChannelProjection).not.toHaveBeenCalled();
      if (!rejectRead) {
        throw new Error("Missing pending Slack reader");
      }
      rejectRead(new Error("Slack snapshot deadline exceeded"));
      await vi.waitFor(() =>
        expect(repair.retryChannelProjection).toHaveBeenCalledWith(sessionKey),
      );
      expect(readThread).toHaveBeenCalledWith("C123", "1700000000.000001");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("kind=source_deadline"));
      expect(JSON.stringify(warn.mock.calls)).not.toContain("private user text");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("fixture-broker-token");
    },
  );
});
