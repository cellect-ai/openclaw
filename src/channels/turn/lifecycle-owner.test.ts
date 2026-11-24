// Preserve mock setup before modules that consume it.
// oxfmt-ignore
import { channelTurnMocks } from "./run-channel-turn.test-support.js";
import { describe, expect, it, vi } from "vitest";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import { createPluginRuntimeStore } from "../../plugin-sdk/runtime-store.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { dispatchAssembledChannelTurn } from "./lifecycle.js";
import {
  createCtx,
  createRecordInboundSession,
  createReplyDispatchReceipt,
} from "./run-channel-turn.delivery.test-helpers.js";

describe("channel delivery plugin ownership", () => {
  it("restores the channel owner for provider tool replies and fences retired callbacks", async () => {
    const channel = new PluginInstance("matrix");
    const provider = new PluginInstance("codex");
    const replacement = new PluginInstance("matrix");
    const runtime = createPluginRuntimeStore<string>({
      pluginId: "matrix",
      errorMessage: "Matrix runtime not initialized",
    });
    const observed = vi.fn();
    let retainedDeliver:
      | Parameters<DispatchReplyWithBufferedBlockDispatcher>[0]["dispatcherOptions"]["deliver"]
      | undefined;
    channelTurnMocks.getGlobalHookRunner.mockReturnValue(null);
    const dispatch: DispatchReplyWithBufferedBlockDispatcher = async (params) => {
      retainedDeliver = params.dispatcherOptions.deliver;
      await provider.run(async () => {
        await Promise.resolve();
        await retainedDeliver!({ text: "Agent needs input:" }, { kind: "tool" });
      });
      return {
        queuedFinal: false,
        counts: { tool: 1, block: 0, final: 0 },
        settledReceipt: createReplyDispatchReceipt({ tool: { delivered: 1 } }),
      };
    };

    try {
      await channel.run(() => {
        runtime.setRuntime("original channel runtime");
        return dispatchAssembledChannelTurn({
          cfg: {},
          agentId: "main",
          storePath: "/unused/channel-owner-test/sessions.json",
          recordInboundSession: createRecordInboundSession(),
          channel: "matrix",
          routeSessionKey: "agent:main:matrix:peer",
          ctxPayload: createCtx({ Provider: "matrix", Surface: "matrix" }),
          dispatchReplyWithBufferedBlockDispatcher: dispatch,
          delivery: {
            preparePayload: (payload) => {
              observed("prepare", runtime.getRuntime());
              return payload;
            },
            deliver: async () => {
              await Promise.resolve();
              observed("deliver", runtime.getRuntime());
              return { visibleReplySent: true };
            },
          },
        });
      });
      expect(observed.mock.calls).toEqual([
        ["prepare", "original channel runtime"],
        ["deliver", "original channel runtime"],
      ]);

      await channel.dispose();
      replacement.run(() => runtime.setRuntime("replacement channel runtime"));
      await expect(
        provider.run(() => retainedDeliver!({ text: "stale question" }, { kind: "tool" })),
      ).rejects.toThrow(/reloaded or disabled/);
      expect(observed).toHaveBeenCalledTimes(2);
    } finally {
      await channel.dispose();
      await provider.dispose();
      await replacement.dispose();
    }
  });
});
