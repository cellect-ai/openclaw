/**
 * Regression coverage for plugin tool context and delivery metadata.
 * Verifies requester metadata, workspace selection, and delivery routing.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveOpenClawPluginToolInputs,
  type OpenClawPluginToolOptions,
} from "./openclaw-tools.plugin-context.js";

function resolve(options: OpenClawPluginToolOptions) {
  return resolveOpenClawPluginToolInputs({ options: { config: {}, ...options } });
}

describe("openclaw plugin tool context", () => {
  it("forwards trusted requester sender identity", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        requesterSenderId: "trusted-sender",
      },
    });

    expect(result.context.requesterSenderId).toBe("trusted-sender");
  });

  it("forwards the trusted owner bit", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        senderIsOwner: true,
      },
    });

    expect(result.context.senderIsOwner).toBe(true);
  });

  it("forwards the trusted native conversation id", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        nativeChannelId: "oc_native_chat",
      },
    });

    expect(result.context.nativeChannelId).toBe("oc_native_chat");
  });

  it("forwards the inbound message identity without deriving it from the reply route", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        agentChannel: "matrix",
        nativeChannelId: "!room:example",
        currentMessageId: "$inbound",
        agentThreadId: "$thread-root",
        requesterSenderId: "@requester:example",
      },
    });
    expect(result.context.currentMessageId).toBe("$inbound");
    expect(result.context.nativeChannelId).toBe("!room:example");
    expect(result.context.requesterSenderId).toBe("@requester:example");
    expect(resolveOpenClawPluginToolInputs({}).context.currentMessageId).toBeUndefined();
  });

  it("defaults missing and unknown conversation-read origins to delegated", () => {
    const missing = resolveOpenClawPluginToolInputs({
      options: { config: {} as never },
    });
    const unknown = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        conversationReadOrigin: "forged" as never,
      },
    });

    expect(missing.context.conversationReadOrigin).toBe("delegated");
    expect(unknown.context.conversationReadOrigin).toBe("delegated");
  });

  it("preserves a server-owned direct-operator origin", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        conversationReadOrigin: "direct-operator",
      },
    });

    expect(result.context.conversationReadOrigin).toBe("direct-operator");
  });

  it("forwards fs policy for plugin tool sandbox enforcement", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        fsPolicy: { workspaceOnly: true },
      },
    });

    expect(result.context.fsPolicy).toStrictEqual({ workspaceOnly: true });
  });

  it("forwards ephemeral sessionId", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        agentSessionKey: "agent:main:telegram:direct:12345",
        sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      },
    });

    expect(result.context.sessionKey).toBe("agent:main:telegram:direct:12345");
    expect(result.context.sessionId).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });

  it("forwards trusted private conversation recall context", () => {
    const conversationRecall = {
      anchorSessionKey: "agent:main:telegram:direct:owner",
      scope: "same-agent-private" as const,
      corpus: "sessions" as const,
    };
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        conversationRecall,
      },
    });

    expect(result.context.conversationRecall).toEqual(conversationRecall);
  });

  it("forwards host-prepared active project keys", () => {
    const activeProjectKeys = ["github.com/OpenClaw/OpenClaw"];
    const result = resolveOpenClawPluginToolInputs({
      options: { config: {} as never, activeProjectKeys },
    });

    expect(result.context.activeProjectKeys).toBe(activeProjectKeys);
  });

  it("forwards runtime-owned active model metadata", () => {
    const result = resolve({
      modelProvider: " local-provider ",
      modelId: " local-model ",
    });

    expect(result.context.activeModel).toStrictEqual({
      provider: "local-provider",
      modelId: "local-model",
      modelRef: "local-provider/local-model",
    });
  });

  it("does not duplicate provider-qualified active model refs", () => {
    const result = resolve({
      modelProvider: "openrouter",
      modelId: "openrouter/auto",
    });

    expect(result.context.activeModel).toStrictEqual({
      provider: "openrouter",
      modelId: "openrouter/auto",
      modelRef: "openrouter/auto",
    });
  });

  it("uses requester agent override for synthetic embedded session keys", () => {
    const recallWorkspace = path.join(process.cwd(), "tmp-recall-workspace");
    const config = {
      agents: {
        defaults: { workspace: path.join(process.cwd(), "tmp-default-workspace") },
        list: [
          { id: "main", default: true },
          { id: "recall", workspace: recallWorkspace },
        ],
      },
    } as never;
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config,
        agentSessionKey: "explicit:user-session:active-memory:abc123",
        requesterAgentIdOverride: "recall",
      },
      resolvedConfig: config,
    });

    expect(result.context.agentId).toBe("recall");
    expect(result.context.workspaceDir).toBe(recallWorkspace);
  });

  it("keeps the routable conversation target ahead of the native channel id", () => {
    const result = resolve({
      agentChannel: "slack",
      currentMessagingTarget: "user:U123",
      currentChannelId: "D123",
    });

    expect(result.context.deliveryContext?.to).toBe("user:U123");
  });
});
