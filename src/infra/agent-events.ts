import { isDefinitiveRunLifecycle } from "@openclaw/normalization-core/agent-run-terminal-outcome";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import {
  getAgentEventExecutionContext,
  recordAgentEventRouting,
} from "./agent-event-execution-context.js";
import { hasInvalidLifecycleStartTimestamp } from "./agent-event-lifecycle.js";
import type {
  AgentAssistantProjection,
  AgentAssistantSourceReceipt,
  AgentEventPayload,
  AgentEventRuntimePayload,
  AgentEventListener,
  AgentEventRegistration,
  AgentEventState,
  CaptureAgentEventDelivery,
  AgentTerminalEventData,
  AgentTerminalEventReservation,
} from "./agent-events.types.js";
import { recordExecutionActivity } from "./agent-execution-activity.js";
import { createAgentRunStaleLifecycleError } from "./agent-lifecycle-error.js";
import {
  captureAgentRunPersistence,
  hasAgentRunPersistence,
  type AgentRunPersistenceWork,
  type AgentRunPersistenceReceipt,
} from "./agent-run-persistence.js";
import {
  getAgentRunContext,
  getAgentRunContextOwnership,
  getAgentRunLifecycleGeneration,
  recordAgentRunModel,
  registerAgentRunSequenceResetHandler,
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
} from "./agent-run-registry.js";
import type { AgentRunContext } from "./agent-run-registry.types.js";
import { captureAgentRunTerminalPersistence } from "./agent-run-terminal-writes.js";
export { drainRequiredAgentRunPersistence } from "./agent-run-persistence.js";
import { recordAgentRunOutputTokens } from "./agent-run-usage.js";

export type {
  AgentApprovalEventData,
  AgentAssistantProjection,
  AgentAssistantSourceReceipt,
  AgentEventPayload,
  AgentEventRuntimePayload,
  AgentEventStream,
} from "./agent-events.types.js";

const AGENT_EVENT_ROUTING_FIELDS = [
  ["controlUiVisible", "isControlUiVisible"],
  ["projectSessionLifecycle", "projectSessionLifecycle"],
  ["projectSessionMessages", "projectSessionMessages"],
  ["mainSessionRestartRecovery", "mainSessionRestartRecovery"],
  ["verboseLevel", "verboseLevel"],
  ["registeredAt", "registeredAt"],
] as const;

function getAgentEventState(): AgentEventState {
  // Lifecycle owners can register before an importing runtime chunk finishes initialization.
  return resolveGlobalSingleton<AgentEventState>(Symbol.for("openclaw.agentEvents.state"), () => ({
    runs: new Map(),
    listeners: { registrations: [] },
    runListeners: new Map(),
    nextListenerId: 0,
    auditListeners: new Set<(evt: AgentEventPayload) => void>(),
  }));
}

/** Correlate copied model frames with their occurrence without changing transcript bytes. */
export function bindAgentAssistantSource(
  message: object,
  source: AgentAssistantSourceReceipt,
): void {
  (getAgentEventState().assistantSources ??= new WeakMap()).set(message, source);
}

export function readAgentAssistantSource(
  message: unknown,
): AgentAssistantSourceReceipt | undefined {
  return message && typeof message === "object"
    ? getAgentEventState().assistantSources?.get(message)
    : undefined;
}

registerAgentRunSequenceResetHandler((runId) => {
  getAgentEventState().runs.delete(runId);
});

/** Runs one execution with immutable ownership inherited by every emitted stream event. */
export function withAgentRunLifecycleGeneration<T>(lifecycleGeneration: string, run: () => T): T {
  const storage = getAgentEventExecutionContext();
  const parent = storage.getStore();
  const onceByRun =
    parent?.lifecycleGeneration === lifecycleGeneration ? parent.onceByRun : new Map();
  // Same-registration records share compaction updates, while a nested reused
  // run id replaces only its own binding. Neither scope retains live authority.
  const routingByRun = new Map(parent?.routingByRun);
  return storage.run({ lifecycleGeneration, onceByRun, routingByRun }, run);
}

