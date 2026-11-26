import { isExecutionIdentityCollectionEnabled } from "../audit/audit-config.js";
/** Canonical operational instance and optional enabled execution-identity evidence. */
import {
  createExecutionIdentityAdmissionToken,
  enqueueExecutionIdentityContextAtAdmission,
  type ExecutionIdentityAdmissionFacts,
  type ExecutionIdentityAdmissionToken,
} from "../audit/execution-identity-admission.js";
import { executionIdentitySpawnAdmission } from "../audit/execution-identity-spawn-admission.js";
import {
  composeSessionSourceAssertion,
  prepareSessionSourceScope,
  runWithSessionSourceScope,
} from "../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  awaitAgentRunAdmission,
  captureAgentRunDelegatedSourceAssertion,
  claimAgentRunDelegatedAuthority,
  getAgentRunLifecycleGeneration,
  getAgentRunContext,
  readAgentRunDelegatedAuthorityFailure,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { scopeOperatorAccessDecisions } from "../infra/operator-access-decision.js";
import { isOperatorAuthorityUnavailable } from "../infra/operator-authority-error.js";
import type { PluginHookRequesterContinuation } from "../plugins/hook-agent-context.types.js";
import { prepareGatewayContextBindingOwner } from "../plugins/runtime/gateway-context-binding-owner.js";
import { assertAdmittedRunOperatorAuthority } from "./admitted-run-operator-authority.js";
import type { AdmittedRunOperatorAuthority } from "./admitted-run-operator-authority.types.js";
import { bindRequesterOwnerIdentity } from "./cron-creator-authority-context.js";
import {
  createOperationalRunInstanceRef,
  type OperationalRunInstanceRef,
} from "./operational-run-instance.js";

export {
  createOperationalRunInstanceRef,
  type OperationalRunInstanceRef,
} from "./operational-run-instance.js";

/** Exact context carried by one admitted execution and every retry/fallback it owns. */
export type AdmittedRunContext = Readonly<{
  operationalRunInstance: OperationalRunInstanceRef;
  /** Scheduler-authored ingress authority, independent of optional audit collection. */
  admissionSource?: "operator-schedule" | "requester-schedule";
  executionIdentityToken?: ExecutionIdentityAdmissionToken;
}>;

export type { AdmittedRunOperatorAuthority } from "./admitted-run-operator-authority.types.js";

/** Prepared and admitted paths share the same source throughout retries and detached work. */
export function readRunOperatorAuthority(params: {
  preparedRunAdmission?: PreparedAgentRunAdmission;
  admittedRunContext?: AdmittedRunContext;
}): AdmittedRunOperatorAuthority | undefined {
  return (
    readAdmittedRunOperatorAuthority(params.admittedRunContext) ??
    readPreparedRunOperatorAuthority(params.preparedRunAdmission)
  );
}

export type PreparedAgentRunAdmission = Readonly<{
  operationalRunInstance: OperationalRunInstanceRef;
  /** Exact post-prepare owner; repeated fallback/retry returns the same object. */
  admit: (
    runtimeKind: ExecutionIdentityAdmissionFacts["runtime"]["kind"],
    runtimeInstanceId?: string,
  ) => Promise<AdmittedRunContext>;
  /** Checks latched source revocation after normal close; never grants execution authority. */
  assertSourceCurrent: () => void;
  /** Checks open preparation and its exact admitted owner without evaluating source predicates. */
  assertCurrent: () => void;
  /** Host-only source restriction available before the runtime prepares its tools. */
  readOperatorAuthority?: () => AdmittedRunOperatorAuthority | undefined;
  /** Idempotently closes the exact delegated approval lease, if admission occurred. */
  close: () => void;
}>;

type DelegatedAuthorityLease = {
  authority: AgentRunDelegatedAuthority;
  foregroundClosed: boolean;
  requesterContinuation?: PluginHookRequesterContinuation;
  assertSourceCurrent?: () => void;
  operatorAuthority?: AdmittedRunOperatorAuthority;
};

