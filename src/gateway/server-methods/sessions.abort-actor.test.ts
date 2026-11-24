// Preserve the real cancellation registry's fixture setup before its consumers.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { resolveAgentRunAbortLifecycleFields } from "../../agents/run-termination.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
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
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { isRpcSourceRegistered } from "../../sessions/session-controller.rpc-sources.js";
import { markReplyOperationExecutionStarted } from "../../sessions/session-controller.state.js";
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
import { registerWorkerInferenceSessionControl } from "../worker-environments/inference-control-internal.js";
import { createWorkerInferenceCancellationService } from "../worker-environments/inference-control.test-helpers.js";
import { sessionAbortHandlers } from "./sessions-abort.js";

const native = vi.hoisted(() => ({
  member: vi.fn(),
  route: vi.fn(),
  owner: vi.fn(),
  routeGeneration: 0,
  plugin: undefined as unknown,
}));
vi.mock("../../channels/plugins/index.js", async (original) => {
  const actual = await original<typeof import("../../channels/plugins/index.js")>();
  return {
    ...actual,
    getLoadedChannelPlugin: (channel: string) =>
      channel === "matrix" ? native.plugin : actual.getLoadedChannelPlugin(channel),
    getChannelPlugin: (channel: string) =>
      channel === "matrix" ? native.plugin : actual.getChannelPlugin(channel),
  };
});

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
  "plugin-replaced-in-membership",
  "route-replaced-in-membership",
  "plugin-replaced-before-abort",
  "route-replaced-before-abort",
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
    native.owner.mockReset();
    native.routeGeneration = 0;
    native.owner.mockReturnValue({ kind: "agent", agentId: binding.agentId });
    native.route.mockResolvedValue({
      sessionKey: binding.sessionKey,
      baseSessionKey: binding.sessionKey,
      peer: { kind: "channel", id: binding.roomId },
      chatType: "channel",
      from: binding.roomId,
      to: `room:${binding.roomId}`,
      threadId: binding.threadRootEventId,
    });
    // The binding resolver, account selection, snapshot lifetime, and outbound
    // route preparation are real; only the native plugin boundary is synthetic.
    native.plugin = {
      id: "matrix",
      capabilities: { chatTypes: ["channel"] },
      config: {
        listAccountIds: () => [binding.accountId],
        resolveAccount: () => ({ userId: assertion.agentMxid }),
      },
      messaging: {
        prepareConversationRouteOwnersAsync: async (
          inputs: unknown[],
          inspect: (refs: []) => Promise<() => unknown>,
        ) => {
          const generation = native.routeGeneration;
          const read = await inspect([]);
          return inputs.map(() => () => {
            read();
            if (generation !== native.routeGeneration)
              throw new Error("Matrix Talk binding owner changed");
            return native.owner();
          });
        },
        resolveOutboundSessionRoute: native.route,
      },
      groups: { isJoinedMember: native.member },
    };
    native.member.mockImplementation(async () => {
      if (mode === "issuer-revoked") {
        process.env.OPENCLAW_CONVERSATION_CONTROL_ISSUER_DEVICE_IDS = "";
      }
      if (mode === "plugin-replaced-in-membership") native.plugin = {};
      if (mode === "route-replaced-in-membership") native.routeGeneration += 1;
      return mode !== "not-member";
    });
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg, cfg);
    const storePath = resolveSessionStorePathCore(undefined, { agentId: binding.agentId });
    const target = { agentId: binding.agentId, sessionKey: binding.sessionKey, storePath };
    const physicalTarget = captureSessionTarget({
      ...target,
      storeScope: storePath,
      incarnation: sessionId,
    });
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
            storePath,
          },
        ),
      });
    }
    const lateRevocation =
      mode === "plugin-replaced-before-abort" || mode === "route-replaced-before-abort";
    const capturedForStop = vi.fn();
    if (lateRevocation) {
      const service = {};
      registerWorkerInferenceSessionControl(service, {
        hasSession: (candidate) => candidate === sessionId,
        resolveSessionTargetForRunId: () => ({ ...target, sessionId }),
        reserveSessionDrain: () => {
          throw new Error("Unexpected drain in Stop fixture");
        },
        captureSessionCancellation: () => {
          // Capture occurs after actor preparation, before the native stop plan
          // commits its effects. It may not retain a replaced plugin/route.
          expect(native.member).toHaveBeenCalledOnce();
          capturedForStop();
          if (mode === "plugin-replaced-before-abort") native.plugin = {};
          else native.routeGeneration += 1;
          return {
            runIds: [runId],
            executing: true,
            settled: Promise.resolve(),
            cancel: async () => providerCancel(),
          };
        },
      });
      Object.assign(context, { workerEnvironmentService: service });
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
    const foreignRunId = "another-requesters-queued-source";
    const register = (id: string, ownerConnId?: string, ownerDeviceId?: string) =>
      withPluginRuntimeGatewayContextResolver(context.resolveGatewayContext, () =>
        registerChatAbortController({
          target: physicalTarget,
          runId: id,
          sessionId,
          sessionKey: binding.sessionKey,
          agentId: binding.agentId,
          ownerConnId,
          ownerDeviceId,
          kind: "agent",
          timeoutMs: 60_000,
        }),
      );
    let foreign: ReturnType<typeof register> | undefined;
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
      resolveGatewayContext: context.resolveGatewayContext,
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
    await transport.ready;
    const registration = [
      "no-active",
      "pending-only",
      "preregistered-only",
      "provider-only",
      "explicit-provider-only",
    ].includes(mode)
      ? undefined
      : register(runId, client.connId, deviceId);
    const releaseActive = createDeferred();
    const activeEntered = createDeferred();
    let activeWork: Promise<unknown> | undefined;
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
        registration.initializeTiming();
        activeWork = withSessionTurn(
          { ...target, sessionId, controllerInput: registration.entry.input },
          async (operation, signal) => {
            if (!operation) throw new Error("Missing native operation");
            if (mode !== "preexecution") {
              markReplyOperationExecutionStarted(operation);
              operation.setPhase("running");
              expect(registration.markExecutionStarted()).toBe(true);
            }
            activeEntered.resolve();
            const onAbort = () => releaseActive.resolve();
            signal.addEventListener("abort", onAbort, { once: true });
            try {
              if (!signal.aborted) await releaseActive.promise;
            } finally {
              signal.removeEventListener("abort", onAbort);
            }
          },
        );
        await awaitGateBeforeSettlement(
          activeEntered.promise,
          activeWork,
          "Actor source ended before native claim",
        );
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
      foreign = hasForeignQueuedSource
        ? register(
            foreignRunId,
            mode === "same-device-queued" ? client.connId : "another-requesters-connection",
            mode === "same-device-queued" ? deviceId : "b".repeat(64),
          )
        : undefined;
      if (foreign && !foreign.registered) throw new Error("Expected native pending source");
      if (mode === "aliased-queued-controller") {
        // The old two-map alias is represented by one exact native input. A
        // duplicate transport registration must not promote that queued source.
        const alias = register(foreignRunId);
        expect(alias.registered).toBe(false);
        expect(alias.existingEntry).toBe(foreign?.entry);
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
      const membershipRevocation =
        mode === "plugin-replaced-in-membership" || mode === "route-replaced-in-membership";
      const rejected = mode === "not-member" || mode === "issuer-revoked" || membershipRevocation;
      const dispatchOutcome = dispatch.then(
        () => undefined,
        (error: unknown) => error,
      );
      if (rejected) {
        // The registered router propagates admission failures; its socket caller
        // owns encoding those thrown failures into an RPC error response.
        expect(await dispatchOutcome).toEqual(
          expect.objectContaining({
            message:
              mode === "not-member"
                ? "Conversation control attribution membership is unavailable"
                : mode === "issuer-revoked"
                  ? "Conversation control attribution issuer is unavailable"
                  : "Matrix Talk binding owner changed",
          }),
        );
      } else if (lateRevocation) {
        const failure = await dispatchOutcome;
        // Later native cancellation owners may encode a failure or propagate
        // it to the socket. Neither path can acknowledge a successful Stop.
        if (failure === undefined) expect(respond.mock.calls[0]?.[0]).toBe(false);
        else
          expect(failure).toEqual(
            expect.objectContaining({ message: expect.stringContaining("owner changed") }),
          );
        expect(capturedForStop).toHaveBeenCalled();
      } else {
        expect(await dispatchOutcome).toBeUndefined();
      }
      expect(native.route).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          cfg,
          channel: "matrix",
          agentId: binding.agentId,
          accountId: binding.accountId,
          target: `room:${assertion.roomId}`,
          threadId: assertion.threadRootEventId,
        }),
      );
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
      } else if (!lateRevocation) {
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
          expect(foreign?.controller.signal.aborted).toBe(false);
          expect(foreign?.registered && isRpcSourceRegistered(foreign.entry)).toBe(true);
          expect(foreign?.entry?.input.claim).toBeUndefined();
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
        expect(foreign?.controller.signal.aborted).toBe(false);
        expect(foreign?.registered && isRpcSourceRegistered(foreign.entry)).toBe(true);
        expect(foreign?.entry?.input.claim).toBeUndefined();
      }
      if (mode === "preregistered-only") {
        expect(context.dedupe.get(`agent:${foreignRunId}`)).toBe(preRegistered);
      }
    } finally {
      stopEvents();
      releaseActive.resolve();
      if (activeWork) await activeWork;
      registration?.cleanup();
      foreign?.cleanup();
      await transport.stop();
      lifetime.abort();
      await subscriptions.agentUnsub();
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
