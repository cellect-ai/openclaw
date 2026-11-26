import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { resolveMemoryAudienceFromEntry } from "../plugins/memory-audience.js";
import { fakeSessionOwner } from "../plugins/memory-audience.test-support.js";
import {
  resolveOpenClawPluginToolInputs,
  type OpenClawPluginToolOptions,
} from "./openclaw-tools.plugin-context.js";

vi.mock("../config/sessions/session-delivery-generation.js", async () => {
  const { fakeSessionGenerationModule } =
    await import("../plugins/memory-audience.test-support.js");
  return fakeSessionGenerationModule;
});

function resolve(options: OpenClawPluginToolOptions) {
  return resolveOpenClawPluginToolInputs({
    options: { config: {}, ...options },
    resolvedConfig: options.config,
  }).context;
}

it("forwards one host-minted memory audience and its currency assertion", async () => {
  const sessionId = randomUUID();
  const sessionKey = "agent:main:direct:owner";
  const entry = { sessionId, updatedAt: 1, chatType: "direct" as const };
  fakeSessionOwner.rows.set(sessionKey, entry);
  onTestFinished(() => {
    fakeSessionOwner.rows.delete(sessionKey);
  });
  const resolution = await resolveMemoryAudienceFromEntry(
    {
      agentId: "main",
      sessionKey,
      sessionId,
      senderIsOwner: true,
      storePath: "/tmp/openclaw-tools/main.sqlite",
    },
    entry,
  );
  const memoryAudience = resolution.status === "granted" ? resolution.audience : undefined;
  if (resolution.status === "granted") {
    onTestFinished(resolution.release);
  }
  expect(memoryAudience).toBeDefined();
  const result = resolve({ memoryAudience, agentSessionKey: sessionKey });

  expect(result.memoryAudience).toBe(memoryAudience);
  result.assertMemoryAudienceCurrent!();
  expect(() => resolve({ memoryAudience, agentSessionKey: "agent:main:other" })).toThrow(
    "memory audience is bound to a different session",
  );

  fakeSessionOwner.rows.set(sessionKey, { ...entry, lifecycleRevision: randomUUID() });
  expect(() => result.assertMemoryAudienceCurrent!()).toThrow(
    "memory audience is no longer current",
  );
});

it.each([
  [" local ", " model ", "local", "model", "local/model"],
  ["openrouter", "openrouter/auto", "openrouter", "openrouter/auto", "openrouter/auto"],
])(
  "normalizes active model metadata for %s/%s",
  (modelProvider, inputId, provider, modelId, modelRef) => {
    expect(resolve({ modelProvider, modelId: inputId }).activeModel).toStrictEqual({
      provider,
      modelId,
      modelRef,
    });
  },
);

it("uses requester agent override for synthetic embedded session keys", () => {
  const recallWorkspace = path.join(process.cwd(), "tmp-recall-workspace");
  const config = {
    agents: {
      defaults: { workspace: path.join(process.cwd(), "tmp-default-workspace") },
      entries: { main: {}, recall: { workspace: recallWorkspace } },
    },
  } as never;
  const result = resolve({
    config,
    agentSessionKey: "explicit:user-session:active-memory:abc123",
    requesterAgentIdOverride: "recall",
  });

  expect(result).toMatchObject({ agentId: "recall", workspaceDir: recallWorkspace });
});

it("keeps the routable conversation target ahead of the native channel id", () => {
  const result = resolve({
    agentChannel: "slack",
    currentMessagingTarget: "user:U123",
    currentChannelId: "D123",
  });

  expect(result.deliveryContext?.to).toBe("user:U123");
});

it.each([
  { approvalReviewerDeviceIds: ["device-reviewer"] },
  { approvalReviewerDeviceId: "device-reviewer" },
])("carries host-selected approval reviewers into plugin tools: %j", (options) => {
  expect(resolve(options).approvalReviewerDeviceIds).toEqual(["device-reviewer"]);
});

it("forwards the run id and host-stamped input provenance to plugin tools", () => {
  const inputProvenance = {
    kind: "internal_system" as const,
    sourceTool: "exec",
    runId: "owner-run",
  };
  expect(resolve({ runId: "wake-run", inputProvenance })).toMatchObject({
    runId: "wake-run",
    inputProvenance,
  });
});

it("forwards host execution identity without deriving it from the session", () => {
  expect(resolve({ runId: "host-run", agentSessionKey: "agent:main:session" }).runId).toBe(
    "host-run",
  );
  expect(resolve({ agentSessionKey: "agent:main:session" }).runId).toBeUndefined();
});

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