const delegatedAuthorityLeases = new WeakMap<AdmittedRunContext, DelegatedAuthorityLease>();
const admittedContextsByAuthority = new WeakMap<AgentRunDelegatedAuthority, AdmittedRunContext>();
const activeNativeHookRecoveryLeases = new Map<
  string,
  { lease: DelegatedAuthorityLease; releaseOperatorAuthority?: () => void }
>();

/** Reprepare source predicates after the caller establishes an exact transcript fence. */
export function runWithPreparedRunSourceScope<T>(
  params: {
    preparedRunAdmission?: PreparedAgentRunAdmission;
    admittedRunContext?: AdmittedRunContext;
  },
  run: () => Promise<T>,
): Promise<T> {
  let assertion = params.preparedRunAdmission?.assertSourceCurrent;
  if (params.admittedRunContext) {
    const lease = delegatedAuthorityLeases.get(params.admittedRunContext);
    const captured =
      lease && captureAdmittedRunActiveAssertion(params.admittedRunContext, lease.authority);
    if (!captured) {
      return Promise.reject(new Error("admitted run authority is no longer active"));
    }
    assertion = captured;
  }
  return runWithSessionSourceScope(assertion, run, { checkAfter: false });
}

function bindAdmittedRunDelegatedAuthority(
  context: AdmittedRunContext,
  assertSourceCurrent?: () => void,
  operatorAuthority?: AdmittedRunOperatorAuthority,
): void {
  const authority = claimAgentRunDelegatedAuthority(
    context.operationalRunInstance,
    assertSourceCurrent,
  );
  const previousRecovery = activeNativeHookRecoveryLeases.get(context.operationalRunInstance.runId);
  activeNativeHookRecoveryLeases.delete(context.operationalRunInstance.runId);
  previousRecovery?.releaseOperatorAuthority?.();
  const lease = { authority, foregroundClosed: false, assertSourceCurrent, operatorAuthority };
  delegatedAuthorityLeases.set(context, lease);
  if (!admittedContextsByAuthority.has(authority)) {
    admittedContextsByAuthority.set(authority, context);
  }
}

/** Reads the immutable outer-run authority without reviving a closed claim. */
export function getAdmittedRunDelegatedAuthority(
  context: AdmittedRunContext,
): AgentRunDelegatedAuthority | undefined {
  const lease = delegatedAuthorityLeases.get(context);
  return lease && !lease.foregroundClosed && validateAgentRunDelegatedAuthority(lease.authority)
    ? lease.authority
    : undefined;
}

/** Attach the original requester only after native recovery admission proved its exact source. */
export function bindAdmittedRunRequesterContinuation(
  context: AdmittedRunContext,
  source: PluginHookRequesterContinuation,
): void {
  const lease = delegatedAuthorityLeases.get(context);
  if (
    !lease ||
    !getAdmittedRunDelegatedAuthority(context) ||
    source.runId !== context.operationalRunInstance.runId ||
    lease.requesterContinuation
  ) {
    throw new Error("Requester continuation requires its exact admitted run");
  }
  const assertSourceCurrent = source.assertCurrent;
  const authority = lease.authority;
  const assertCurrent = () => {
    if (getAdmittedRunDelegatedAuthority(context) !== authority) {
      throw new Error("Requester continuation is no longer active");
    }
    assertSourceCurrent();
    const current = getAgentRunContext(source.runId);
    if (
      getAdmittedRunDelegatedAuthority(context) !== authority ||
      current?.agentId !== source.agentId ||
      current.sessionKey !== source.sessionKey ||
      current.sessionId !== source.sessionId
    ) {
      throw new Error("Requester continuation is no longer active");
    }
  };
  // Session facts may be installed by the admission owner after this callback.
  // Projection and every use below require the complete exact incarnation.
  assertSourceCurrent();
  lease.requesterContinuation = Object.freeze({ ...source, assertCurrent });
}

