// Preserve the real cancellation registry's fixture setup before its consumers.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expect, it, vi } from "vitest";
import { resolveAgentRunAbortLifecycleFields } from "../../agents/run-termination.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  getAgentEventLifecycleGeneration,
  onAgentEvent,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { claimAgentRunContext, clearAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  registerConversationLifecycleTransport,
  type ConversationLifecyclePublication,
  type ConversationProjectionBinding,
} from "../../infra/conversation-lifecycle.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { registerChatAbortController } from "../chat-abort.js";
import { registerQueuedChatTurn } from "../chat-queued-turns.js";
import {
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "../server-chat-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { startGatewayEventSubscriptions } from "../server-runtime-subscriptions.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { createWorkerInferenceCancellationService } from "../worker-environments/inference-control.test-helpers.js";
import { sessionAbortHandlers } from "./sessions-abort.js";

const native = vi.hoisted(() => ({ route: vi.fn(), member: vi.fn() }));
vi.mock("../talk-matrix-binding.js", () => ({ resolveMatrixTalkBinding: native.route }));
vi.mock("../../channels/plugins/index.js", async (original) => ({
  ...(await original<typeof import("../../channels/plugins/index.js")>()),
  getLoadedChannelPlugin: (channel: string) =>
    channel === "matrix" ? { groups: { isJoinedMember: native.member } } : undefined,
}));

const fixture = useChatAbortRegistryFixture();
const deviceId = "a".repeat(64);
const runId = "registered-actor-run";
const sessionId = "registered-actor-session";
const binding: ConversationProjectionBinding = {
  environment: "test",
  conversationId: "conversation-0001",
  roomId: "!room:matrix.test",
  bindingId: "binding-0001",
  accountId: "bot-account",
  threadRootEventId: "$root",
  sessionKey: "agent:main:matrix:channel:!room:matrix.test:thread:$root",
  agentId: "main",
};
const assertion = {
  userId: "@reader:matrix.test",
  roomId: binding.roomId,
  threadRootEventId: binding.threadRootEventId,
  agentMxid: "@bot:matrix.test",
};
const actor = {
  userId: assertion.userId,
  roomId: binding.roomId,
  threadRootEventId: binding.threadRootEventId,
  sessionKey: binding.sessionKey,
  agentId: binding.agentId,
};
const log: SubsystemLogger = {
  subsystem: "registered-stop-actor-test",
  isEnabled: () => false,
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  raw: vi.fn(),
  child: () => log,
};

it.each([
  "accepted",
  "not-member",
  "issuer-revoked",
  "no-active",
  "foreign-queued-default",
  "foreign-queued-false",
  "same-device-queued",
  "aliased-queued-controller",
  "pending-only",
  "explicit-pending",
  "preregistered-only",
  "clear-queued-rejected",
  "preexecution",
  "provider-only",
  "explicit-provider-only",
  "host-worker",
  "other-provider",
] as const)(
  "registered sessions.abort keeps its %s attribution with the actual cancellation owner",
  async (mode) => {
    resetAgentEventsForTest();
    rotateAgentEventLifecycleGeneration();
    const previousIssuers = process.env.OPENCLAW_CONVERSATION_CONTROL_ISSUER_DEVICE_IDS;
    process.env.OPENCLAW_CONVERSATION_CONTROL_ISSUER_DEVICE_IDS = deviceId;
    native.route.mockReset();
    native.member.mockReset();
    native.route.mockResolvedValue({
      sessionKey: binding.sessionKey,
      agentId: binding.agentId,
      accountId: binding.accountId,
    });
    native.member.mockImplementation(async () => {
      if (mode === "issuer-revoked") {
        process.env.OPENCLAW_CONVERSATION_CONTROL_ISSUER_DEVICE_IDS = "";
      }
      return mode !== "not-member";
    });
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg, cfg);
    const target = { agentId: binding.agentId, sessionKey: binding.sessionKey };
    await replaceSessionEntry(target, { sessionId, updatedAt: 1_000 });
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const providerCancel = vi.fn(() => [runId]);
    if (
      ["provider-only", "explicit-provider-only", "host-worker", "other-provider"].includes(mode)
    ) {
      Object.assign(context, {
        workerEnvironmentService: createWorkerInferenceCancellationService(
          sessionId,
          [mode === "other-provider" ? "unrepresented-provider" : runId],
          providerCancel,
          {
            agentId: binding.agentId,
            sessionId,
            sessionKey: binding.sessionKey,
            storePath: fixture.stateDir,
          },
        ),
      });
    }
    const client = sharingPolicyClient({ deviceId, scopes: ["operator.admin", "operator.write"] });
    client.pairedClientId = "openclaw-control-ui";
    const hasForeignQueuedSource = [
      "foreign-queued-default",
      "foreign-queued-false",
      "same-device-queued",
      "aliased-queued-controller",
      "pending-only",
      "explicit-pending",
      "clear-queued-rejected",
    ].includes(mode);
    const foreignController = new AbortController();
    const foreignRunId = "another-requesters-queued-source";
    if (hasForeignQueuedSource) {
      // The maintained legacy queue proves a distinct gateway admission owner,
      // not a Matrix person. Do not invent participant identity on its entry.
      expect(
        registerQueuedChatTurn({
          chatQueuedTurns: context.chatQueuedTurns,
          runId: foreignRunId,
          controller: foreignController,
          sessionId,
          sessionKey: binding.sessionKey,
          agentId: binding.agentId,
          ownerConnId:
            mode === "same-device-queued" ? client.connId : "another-requesters-connection",
          ownerDeviceId: mode === "same-device-queued" ? deviceId : "b".repeat(64),
        }),
      ).toBe(true);
    }
    const preRegistered = {
      ts: 1_000,
      ok: true,
      payload: {
        status: "accepted",
        runId: foreignRunId,
        sessionKey: binding.sessionKey,
        sessionId,
        agentId: binding.agentId,
        ownerConnId: client.connId,
      },
    };
    if (mode === "preregistered-only") {
      context.dedupe.set(`agent:${foreignRunId}`, preRegistered);
    }
    if (mode === "aliased-queued-controller") {
      context.chatAbortControllers.set(foreignRunId, {
        controller: foreignController,
        sessionKey: binding.sessionKey,
        sessionId,
        agentId: binding.agentId,
        startedAtMs: 1_000,
        expiresAtMs: Date.now() + 60_000,
      });
    }
    const foreignQueuedEntry = context.chatQueuedTurns.get(foreignRunId);
    const lifetime = new AbortController();
    const subscriptions = startGatewayEventSubscriptions({
      scheduler: createTestGatewayScheduler(),
      signal: lifetime.signal,
      log,
      broadcast: context.broadcast,
      broadcastToConnIds: context.broadcastToConnIds,
      nodeHasSessionSubscribers: () => false,
      nodeSendToSession: context.nodeSendToSession,
      agentRunSeq: context.agentRunSeq,
      chatRunState: context.chatRunState,
      toolEventRecipients: context.chatRunState.toolEventRecipients,
      sessionEventSubscribers: createSessionEventSubscriberRegistry(),
      sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
      chatAbortControllers: context.chatAbortControllers,
      restartRecoveryCandidates: new Map(),
      refreshConnectedUserProfiles: vi.fn(),
    });
    const facts: ConversationLifecyclePublication[] = [];
    const transport = registerConversationLifecycleTransport({
      transportId: "registered-test",
      stateDir: fixture.stateDir,
      resolveBindings: () => [binding],
      publish: async (_, fact) => {
        facts.push(fact);
      },
      signals: () => true,
      onError: vi.fn(),
    });
    const registration = [
      "no-active",
      "pending-only",
      "preregistered-only",
      "provider-only",
      "explicit-provider-only",
    ].includes(mode)
      ? undefined
      : registerChatAbortController({
          chatAbortControllers: context.chatAbortControllers,
          runId,
          sessionId,
          sessionKey: binding.sessionKey,
          agentId: binding.agentId,
          kind: "agent",
          timeoutMs: 60_000,
        });
    const signals: unknown[] = [];
    const terminals: unknown[] = [];
    const stopEvents = onAgentEvent((event) => {
      if (event.runId === runId && event.stream === "lifecycle" && event.data.phase === "end") {
        terminals.push(event.data.stopActor);
      }
    });
    const respond = vi.fn();
    try {
      if (registration?.registered) {
        claimAgentRunContext(
          runId,
          { sessionId, sessionKey: binding.sessionKey, agentId: binding.agentId },
          { trackOwner: true },
        );
        if (mode !== "preexecution") {
          registration.markExecutionStarted();
        }
        registration.controller.signal.addEventListener("abort", () => {
          signals.push(
            resolveAgentRunAbortLifecycleFields(registration.controller.signal).stopActor,
          );
        });
        if (mode !== "preexecution") {
          await persistGatewaySessionLifecycleEvent({
            ...target,
            event: {
              runId,
              sessionId,
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
              ts: 1_000,
              data: { phase: "start", startedAt: 1_000 },
            },
          });
        }
      }
      const dispatch = handleGatewayRequest({
        req: {
          type: "req",
          id: "registered-stop",
          method: "sessions.abort",
          params: {
            key: binding.sessionKey,
            stopActor: assertion,
            ...(mode === "foreign-queued-false" ? { clearQueued: false } : {}),
            ...(mode === "clear-queued-rejected" ? { clearQueued: true } : {}),
            ...(mode === "explicit-pending" ? { runId: foreignRunId } : {}),
            ...(mode === "explicit-provider-only" ? { runId } : {}),
          },
        },
        client,
        context,
        respond,
        isWebchatConnect: () => false,
        extraHandlers: { "sessions.abort": sessionAbortHandlers["sessions.abort"]! },
      });
      const rejected = mode === "not-member" || mode === "issuer-revoked";
      if (rejected) {
        // The registered router propagates admission failures; its socket caller
        // owns encoding those thrown failures into an RPC error response.
        await expect(dispatch).rejects.toThrow(
          mode === "not-member"
            ? "Conversation control attribution membership is unavailable"
            : "Conversation control attribution issuer is unavailable",
        );
      } else {
        await dispatch;
      }
      expect(native.route).toHaveBeenCalledExactlyOnceWith({
        cfg,
        roomId: assertion.roomId,
        threadRootEventId: assertion.threadRootEventId,
        agentMxid: assertion.agentMxid,
      });
      expect(native.member).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          cfg,
          accountId: binding.accountId,
          expectedAccountUserId: assertion.agentMxid,
          groupId: assertion.roomId,
          userId: assertion.userId,
          assertCurrent: expect.any(Function),
        }),
      );
      await transport.flush();
      if (rejected) {
        expect(respond).not.toHaveBeenCalled();
      } else {
        expect(respond).toHaveBeenCalledOnce();
      }
      if (
        mode === "accepted" ||
        mode === "preexecution" ||
        mode === "host-worker" ||
        mode === "other-provider" ||
        (hasForeignQueuedSource &&
          !["pending-only", "explicit-pending", "clear-queued-rejected"].includes(mode))
      ) {
        expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
          true,
          expect.objectContaining({
            status: "aborted",
            abortedRunId: runId,
          }),
        ]);
        expect(signals).toEqual([actor]);
        expect(terminals).toEqual([actor]);
        expect(facts.findLast((fact) => fact.runId === runId)).toMatchObject({
          state: "cancelled",
          stoppedBy: { kind: "person", userId: actor.userId },
        });
        if (mode === "preexecution") {
          expect(loadSessionEntry(target)).toMatchObject({ sessionId, updatedAt: 1_000 });
          expect(loadSessionEntry(target)?.lifecycleRunId).toBeUndefined();
        } else {
          expect(loadSessionEntry(target)).toMatchObject({
            status: "killed",
            abortedLastRun: true,
          });
        }
        if (hasForeignQueuedSource) {
          // Session-wide active Stop must not withdraw a different admission's
          // pending input merely because the application uses an admin issuer.
          expect(registration?.controller.signal.aborted).toBe(true);
          expect(foreignController.signal.aborted).toBe(false);
          expect(context.chatQueuedTurns.get(foreignRunId)).toBe(foreignQueuedEntry);
        }
      } else {
        expect(signals).toEqual([]);
        expect(terminals).toEqual([]);
        expect(facts.some((fact) => fact.stoppedBy !== undefined)).toBe(false);
        if (
          [
            "no-active",
            "pending-only",
            "explicit-pending",
            "preregistered-only",
            "provider-only",
            "explicit-provider-only",
          ].includes(mode)
        ) {
          expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
            true,
            expect.objectContaining({ status: "no-active-run", abortedRunId: null }),
          ]);
        } else {
          if (mode === "clear-queued-rejected") {
            expect(respond.mock.calls[0]?.[0]).toBe(false);
          }
          expect(registration?.controller.signal.aborted).toBe(false);
          expect(loadSessionEntry(target)).toMatchObject({
            status: "running",
            lifecycleRunId: runId,
            abortedLastRun: false,
          });
        }
      }
      if (mode === "host-worker") {
        expect(providerCancel).toHaveBeenCalledOnce();
      } else {
        expect(providerCancel).not.toHaveBeenCalled();
      }
      if (hasForeignQueuedSource) {
        expect(foreignController.signal.aborted).toBe(false);
        expect(context.chatQueuedTurns.get(foreignRunId)).toBe(foreignQueuedEntry);
      }
      if (mode === "preregistered-only") {
        expect(context.dedupe.get(`agent:${foreignRunId}`)).toBe(preRegistered);
      }
    } finally {
      stopEvents();
      transport.stop();
      registration?.cleanup();
      context.chatQueuedTurns.delete(foreignRunId);
      lifetime.abort();
      await subscriptions.agentUnsub();
      subscriptions.heartbeatUnsub();
      subscriptions.transcriptUnsub();
      subscriptions.lifecycleUnsub();
      clearAgentRunContext(runId);
      resetAgentEventsForTest();
      if (previousIssuers === undefined) {
        delete process.env.OPENCLAW_CONVERSATION_CONTROL_ISSUER_DEVICE_IDS;
      } else {
        process.env.OPENCLAW_CONVERSATION_CONTROL_ISSUER_DEVICE_IDS = previousIssuers;
      }
    }
  },
);
