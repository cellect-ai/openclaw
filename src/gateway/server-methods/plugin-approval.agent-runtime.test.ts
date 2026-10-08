import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { DECISION_CARDS_ENV } from "../../infra/business-approval-conversation.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import {
  createPreparedTestApprovalManager,
  createTestApprovalFixture,
} from "../exec-approval-manager.test-support.js";
import { waitForApprovalRequested } from "./approval-request.test-support.js";
import { createPluginApprovalHandlers } from "./plugin-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function executionIdentity() {
  return {
    tokenVersion: 1 as const,
    createdAt: 1,
    runId: "run-1",
    contextId: "context-1",
    executionId: "execution-1",
  };
}

function identityWithoutExecution(): AgentRuntimeIdentity {
  const operationalRunInstance = { instanceId: "instance-run-1", runId: "run-1" };
  return {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey: "agent:main:session-1",
    operationalRunInstance,
    delegatedAuthority: {
      kind: "local",
      operationalRunInstance,
      lifecycleGeneration: "generation-1",
      claimId: "claim-1",
    },
  };
}

function requestOptions(params: {
  request: Record<string, unknown>;
  identity: AgentRuntimeIdentity;
  validateAuthority?: () => boolean;
}): GatewayRequestHandlerOptions {
  return {
    req: { method: "plugin.approval.request", params: params.request, id: "req-1" },
    params: params.request,
    client: {
      connId: "conn-agent-runtime",
      connect: { client: { id: "test-client", displayName: "Test Client" } },
      internal: { agentRuntimeIdentity: params.identity },
    },
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      broadcast: vi.fn(),
      getRuntimeConfig: () => ({ agents: { list: [{ id: "main" }] } }),
      logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      hasExecApprovalClients: () => true,
      validateAgentRuntimeApprovalAuthority: params.validateAuthority ?? (() => true),
    },
  } as unknown as GatewayRequestHandlerOptions;
}