/** Project current original-source custody, never the session's stored last sender. */
export function resolveAdmittedRunRequesterContinuation(params: {
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
}): PluginHookRequesterContinuation | undefined {
  const current = params.runId ? getAgentRunContext(params.runId) : undefined;
  const authority = current?.delegatedAuthority;
  const context = authority && admittedContextsByAuthority.get(authority);
  const lease = context && delegatedAuthorityLeases.get(context);
  if (context && lease && !lease.requesterContinuation && current) {
    // The native yield owner retains the original requester independently of the old
    // foreground run. Resolve only in that exact admitted continuation's live scope.
    const owner = bindRequesterOwnerIdentity({ ...params, agentId: current.agentId });
    if (
      owner?.sourceTurnId &&
      owner.channel &&
      owner.senderId &&
      current.agentId &&
      params.runId &&
      params.sessionKey &&
      params.sessionId
    ) {
      bindAdmittedRunRequesterContinuation(context, {
        runId: params.runId,
        agentId: current.agentId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        sourceTurnId: owner.sourceTurnId,
        channel: owner.channel,
        senderId: owner.senderId,
        accountId: owner.accountId,
        chatId: owner.chatId,
        eventId: owner.eventId,
        assertCurrent: owner.assertCurrent,
      });
    }
  }
  const proof = lease?.requesterContinuation;
  if (
    !proof ||
    proof.runId !== params.runId ||
    proof.sessionKey !== params.sessionKey ||
    proof.sessionId !== params.sessionId ||
    current?.agentId !== proof.agentId ||
    current.sessionKey !== proof.sessionKey ||
    current.sessionId !== proof.sessionId
  ) {
    return undefined;
  }
  proof.assertCurrent();
  return proof;
}

/** Captures the operator's source lifetime from a live run, including for detached children. */
export function readAdmittedRunOperatorAuthority(
  context: AdmittedRunContext | undefined,
): AdmittedRunOperatorAuthority | undefined {
  if (!context) {
    return undefined;
  }
  const operatorAuthority = delegatedAuthorityLeases.get(context)?.operatorAuthority;
  if (!operatorAuthority) {
    return undefined;
  }
  if (!getAdmittedRunDelegatedAuthority(context)) {
    throw new Error("admitted run operator authority is no longer active");
  }
  return operatorAuthority;
}

/** Reads the same source ceiling used by admission without minting run authority. */
export function readPreparedRunOperatorAuthority(
  prepared: PreparedAgentRunAdmission | undefined,
): AdmittedRunOperatorAuthority | undefined {
  const authority = prepared?.readOperatorAuthority?.();
  if (authority !== undefined) {
    assertAdmittedRunOperatorAuthority(authority);
  }
  return authority;
}

/** Reads the original admission source only through its exact live authority. */
export function getAdmittedRunSource(
  authority: AgentRunDelegatedAuthority | undefined,
): AdmittedRunContext["admissionSource"] {
  const context = authority && admittedContextsByAuthority.get(authority);
  return context && getAdmittedRunDelegatedAuthority(context) === authority
    ? context.admissionSource
    : undefined;
}

/** Captures an exact admitted-run assertion for work that may cross an await boundary. */
export function resolveAdmittedRunActiveAssertion(
  context: AdmittedRunContext,
  signal?: AbortSignal,
): ReturnType<typeof captureAdmittedRunActiveAssertion> {
  const authority = getAdmittedRunDelegatedAuthority(context);
  return authority ? captureAdmittedRunActiveAssertion(context, authority, signal) : undefined;
}

