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
import {
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "../server-chat-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { startGatewayEventSubscriptions } from "../server-runtime-subscriptions.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
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

it.each(["accepted", "not-member", "issuer-revoked", "no-active"] as const)(
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
    const client = sharingPolicyClient({ deviceId, scopes: ["operator.admin", "operator.write"] });
    client.pairedClientId = "openclaw-control-ui";
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
    const registration =
      mode === "no-active"
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
        registration.markExecutionStarted();
        registration.controller.signal.addEventListener("abort", () => {
          signals.push(
            resolveAgentRunAbortLifecycleFields(registration.controller.signal).stopActor,
          );
        });
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
      const dispatch = handleGatewayRequest({
        req: {
          type: "req",
          id: "registered-stop",
          method: "sessions.abort",
          params: { key: binding.sessionKey, stopActor: assertion },
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
      if (mode === "accepted") {
        expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
          true,
          expect.objectContaining({ status: "aborted", abortedRunId: runId }),
        ]);
        expect(signals).toEqual([actor]);
        expect(terminals).toEqual([actor]);
        expect(facts.findLast((fact) => fact.runId === runId)).toMatchObject({
          state: "cancelled",
          stoppedBy: { kind: "person", userId: actor.userId },
        });
        expect(loadSessionEntry(target)).toMatchObject({ status: "killed", abortedLastRun: true });
      } else {
        expect(signals).toEqual([]);
        expect(terminals).toEqual([]);
        expect(facts.some((fact) => fact.stoppedBy !== undefined)).toBe(false);
        if (mode === "no-active") {
          expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
            true,
            expect.objectContaining({ status: "no-active-run", abortedRunId: null }),
          ]);
        } else {
          expect(registration?.controller.signal.aborted).toBe(false);
          expect(loadSessionEntry(target)).toMatchObject({
            status: "running",
            lifecycleRunId: runId,
            abortedLastRun: false,
          });
        }
      }
    } finally {
      stopEvents();
      transport.stop();
      registration?.cleanup();
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
