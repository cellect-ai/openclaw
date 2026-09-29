import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot } from "../../config/plugin-auto-enable.test-helpers.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { buildInboundReplyPayloadSendingBeforeDeliver } from "./deliver-hooks.js";

afterEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

describe("inbound reply hook scope", () => {
  it("retains its inbound generation when a model-only generation emits an answer block", async () => {
    const handler = vi.fn(async () => undefined);
    const inbound = createMockPluginRegistry([{ hookName: "reply_payload_sending", handler }]);
    setActivePluginRegistry(inbound);
    initializeGlobalHookRunner(inbound);
    const config = {};
    const metadataSnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    const modelRegistry = createMockPluginRegistry([]);
    const inboundStage = buildInboundReplyPayloadSendingBeforeDeliver(
      { Provider: "webchat", Surface: "webchat", SessionKey: "agent:fixture:device:owned" },
      { runId: "run-owned" },
    );
    await withPluginRuntimeGenerationScope(
      { config, metadataSnapshot, pluginRegistry: modelRegistry },
      async () => {
        expect(await inboundStage({ text: "The answer" }, { kind: "block" })).toEqual({
          text: "The answer",
        });
      },
    );
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "block",
        runId: "run-owned",
        sessionKey: "agent:fixture:device:owned",
        payload: { text: "The answer" },
      }),
      expect.anything(),
    );
  });
  it("uses the captured inbound owner, not another model or the process root", async () => {
    const rootHandler = vi.fn(async () => undefined);
    const inboundHandler = vi.fn(async () => undefined);
    const modelHandler = vi.fn(async () => undefined);
    const root = createMockPluginRegistry([
      { hookName: "reply_payload_sending", handler: rootHandler },
    ]);
    const inbound = createMockPluginRegistry([
      { hookName: "reply_payload_sending", handler: inboundHandler },
    ]);
    const model = createMockPluginRegistry([
      { hookName: "reply_payload_sending", handler: modelHandler },
    ]);
    setActivePluginRegistry(root);
    initializeGlobalHookRunner(root);
    const config = {};
    const metadataSnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    const stage = withPluginRuntimeGenerationScope(
      { config, metadataSnapshot, pluginRegistry: inbound },
      () =>
        buildInboundReplyPayloadSendingBeforeDeliver(
          { Provider: "webchat", Surface: "webchat", SessionKey: "agent:fixture:device:owned" },
          { runId: "run-owned" },
        ),
    );
    await withPluginRuntimeGenerationScope(
      { config, metadataSnapshot, pluginRegistry: model },
      async () => {
        await stage({ text: "The answer" }, { kind: "final" });
      },
    );
    expect(inboundHandler).toHaveBeenCalledOnce();
    expect(rootHandler).not.toHaveBeenCalled();
    expect(modelHandler).not.toHaveBeenCalled();
  });
});