/** Capture an already-resolved authority without repeating its source reads. */
export function captureAdmittedRunActiveAssertion(
  context: AdmittedRunContext,
  authority: AgentRunDelegatedAuthority,
  signal?: AbortSignal,
) {
  const operationalRunInstance = context.operationalRunInstance;
  const lease = delegatedAuthorityLeases.get(context);
  const refuse = (): never => {
    throw new Error(
      "admitted run authority is no longer active",
      readAgentRunDelegatedAuthorityFailure(authority),
    );
  };
  const source = captureAgentRunDelegatedSourceAssertion(authority, refuse);
  if (!lease || lease.foregroundClosed || lease.authority !== authority || !source) {
    return undefined;
  }
  const assertLocalCurrent = (assertSource: () => void) => {
    if (
      signal?.aborted ||
      context.operationalRunInstance !== operationalRunInstance ||
      delegatedAuthorityLeases.get(context) !== lease ||
      lease.foregroundClosed
    ) {
      refuse();
    }
    assertSource();
  };
  return Object.assign(
    composeSessionSourceAssertion(
      [source.assertCurrent],
      scopeOperatorAccessDecisions(assertLocalCurrent),
      { synchronousCheck: true },
    ),
    {
      assertScopeCurrent: () => assertLocalCurrent(source.assertBinding),
    },
  );
}

/** Idempotently compare-releases the authority captured by this admission. */
export function closeAdmittedRunDelegatedAuthority(context: AdmittedRunContext): boolean {
  const lease = delegatedAuthorityLeases.get(context);
  if (!lease || lease.foregroundClosed) {
    return false;
  }
  lease.foregroundClosed = true;
  releaseAgentRunDelegatedAuthority(lease.authority);
  return true;
}

type AdmittedRunBeforeToolCallRecovery = Readonly<{
  assertActive: () => void;
  release: () => void;
}>;

/** Recovery-only lease for the already-created native pre-tool policy callback. */
export function retainAdmittedRunBeforeToolCallRecovery(
  context: AdmittedRunContext,
): AdmittedRunBeforeToolCallRecovery | undefined {
  const lease = delegatedAuthorityLeases.get(context);
  const runId = context.operationalRunInstance.runId;
  if (
    !lease ||
    lease.foregroundClosed ||
    activeNativeHookRecoveryLeases.has(runId) ||
    !validateAgentRunDelegatedAuthority(lease.authority)
  ) {
    return undefined;
  }
  const recovery = {
    lease,
    releaseOperatorAuthority: lease.operatorAuthority?.retain?.(),
  };
  activeNativeHookRecoveryLeases.set(runId, recovery);
  const assertActive = () => {
    // Retaining native policy outlives the foreground claim, never its source owner.
    lease.assertSourceCurrent?.();
    if (
      getAgentRunLifecycleGeneration() !== lease.authority.lifecycleGeneration ||
      activeNativeHookRecoveryLeases.get(runId) !== recovery
    ) {
      throw new Error("admitted run native hook recovery is no longer active");
    }
  };
  return {
    assertActive,
    release: () => {
      if (activeNativeHookRecoveryLeases.get(runId) === recovery) {
        activeNativeHookRecoveryLeases.delete(runId);
        recovery.releaseOperatorAuthority?.();
      }
    },
  };
}

/** Prepares a system-owned run without selecting its eventual execution runtime early. */
export function prepareSystemAgentRunAdmission(
  cfg: OpenClawConfig,
  runId: string,
  agentId: string,
  boundary: string,
  assertSourceCurrent?: () => void,
  operatorAuthority?: AdmittedRunOperatorAuthority,
): PreparedAgentRunAdmission {
  return prepareAgentRunAdmission({
    cfg,
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    assertSourceCurrent,
    operatorAuthority,
    facts: {
      runId,
      agentId,
      ingress: { kind: "system", boundary, state: "present" },
    },
  });
}

/**
 * Freezes ingress facts before preparation while deferring allocation/capture until the
 * authoritative runtime owner is selected immediately before execution.
 */