/** Reserves client terminal publication without advancing execution settlement. */
export function reserveAgentTerminalEvent(
  identity: Omit<AgentEventPayload, "seq" | "ts" | "stream" | "data">,
): AgentTerminalEventReservation {
  const { runId } = identity;
  const context = getAgentRunContext(runId);
  const terminalPersistence = captureAgentRunTerminalPersistence(runId);
  return withAgentRunLifecycleGeneration(captureAgentRunLifecycleGeneration(runId), () => {
    if (context) {
      recordAgentEventRouting(runId, context);
    }
    const resolved = resolveAgentEventRouting(identity);
    if (!resolved) {
      return { publish: () => {}, release: () => {} };
    }
    const state = getAgentEventState();
    const runState = resolved.routing?.eventState ?? state.runs.get(runId) ?? { seq: 0 };
    const publication = Symbol("agent terminal publication");
    runState.terminalPublication ??= publication;
    if (!state.runs.has(runId)) {
      state.runs.set(runId, runState);
    }
    const storage = getAgentEventExecutionContext();
    const scope = storage.getStore()!;
    let pending = true;
    return {
      publish: (data: AgentTerminalEventData) => {
        if (pending) {
          pending = false;
          storage.run(scope, () =>
            dispatchAgentEvent(
              { ...identity, stream: "lifecycle", data },
              undefined,
              undefined,
              publication,
              undefined,
              undefined,
              terminalPersistence,
            ),
          );
        }
      },
      release: () => {
        if (!pending) {
          return;
        }
        pending = false;
        if (runState.terminalPublication === publication) {
          delete runState.terminalPublication;
        }
      },
    };
  });
}

/** Shares one operation across fallback attempts that belong to the same admitted run. */
export function runOncePerAgentRun<T>(runId: string, operation: string, run: () => Promise<T>) {
  const context = getAgentEventExecutionContext().getStore();
  if (!context) {
    return run();
  }
  const key = `${operation}:${runId}`;
  const existing = context.onceByRun.get(key);
  if (existing) {
    return existing as Promise<T>;
  }
  const pending = Promise.resolve().then(run);
  context.onceByRun.set(key, pending);
  return pending;
}

export function getAgentEventLifecycleGeneration(): string {
  return getAgentRunLifecycleGeneration();
}

export function isAgentEventLifecycleGenerationCurrent(lifecycleGeneration: string): boolean {
  return lifecycleGeneration === getAgentRunLifecycleGeneration();
}

/** Registers process-local state cleanup at the gateway lifecycle boundary. */
export function registerAgentEventLifecycleRotationHandler(
  key: string,
  handler: (lifecycleGeneration: string) => void,
): () => void {
  const state = getAgentEventState();
  const handlers =
    state.lifecycleRotationHandlers ??
    (state.lifecycleRotationHandlers = new Map<string, (lifecycleGeneration: string) => void>());
  handlers.set(key, handler);
  return () => {
    if (handlers.get(key) === handler) {
      handlers.delete(key);
    }
  };
}

/** Rejects work that no longer belongs to the active gateway lifecycle. */
export function assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration: string): void {
  if (isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)) {
    return;
  }
  throw createAgentRunStaleLifecycleError();
}

/** Captures immutable lifecycle ownership for one admitted execution. */
export function captureAgentRunLifecycleGeneration(runId: string): string {
  return (
    getAgentEventExecutionContext().getStore()?.lifecycleGeneration ??
    getAgentRunContext(runId)?.lifecycleGeneration ??
    getAgentRunLifecycleGeneration()
  );
}