function requestHandler(
  manager: ExecApprovalManager<PluginApprovalRequestPayload>,
): NonNullable<ReturnType<typeof createPluginApprovalHandlers>["plugin.approval.request"]> {
  const handler = createPluginApprovalHandlers(manager)["plugin.approval.request"];
  if (!handler) {
    throw new Error("plugin approval request handler is unavailable");
  }
  return handler;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("plugin approval signed agent runtime", () => {
  it.each(["business", "native", "mismatched", "worker"] as const)(
    "binds %s requests to the live host session and preserves the verdict",
    async (kind, testContext) => {
      vi.stubEnv(DECISION_CARDS_ENV, "true");
      const fixture = await createPreparedTestApprovalManager<PluginApprovalRequestPayload>(
        testContext,
        {
          approvalKind: "plugin",
          validateAgentRuntimeDelegatedAuthority: () => true,
        },
      );
      await fixture.run(async () => {
        const localContext = vi.spyOn(
          await import("../../infra/agent-run-registry.js"),
          "getAgentRunContext",
        );
        localContext.mockReturnValue({
          agentId: "main",
          sessionKey: kind === "mismatched" ? "agent:main:other" : "agent:main:session-1",
          sessionId: "host-session",
        });
        const opts = requestOptions({
          request: { title: "Review payment", description: "Pay vendor", twoPhase: true },
          identity: {
            ...identityWithoutExecution(),
            ...(kind === "worker"
              ? {
                  delegatedAuthority: {
                    ...identityWithoutExecution().delegatedAuthority,
                    kind: "worker" as const,
                    turnClaim: {
                      sessionId: "worker-session",
                      claimId: "worker-claim",
                      runId: "run-1",
                      placementGeneration: 1,
                      owner: {
                        kind: "worker" as const,
                        environmentId: "worker-env",
                        ownerEpoch: 1,
                      },
                    },
                  },
                }
              : {}),
            approvalOwnerPluginId: "fi",
            ...(kind === "business"
              ? {
                  approvalOrigin: "plugin" as const,
                  approvalConversation: { title: "Review payment", summary: "Pay vendor" },
                }
              : {}),
          },
        });
        const { pending } = await waitForApprovalRequested(
          opts.context,
          "plugin.approval.requested",
          () => fixture.track(Promise.resolve(requestHandler(fixture.manager)(opts))),
        );
        const record = (await fixture.manager.listPendingRecords())[0]!;
        const canonical = await fixture.manager.getSnapshot(record.id);
        expect(canonical?.request).toMatchObject({
          sessionId:
            kind === "worker" ? "worker-session" : kind === "mismatched" ? null : "host-session",
          runId: "run-1",
        });
        expect(canonical?.request.conversation).toEqual(
          kind === "business" ? { title: "Review payment", summary: "Pay vendor" } : undefined,
        );
        const stored = openOpenClawStateDatabase(fixture.databaseOptions)
          .db.prepare(
            "SELECT presentation_json, source_session_id FROM operator_approvals WHERE approval_id = ?",
          )
          .get(record.id) as { presentation_json: string; source_session_id: string };
        expect(stored.source_session_id).toBe(
          kind === "worker" ? "worker-session" : kind === "mismatched" ? null : "host-session",
        );
        expect(JSON.parse(stored.presentation_json).origin).toBe(
          kind === "business" ? "plugin" : undefined,
        );
        if (kind !== "worker") expect(getAgentRunContext).toHaveBeenCalledWith("run-1");
        await fixture.manager.resolve(record.id, "allow-once", "test");
        await pending;
        expect((await fixture.manager.getSnapshot(record.id))?.decision).toBe("allow-once");
      });
    },
  );

  it("rejects closed authority before creating a plugin approval", async (testContext) => {
    const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
      validateAgentRuntimeDelegatedAuthority: () => false,
    });
    const { manager } = fixture;
    await fixture.run(async () => {
      const opts = requestOptions({
        request: { title: "Sensitive action", description: "D" },
        identity: {
          ...identityWithoutExecution(),
          approvalOwnerPluginId: "codex",
        },
        validateAuthority: () => false,
      });

      await requestHandler(manager)(opts);

      expect(await manager.listPendingRecords()).toHaveLength(0);
      expect(vi.mocked(opts.respond).mock.calls[0]?.[2]).toMatchObject({
        message: expect.stringContaining("no longer active"),
      });
    });
  });

  it("cancels a plugin approval when authority closes after the handshake", async (testContext) => {
    let active = true;
    const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
      validateAgentRuntimeDelegatedAuthority: () => active,
    });
    const { manager } = fixture;
    await fixture.run(async () => {
      const opts = requestOptions({
        request: { title: "Sensitive action", description: "D", twoPhase: true },
        identity: {
          ...identityWithoutExecution(),
          approvalOwnerPluginId: "codex",
        },
        validateAuthority: () => active,
      });
      const { pending } = await waitForApprovalRequested(
        opts.context,
        "plugin.approval.requested",
        () => fixture.track(Promise.resolve(requestHandler(manager)(opts))),
      );
      expect(await manager.listPendingRecords()).toHaveLength(1);
      const record = (await manager.listPendingRecords())[0]!;
      active = false;

      await expect(manager.awaitDecision(record.id)).resolves.toBeNull();
      await pending;
      expect(await manager.getSnapshot(record.id)).toMatchObject({ status: "cancelled" });
    });
  });

  it("rejects a signed runtime without a host-resolved approval owner", async (testContext) => {
    const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
      validateAgentRuntimeDelegatedAuthority: () => true,
    });
    const { manager } = fixture;
    await fixture.run(async () => {
      const opts = requestOptions({
        request: { pluginId: "forged", title: "Sensitive action", description: "D" },
        identity: {
          kind: "agentRuntime",
          agentId: "main",
          sessionKey: "agent:main:session-1",
          operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
          delegatedAuthority: {
            kind: "local",
            operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
            lifecycleGeneration: "generation-1",
            claimId: "claim-1",
          },
        },
      });

      await requestHandler(manager)(opts);

      expect(vi.mocked(opts.respond).mock.calls[0]?.[2]).toMatchObject({
        message: expect.stringContaining("signed plugin approval owner is unavailable"),
      });
    });
  });

  it("uses signed runtime owner and route instead of forged request metadata", async (testContext) => {
    const fixture = await createPreparedTestApprovalManager<PluginApprovalRequestPayload>(
      testContext,
      {
        approvalKind: "plugin",
        validateAgentRuntimeDelegatedAuthority: () => true,
      },
    );
    const { manager, databaseOptions: options } = fixture;
    await fixture.run(async () => {
      const opts = requestOptions({
        request: {
          pluginId: "forged-plugin",
          title: "Sensitive action",
          description: "D",
          policySubject: {
            pluginKey: "calendar",
            tool: "create_event.raw",
          },
          agentId: "forged-agent",
          sessionKey: "forged-session",
          turnSourceChannel: "forged-channel",
          turnSourceTo: "forged-target",
          twoPhase: true,
        },
        identity: {
          kind: "agentRuntime",
          operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
          delegatedAuthority: {
            kind: "local",
            operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
            lifecycleGeneration: "generation-1",
            claimId: "claim-1",
          },
          executionIdentity: executionIdentity(),
          approvalOwnerPluginId: "codex",
          agentId: "main",
          sessionKey: "agent:main:session-1",
          turnSourceChannel: "telegram",
          turnSourceTo: "chat-1",
          turnSourceAccountId: "default",
          turnSourceThreadId: "thread-1",
        },
      });

      const { pending } = await waitForApprovalRequested(
        opts.context,
        "plugin.approval.requested",
        () => fixture.track(Promise.resolve(requestHandler(manager)(opts))),
      );
      expect(opts.context.broadcast).toHaveBeenCalled();
      const broadcastPayload = vi.mocked(opts.context.broadcast).mock.calls[0]?.[1] as
        | { id?: unknown }
        | undefined;
      const approvalId = String(broadcastPayload?.id);
      expect((await manager.getSnapshot(approvalId))?.request).toMatchObject({
        pluginId: "codex",
        policySubject: {
          pluginKey: "calendar",
          tool: "create_event.raw",
        },
        agentId: "main",
        sessionKey: "agent:main:session-1",
        turnSourceChannel: "telegram",
        turnSourceTo: "chat-1",
        turnSourceAccountId: "default",
        turnSourceThreadId: "thread-1",
      });
      expect(
        openOpenClawStateDatabase(options)
          .db.prepare(
            "SELECT approval_id, source_context_id, source_execution_id FROM operator_approval_execution_identities WHERE approval_id = ?",
          )
          .get(approvalId),
      ).toEqual({
        approval_id: approvalId,
        source_context_id: "context-1",
        source_execution_id: "execution-1",
      });
      await manager.resolve(approvalId, "deny");
      await pending;
    });
  });

  it("rejects a plugin reviewer policy subject from an unsigned client", async (testContext) => {
    const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
    });
    await fixture.run(async () => {
      const opts = requestOptions({
        request: {
          title: "Sensitive action",
          description: "D",
          policySubject: { pluginKey: "calendar" },
        },
        identity: identityWithoutExecution(),
      });
      (opts.client as { internal?: unknown }).internal = undefined;

      await requestHandler(fixture.manager)(opts);

      expect(await fixture.manager.listPendingRecords()).toHaveLength(0);
      expect(vi.mocked(opts.respond).mock.calls[0]?.[2]).toMatchObject({
        message: expect.stringContaining("requires agent runtime authority"),
      });
    });
  });

  it("does not create execution identity storage when collection is disabled", async (testContext) => {
    const fixture = await createPreparedTestApprovalManager<PluginApprovalRequestPayload>(
      testContext,
      {
        approvalKind: "plugin",
        validateAgentRuntimeDelegatedAuthority: () => true,
      },
    );
    const { manager, databaseOptions: options } = fixture;
    await fixture.run(async () => {
      const opts = requestOptions({
        request: { title: "Sensitive action", description: "D", twoPhase: true },
        identity: {
          kind: "agentRuntime",
          operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
          delegatedAuthority: {
            kind: "local",
            operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
            lifecycleGeneration: "generation-1",
            claimId: "claim-1",
          },
          approvalOwnerPluginId: "codex",
          agentId: "main",
          sessionKey: "agent:main:session-1",
        },
      });

      const { pending } = await waitForApprovalRequested(
        opts.context,
        "plugin.approval.requested",
        () => fixture.track(Promise.resolve(requestHandler(manager)(opts))),
      );
      expect(opts.context.broadcast).toHaveBeenCalled();
      const approvalId = String(
        (vi.mocked(opts.context.broadcast).mock.calls[0]?.[1] as { id?: unknown } | undefined)?.id,
      );
      expect(
        openOpenClawStateDatabase(options)
          .db.prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'operator_approval_execution_identities'",
          )
          .get(),
      ).toBeUndefined();
      await manager.resolve(approvalId, "deny");
      await pending;
    });
  });
});