export function prepareAgentRunAdmission(params: {
  cfg: OpenClawConfig;
  admissionSource?: AdmittedRunContext["admissionSource"];
  facts: Omit<ExecutionIdentityAdmissionFacts, "runtime">;
  operationalRunInstance: OperationalRunInstanceRef;
  onAdmitted?: (context: AdmittedRunContext) => void | Promise<void>;
  assertSourceCurrent?: () => void;
  operatorAuthority?: AdmittedRunOperatorAuthority;
}): PreparedAgentRunAdmission {
  const operationalRunInstance = params.operationalRunInstance;
  if (operationalRunInstance.runId !== params.facts.runId) {
    throw new Error("operational run instance disagrees with prepared admission");
  }
  const sourceAssertion = params.assertSourceCurrent;
  const operatorAuthority = params.operatorAuthority;
  if (operatorAuthority !== undefined) {
    assertAdmittedRunOperatorAuthority(operatorAuthority);
  }
  const assertOperatorCurrent = operatorAuthority?.assertCurrent;
  const releaseOperatorAuthority = operatorAuthority?.retain?.();
  let sourceFailure: Error | undefined;
  const assertSourceCurrent =
    (sourceAssertion || assertOperatorCurrent) &&
    composeSessionSourceAssertion(
      [sourceAssertion, assertOperatorCurrent],
      scopeOperatorAccessDecisions((assertSources: () => void) => {
        if (sourceFailure) {
          throw sourceFailure;
        }
        try {
          assertSources();
        } catch (error) {
          if (!isOperatorAuthorityUnavailable(error)) {
            sourceFailure = new Error("source execution authority is no longer active", {
              cause: error,
            });
          }
          throw error;
        }
      }),
      { synchronousCheck: true },
    );
  let admittedRuntimeKind: ExecutionIdentityAdmissionFacts["runtime"]["kind"] | undefined;
  let admittedRuntimeInstanceId: string | undefined;
  let admitted: Promise<AdmittedRunContext> | undefined;
  let admittedContext: AdmittedRunContext | undefined;
  let closed = false;
  const assertPreparationOpen = () => {
    if (closed) {
      throw new Error("prepared execution context is already closed");
    }
  };
  const scopedSource = composeSessionSourceAssertion(
    [assertSourceCurrent],
    (assertSource) => {
      assertPreparationOpen();
      assertSource();
    },
    { synchronousCheck: true },
  );
  const prepared: PreparedAgentRunAdmission = Object.freeze({
    operationalRunInstance,
    assertCurrent: () => {
      assertPreparationOpen();
      if (!admittedContext) {
        return;
      }
      const lease = delegatedAuthorityLeases.get(admittedContext);
      const assertActive =
        lease && captureAdmittedRunActiveAssertion(admittedContext, lease.authority);
      if (!assertActive) {
        throw new Error("prepared execution authority is no longer active");
      }
      assertActive.assertScopeCurrent();
    },
    assertSourceCurrent: Object.assign(
      composeSessionSourceAssertion([assertSourceCurrent], undefined, { synchronousCheck: true }),
      {
        assertScopeCurrent: assertPreparationOpen,
        prepareSessionSourceScope: () => {
          assertPreparationOpen();
          return prepareSessionSourceScope(scopedSource);
        },
      },
    ),
    readOperatorAuthority: () => {
      if (operatorAuthority) {
        if (closed) {
          throw new Error("prepared operator authority is no longer active");
        }
        operatorAuthority.assertCurrent();
      }
      return operatorAuthority;
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      if (admittedContext) {
        closeAdmittedRunDelegatedAuthority(admittedContext);
      } else {
        void admitted?.then(closeAdmittedRunDelegatedAuthority).catch(() => undefined);
      }
      releaseOperatorAuthority?.();
    },
    admit: (runtimeKind, runtimeInstanceId) => {
      if (closed) {
        return Promise.reject(new Error("prepared execution context is already closed"));
      }
      // The first runtime that actually executes fixes the captured runtime fact.
      // Later fallback paths reuse this exact admission instead of recapturing identity.
      const fixedRuntimeKind = (admittedRuntimeKind ??= runtimeKind);
      admittedRuntimeInstanceId ??= runtimeInstanceId?.trim() || undefined;
      admitted ??= runWithSessionSourceScope(
        assertSourceCurrent,
        async () => {
          operatorAuthority?.reauthorize?.();
          assertSourceCurrent?.();
          const facts = executionIdentitySpawnAdmission({
            operation: "attach",
            value: { ...params.facts, runtime: { kind: fixedRuntimeKind } },
            extra: executionIdentitySpawnAdmission({ operation: "read", value: params.facts }),
          });
          const context = admitPreparedAgentRun({
            cfg: params.cfg,
            admissionSource: params.admissionSource,
            facts,
            operationalRunInstance,
            runtimeInstanceId: admittedRuntimeInstanceId,
          });
          bindAdmittedRunDelegatedAuthority(context, assertSourceCurrent, operatorAuthority);
          admittedContext = context;
          try {
            await awaitAgentRunAdmission(
              params.facts.runId,
              getAgentRunContext(params.facts.runId),
            );
            assertSourceCurrent?.();
            await params.onAdmitted?.(context);
            if (closed || !getAdmittedRunDelegatedAuthority(context)) {
              throw new Error("prepared execution authority closed during admission");
            }
            return context;
          } catch (error) {
            closeAdmittedRunDelegatedAuthority(context);
            throw error;
          }
        },
        { checkAfter: false },
      );
      return admitted;
    },
  });
  return prepared;
}