/** Starts a new ownership generation before an in-process gateway restart. */
export function rotateAgentEventLifecycleGeneration(): string {
  const state = getAgentEventState();
  const lifecycleGeneration = rotateAgentRunRegistryLifecycleGeneration();
  // Rotation is the liveness choke point: after it returns, no prior-generation
  // owner is operationally reachable. Recovery and runtime consumers therefore
  // agree that only current-generation owners can drive or receive work.
  const errors: unknown[] = [];
  notifyListeners(state.lifecycleRotationHandlers?.values() ?? [], lifecycleGeneration, (error) =>
    errors.push(error),
  );
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to retire stale agent lifecycle owners");
  }
  return lifecycleGeneration;
}

function resolveAgentEventRouting(
  event: Pick<AgentEventPayload, "runId" | "lifecycleGeneration">,
  claimId?: string,
  expectedContext?: AgentRunContext,
) {
  const currentLifecycleGeneration = getAgentRunLifecycleGeneration();
  const owners = getAgentRunContextOwnership(event.runId);
  if (claimId !== undefined) {
    if (
      owners?.lifecycleGeneration !== currentLifecycleGeneration ||
      owners.exclusiveClaimId !== claimId ||
      !owners.claimIds.has(claimId) ||
      owners.clearRequested
    ) {
      return undefined;
    }
  } else if (
    owners?.lifecycleGeneration === currentLifecycleGeneration &&
    owners.exclusiveClaimId
  ) {
    return undefined;
  }
  const context = getAgentRunContext(event.runId);
  if (expectedContext && context !== expectedContext) {
    return undefined;
  }
  const scope = getAgentEventExecutionContext().getStore();
  const executionLifecycleGeneration = event.lifecycleGeneration ?? scope?.lifecycleGeneration;
  const ownedLifecycleGeneration = executionLifecycleGeneration ?? context?.lifecycleGeneration;
  if (
    executionLifecycleGeneration &&
    context?.lifecycleGeneration &&
    executionLifecycleGeneration !== context.lifecycleGeneration
  ) {
    return undefined;
  }
  if (ownedLifecycleGeneration && ownedLifecycleGeneration !== currentLifecycleGeneration) {
    return undefined;
  }
  const record = scope?.routingByRun?.get(event.runId);
  const captured =
    record?.routing.lifecycleGeneration === ownedLifecycleGeneration ? record : undefined;
  const capturedOwner = captured?.owner.deref();
  if (captured && context && capturedOwner !== context) {
    return undefined;
  }
  const routing = context ?? captured?.routing;
  return { context, routing, capturedOwner, ownedLifecycleGeneration, currentLifecycleGeneration };
}

function enrichAgentEvent(
  state: AgentEventState,
  event: Omit<AgentEventPayload, "seq" | "ts">,
  claimId?: string,
  expectedContext?: AgentRunContext,
  reservedPublication?: symbol,
  assistantSource?: AgentAssistantSourceReceipt,
  assistantProjection?: AgentAssistantProjection,
  terminalPersistence?: AgentEventRuntimePayload["terminalPersistence"],
): AgentEventRuntimePayload | undefined {
  const resolved = resolveAgentEventRouting(event, claimId, expectedContext);
  if (!resolved || hasInvalidLifecycleStartTimestamp(event.stream, event.data)) {
    return undefined;
  }
  const { context, routing, capturedOwner, ownedLifecycleGeneration, currentLifecycleGeneration } =
    resolved;
  if (event.stream === "lifecycle" && event.data.phase === "model") {
    if (!context || (claimId === undefined && (expectedContext ?? capturedOwner) !== context)) {
      return undefined;
    }
    const { provider, model } = event.data;
    if (provider === null && model === null) {
      recordAgentRunModel(event.runId, undefined);
    } else if (
      typeof provider === "string" &&
      provider.trim() &&
      typeof model === "string" &&
      model.trim()
    ) {
      recordAgentRunModel(event.runId, { provider, model });
    } else {
      return undefined;
    }
  }
  const runState = routing?.eventState ?? state.runs.get(event.runId) ?? { seq: 0 };
  let data = event.data;
  if (routing && event.stream === "lifecycle") {
    if (routing.completionSource) {
      data = { ...data, completionSource: routing.completionSource };
    }
    if (data.phase === "start") {
      if (context) {
        context.lifecycleStartedAt = data.startedAt as number;
      }
    } else if (
      (data.phase === "end" || data.phase === "error") &&
      data.startedAt === undefined &&
      routing.lifecycleStartedAt !== undefined
    ) {
      // Preserve this run's identity after a newer run takes over its session.
      data = { ...data, startedAt: routing.lifecycleStartedAt };
    }
  }
  if (context) {
    recordAgentEventRouting(event.runId, context);
  }
  const nextSeq = Math.max(runState.seq, state.runs.get(event.runId)?.seq ?? 0) + 1;
  runState.seq = nextSeq;
  state.runs.set(event.runId, runState);
  if (context) {
    context.lastActiveAt = Date.now();
    recordExecutionActivity(context, event);
  }
  const isControlUiVisible = routing?.isControlUiVisible ?? true;
  const eventSessionKey =
    typeof event.sessionKey === "string" && event.sessionKey.trim() ? event.sessionKey : undefined;
  // Hidden subscribers retain owner-bound routing without exposing a public session key.
  const deliverySessionKey =
    claimId !== undefined
      ? (eventSessionKey ?? routing?.sessionKey)
      : !isControlUiVisible && event.stream !== "lifecycle"
        ? routing?.sessionKey
        : undefined;
  // Hidden channel-routed runs should not leak live assistant/tool traffic into
  // Control UI, but lifecycle events still need the session key so gateway
  // listeners can persist terminal session state even if run-context lookup is
  // unavailable by the time the terminal event arrives. Terminal failures are
  // emitted on the lifecycle stream with `phase: "error"`; the separate error
  // stream remains redacted for hidden runs because it is observational only.
  const preserveSessionKey = isControlUiVisible || event.stream === "lifecycle";
  const sessionKey = preserveSessionKey ? (eventSessionKey ?? routing?.sessionKey) : undefined;
  // Stamp lifecycle events with the owning sessionId (see AgentEventPayload) at
  // emit time, since the run context can be cleared before the terminal persists.
  const sessionId =
    event.stream === "lifecycle" ? (event.sessionId ?? routing?.sessionId) : event.sessionId;
  const lifecycleGeneration =
    event.stream === "lifecycle"
      ? (ownedLifecycleGeneration ?? currentLifecycleGeneration)
      : ownedLifecycleGeneration;
  const agentId = event.agentId ?? routing?.agentId;
  const enriched: AgentEventRuntimePayload = {
    ...event,
    data,
    sessionKey,
    ...(sessionId ? { sessionId } : {}),
    ...(agentId ? { agentId } : {}),
    seq: nextSeq,
    ts: Date.now(),
  };
  if (event.stream === "lifecycle") {
    // A listener can synchronously emit a terminal before this event reaches the publisher.
    // Internal settlement observers consume the event without claiming publication.
    const publication = reservedPublication ?? Symbol("agent lifecycle publication");
    let consumed = false;
    Object.defineProperty(enriched, "admitLifecyclePublication", {
      value: () => {
        if (
          consumed ||
          (runState.terminalPublication && runState.terminalPublication !== publication)
        ) {
          return false;
        }
        consumed = true;
        if (isDefinitiveRunLifecycle({ phase: data.phase, data })) {
          runState.terminalPublication = publication;
        }
        return true;
      },
    });
  }
  // defineProperty consumes the descriptor synchronously; keep one per event.
  const metadata: PropertyDescriptor = {
    value:
      terminalPersistence ??
      (event.stream === "lifecycle" && isDefinitiveRunLifecycle({ phase: data.phase, data })
        ? captureAgentRunTerminalPersistence(event.runId, context ?? capturedOwner)
        : undefined),
    enumerable: false,
  };
  Object.defineProperty(enriched, "terminalPersistence", metadata);
  metadata.value = assistantSource;
  Object.defineProperty(enriched, "assistantSource", metadata);
  metadata.value = assistantProjection;
  Object.defineProperty(enriched, "assistantProjection", metadata);
  if (lifecycleGeneration) {
    // Persistence needs restart ownership, but agent events are also spread into
    // public payloads. Keep the internal generation readable without serializing it.
    metadata.value = lifecycleGeneration;
    Object.defineProperty(enriched, "lifecycleGeneration", metadata);
  }
  for (const [key, source] of AGENT_EVENT_ROUTING_FIELDS) {
    const value = routing?.[source];
    if (value !== undefined) {
      metadata.value = value;
      Object.defineProperty(enriched, key, metadata);
    }
  }
  if (claimId !== undefined) {
    metadata.value = claimId;
    Object.defineProperty(enriched, "contextClaimId", metadata);
  }
  if (deliverySessionKey) {
    metadata.value = deliverySessionKey;
    Object.defineProperty(enriched, "deliverySessionKey", metadata);
  }
  return enriched;
}