/** Resolves a host-only continuation or validates an already-admitted internal caller. */
export async function resolvePreparedRunAdmission(params: {
  runId: string;
  runtimeKind: ExecutionIdentityAdmissionFacts["runtime"]["kind"];
  runtimeInstanceId?: string;
  admittedRunContext?: AdmittedRunContext;
  preparedRunAdmission?: PreparedAgentRunAdmission;
}): Promise<AdmittedRunContext> {
  if (params.admittedRunContext && params.preparedRunAdmission) {
    throw new Error("run cannot carry both prepared and admitted execution contexts");
  }
  const admitted = params.preparedRunAdmission
    ? await params.preparedRunAdmission.admit(params.runtimeKind, params.runtimeInstanceId)
    : params.admittedRunContext;
  if (!admitted || admitted.operationalRunInstance.runId !== params.runId) {
    throw new Error("prepared execution context is unavailable or disagrees with the run");
  }
  const lease = delegatedAuthorityLeases.get(admitted);
  if (lease && !getAdmittedRunDelegatedAuthority(admitted)) {
    throw new Error("prepared execution authority is no longer active");
  }
  return admitted;
}

/**
 * Owns the single post-prepare allocation/adoption/capture decision for an execution.
 * Queue loss remains audit loss only; the admitted execution keeps its exact token object.
 */
function admitPreparedAgentRun(params: {
  cfg: OpenClawConfig;
  admissionSource?: AdmittedRunContext["admissionSource"];
  facts: ExecutionIdentityAdmissionFacts;
  operationalRunInstance: OperationalRunInstanceRef;
  runtimeInstanceId?: string;
}): AdmittedRunContext {
  if (params.operationalRunInstance.runId !== params.facts.runId) {
    throw new Error("operational run instance disagrees with prepared admission");
  }
  const operationalRunInstance = params.operationalRunInstance;
  const admitted = {
    operationalRunInstance,
    ...(params.admissionSource ? { admissionSource: params.admissionSource } : {}),
  };
  if (!isExecutionIdentityCollectionEnabled(params.cfg)) {
    return Object.freeze(prepareGatewayContextBindingOwner(admitted));
  }
  const executionIdentityToken = createExecutionIdentityAdmissionToken(params.facts.runId);

  enqueueExecutionIdentityContextAtAdmission(params.facts, {
    enabled: true,
    token: executionIdentityToken,
    runtimeInstanceId: params.runtimeInstanceId,
  });
  return Object.freeze(prepareGatewayContextBindingOwner({ ...admitted, executionIdentityToken }));
}

export {
  createAdmittedRunOperatorAuthority,
  assertAdmittedRunOperatorAuthority,
  assertOperatorModelAllowed,
  createOperatorModelSelectionAssertion,
  assertOperatorAccessProgramAllowed,
  bindOperatorModelExecution,
} from "./admitted-run-operator-authority.js";