function dispatchAgentEvent(
  event: Omit<AgentEventPayload, "seq" | "ts">,
  claimId?: string,
  expectedContext?: AgentRunContext,
  reservedPublication?: symbol,
  assistantSource?: AgentAssistantSourceReceipt,
  assistantProjection?: AgentAssistantProjection,
  terminalPersistence?: AgentEventRuntimePayload["terminalPersistence"],
  captureReceipt?: (receipt: AgentRunPersistenceReceipt | undefined) => void,
): boolean {
  const state = getAgentEventState();
  const enriched = enrichAgentEvent(
    state,
    event,
    claimId,
    expectedContext,
    reservedPublication,
    assistantSource,
    assistantProjection,
    terminalPersistence,
  );
  if (!enriched) {
    return false;
  }
  const owner = getAgentRunContext(enriched.runId);
  const occurrenceOwner = owner ?? state.runs.get(enriched.runId)!;
  const generation = enriched.lifecycleGeneration ?? getAgentRunLifecycleGeneration();
  // New subscriptions start with the next event, even when a listener emits recursively.
  const global = state.listeners.registrations;
  const run = state.runListeners.get(enriched.runId)?.registrations;
  let deliveries: Map<AgentEventRegistration, () => boolean> | undefined;
  // Capture registrations before callbacks can replace them. New subscriptions
  // during this emission have no captured delivery authority until the next event.
  // Only global runtime registrations capture delivery authority.
  for (const registration of global) {
    try {
      if (registration.captureDelivery) {
        const isDeliveryCurrent = registration.captureDelivery(enriched);
        (deliveries ??= new Map()).set(registration, isDeliveryCurrent);
      }
    } catch {
      // A failed capture must not prevent delivery to other registrations.
    }
  }
  const persistence: AgentRunPersistenceWork[] = [];
  for (const handler of state.persistenceHandlers ?? []) {
    const captured = handler(enriched);
    if (!captured) continue;
    if ("run" in captured) persistence.push(captured);
    else {
      void captured.catch(() => undefined);
      persistence.push({ run: () => captured });
    }
  }
  const deliver = () => {
    // Both snapshots are already in registration order; merge without materializing a cohort.
    let globalIndex = 0;
    let runIndex = 0;
    while (true) {
      const globalRegistration = global[globalIndex];
      const runRegistration = run?.[runIndex];
      const registration =
        globalRegistration && (!runRegistration || globalRegistration.id < runRegistration.id)
          ? globalRegistration
          : runRegistration;
      if (!registration) {
        break;
      }
      if (registration === globalRegistration) {
        globalIndex++;
      } else {
        runIndex++;
      }
      try {
        if (!registration.active) {
          continue;
        }
        const isDeliveryCurrent = deliveries?.get(registration);
        if (!registration.captureDelivery) {
          registration.listener(enriched);
        } else if (isDeliveryCurrent?.()) {
          registration.listener(enriched, isDeliveryCurrent);
        }
      } catch {
        // Match ordinary listener delivery: isolate each subscriber's failure.
      }
    }
  };
  if (persistence.length === 0 && !hasAgentRunPersistence(occurrenceOwner)) {
    deliver();
    captureReceipt?.(undefined);
  } else {
    // Retrying this receipt reuses the sequenced occurrence and captured cohort.
    // Already committed handlers and delivered observers are never repeated.
    enriched.data = structuredClone(enriched.data);
    let committed = 0;
    let delivered = false;
    const assertCurrent = () => {
      const current = getAgentRunContext(enriched.runId);
      if (
        getAgentRunLifecycleGeneration() !== generation ||
        (current !== undefined && current !== owner) ||
        (claimId !== undefined &&
          getAgentRunContextOwnership(enriched.runId) !== undefined &&
          !resolveAgentEventRouting(enriched, claimId, current ? expectedContext : undefined))
      )
        throw new Error("Agent event owner changed before durable publication");
    };
    const receipt = captureAgentRunPersistence(occurrenceOwner, {
      run: async () => {
        assertCurrent();
        while (committed < persistence.length) {
          await persistence[committed]!.run();
          committed += 1;
        }
        assertCurrent();
        if (!delivered) {
          delivered = true;
          deliver();
        }
      },
    });
    captureReceipt?.(receipt);
  }
  return true;
}

/** Emits an event only when its run ownership is still current. */
export function emitAgentEventIfCurrent(event: Omit<AgentEventPayload, "seq" | "ts">): boolean {
  return dispatchAgentEvent(event);
}

/** Bind the source occurrence only after ordinary event ownership admission. */
export function emitAgentEventWithAssistantSourceIfCurrent(
  event: Omit<AgentEventPayload, "seq" | "ts">,
  assistantSource: AgentAssistantSourceReceipt | undefined,
  assistantProjection?: AgentAssistantProjection,
): boolean {
  return dispatchAgentEvent(
    event,
    undefined,
    undefined,
    undefined,
    assistantSource,
    assistantProjection,
  );
}

/** Adds one completed model call, returning its accepted run total for local callbacks. */
export function emitAgentRunOutputTokens(params: {
  runId: string;
  lifecycleGeneration: string;
  outputTokens: number;
  usageReport?: { state: "available" | "unavailable" };
  sessionKey?: string;
}): { outputTokens: number; usageReport?: { state: "available" | "unavailable" } } | undefined {
  return recordAgentRunOutputTokens({
    ...params,
    emit: (data) =>
      emitAgentEventIfCurrent({
        runId: params.runId,
        lifecycleGeneration: params.lifecycleGeneration,
        sessionKey: params.sessionKey,
        stream: "usage",
        data,
      }),
  });
}

/** Emits an agent event after assigning per-run sequence, timestamp, and context metadata. */
export function emitAgentEvent(event: Omit<AgentEventPayload, "seq" | "ts">) {
  emitAgentEventIfCurrent(event);
}

export function emitAgentEventForOwner(
  event: Omit<AgentEventPayload, "seq" | "ts">,
  claimId: string,
): boolean {
  return dispatchAgentEvent(event, claimId);
}

/** Emits only while the exact run-context record captured by its producer remains current. */
export function emitAgentEventForRunContext(
  event: Omit<AgentEventPayload, "seq" | "ts">,
  context: AgentRunContext,
): boolean {
  return dispatchAgentEvent(event, undefined, context);
}
/** Capture and start one occurrence; callers retry its receipt, never emit another event. */
export function prepareAgentEventForRunContext(
  event: Omit<AgentEventPayload, "seq" | "ts">,
  context: AgentRunContext,
): AgentRunPersistenceReceipt | undefined {
  let receipt: AgentRunPersistenceReceipt | undefined;
  const accepted = dispatchAgentEvent(
    event,
    undefined,
    context,
    undefined,
    undefined,
    undefined,
    undefined,
    (captured) => {
      receipt = captured;
    },
  );
  return accepted
    ? (receipt ?? { pending: Promise.resolve(), retry: () => Promise.resolve() })
    : undefined;
}

export function registerAgentEventPersistenceHandler(
  handler: (event: AgentEventRuntimePayload) => void | Promise<void> | AgentRunPersistenceWork,
): () => void {
  const handlers = (getAgentEventState().persistenceHandlers ??= new Set());
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}
/** Emits run metadata only to the Gateway-owned durable audit projection. */
export function emitAgentAuditEvent(event: Omit<AgentEventPayload, "seq" | "ts">) {
  const state = getAgentEventState();
  const enriched = enrichAgentEvent(state, event);
  if (enriched) {
    notifyListeners(state.auditListeners, enriched);
    const phase = event.stream === "lifecycle" ? event.data.phase : undefined;
    if ((phase === "end" || phase === "error") && !getAgentRunContext(event.runId)) {
      // Private synthetic runs bypass public terminal cleanup. Release sequence state only
      // after synchronous audit listeners consume the terminal event and its final ordering.
      state.runs.delete(event.runId);
    }
  }
}

/** Subscribes to sequenced agent events; returns an unsubscribe callback. */
export function onAgentEvent(listener: (evt: AgentEventPayload) => void) {
  return registerAgentEventListener(listener);
}

/** Subscribes Gateway internals that consume non-public ownership and routing metadata. */
export function onAgentRuntimeEvent(
  listener: AgentEventListener,
  captureDelivery?: CaptureAgentEventDelivery,
) {
  return registerAgentEventListener(listener, undefined, captureDelivery);
}

/**
 * Subscribes to one run's sequenced agent events; returns an unsubscribe callback.
 * Prefer this over `onAgentEvent` for a listener that discards other runs: those
 * listeners otherwise run on every concurrent run's events.
 */
export function onAgentEventForRun(runId: string, listener: (evt: AgentEventPayload) => void) {
  return registerAgentEventListener(listener, runId);
}

function registerAgentEventListener(
  listener: AgentEventListener,
  runId?: string,
  captureDelivery?: CaptureAgentEventDelivery,
) {
  const state = getAgentEventState();
  const bucket =
    runId === undefined
      ? state.listeners
      : (state.runListeners.get(runId) ?? { registrations: [] });
  if (!bucket.registrations.some((registration) => registration.listener === listener)) {
    bucket.registrations = [
      ...bucket.registrations,
      { listener, id: state.nextListenerId++, captureDelivery, active: true },
    ];
    if (runId !== undefined) {
      state.runListeners.set(runId, bucket);
    }
  }
  return () => {
    bucket.registrations = bucket.registrations.filter((registration) => {
      if (registration.listener !== listener) {
        return true;
      }
      registration.active = false;
      return false;
    });
    // Only reclaim the bucket this handle registered into; a later subscriber
    // for the same run may already have installed a replacement.
    if (
      runId !== undefined &&
      bucket.registrations.length === 0 &&
      state.runListeners.get(runId) === bucket
    ) {
      state.runListeners.delete(runId);
    }
  };
}

/** Subscribes to private audit-only agent events; returns an unsubscribe callback. */
export function onAgentAuditEvent(listener: (evt: AgentEventPayload) => void) {
  return registerListener(getAgentEventState().auditListeners, listener);
}

/** Clears agent event state; test suites with a live Gateway can preserve its listeners. */
export function resetAgentEventsForTest(options?: { preserveListeners?: boolean }) {
  const state = getAgentEventState();
  state.runs.clear();
  resetAgentRunRegistryForTest();
  if (!options?.preserveListeners) {
    for (const bucket of [state.listeners, ...state.runListeners.values()]) {
      for (const registration of bucket.registrations) {
        registration.active = false;
      }
      bucket.registrations = [];
    }
    state.runListeners.clear();
    state.auditListeners.clear();
    state.persistenceHandlers?.clear();
  }
}
