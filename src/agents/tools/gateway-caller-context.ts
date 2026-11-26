import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import {
  inheritSessionEventToolPolicy,
  narrowSessionEventSettings,
} from "../../auto-reply/reply/session-event-policy.js";
import type { SessionEntriesCurrentCheck } from "../../config/sessions/session-entry-current.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import type { AgentRuntimeIdentity } from "../../gateway/agent-runtime-identity-token.js";
import { validateAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import type { BusinessApprovalConversation } from "../../infra/business-approval-conversation.js";
import {
  captureGatewayContextResolver,
  getGatewayContextResolver,
} from "../../plugins/runtime/gateway-context-binding.js";
// Ambient trusted caller context for model-mediated Gateway tool calls.
import { AsyncContext } from "../../shared/async-context.js";
import { runWithAsyncStore } from "../../shared/async-store.js";
import {
  captureAdmittedRunActiveAssertion,
  getAdmittedRunDelegatedAuthority,
  readAdmittedRunOperatorAuthority,
  type AdmittedRunContext,
} from "../admitted-run-context.js";
import { wrapAgentToolExecutionContext } from "../agent-tool-metadata.js";
import { captureActiveEmbeddedRunPersonalToolParticipants } from "../embedded-agent-runner/run-state.js";
import {
  captureRequesterOrigin,
  requesterCreatorProfileId,
  type RequesterOrigin,
} from "../requester-origin.js";
import { readToolStringParam, type AnyAgentTool } from "./common.js";
import {
  type ReceiptAuthority,
  type GatewayToolCallerIdentity as IssuedGatewayToolCallerIdentity,
  type GatewayToolCallerSource,
  type GatewayToolOperatorSelection,
} from "./gateway-caller-identity.types.js";
import type { GatewayToolCallerReceiptAdmission } from "./gateway-caller-receipt.types.js";

/** 11.10 publication and session-event fields on the extracted caller identity. */
type GatewayToolCallerIdentity = IssuedGatewayToolCallerIdentity & {
  /** The surface restates this caller session's own policy; follow-ups to that session skip it. */
  sessionEventToolsAllowSessionScoped?: true;
  /** Reporting attribution only; never restores the yielding turn's execution authority. */
  workspacePublicationRunId?: string;
  /** Effective requesting surface captured by local publication before yielding. */
  workspacePublicationPolicy?: {
    allow: string[];
    deny: string[];
    permissionMode?: SessionEntry["permissionMode"];
  };
};

const gatewayToolCallerStorage = new AsyncContext<GatewayToolCallerIdentity>(
  Symbol("gatewayToolCaller"),
);

const receiptAdmissionStorage = new AsyncContext<
  ReadonlyMap<GatewayToolCallerReceiptAdmission, () => boolean>
>(Symbol("gatewayToolReceiptAdmission"));

export function evaluateGatewayToolCallerReceiptAdmission(
  admission: GatewayToolCallerReceiptAdmission,
  otherwise: () => boolean,
): boolean {
  return (receiptAdmissionStorage.getStore()?.get(admission) ?? otherwise)();
}

type AdmittedGatewayToolCallerParams = {
  admittedRunContext: AdmittedRunContext;
  requesterOrigin?: RequesterOrigin;
  receiptAuthority?: ReceiptAuthority;
  receiptAdmission?: GatewayToolCallerReceiptAdmission;
  cronAuthorityCheck?: () => boolean;
  mintCronRequesterGrant?: GatewayToolCallerIdentity["mintCronRequesterGrant"];
  approvalSignals?: readonly AbortSignal[];
  agentId?: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceLocal?: true;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

function composeReceiptAuthority(
  ...predicates: Array<ReceiptAuthority | undefined>
): ((() => boolean) & ReceiptAuthority) | undefined {
  const checks = predicates.filter(
    (predicate, index): predicate is ReceiptAuthority =>
      predicate !== undefined && predicates.indexOf(predicate) === index,
  );
  const sources = checks.map((check) => captureGatewayToolReceiptAssertion(check));
  return checks.length === 0
    ? undefined
    : Object.assign(
        () => {
          let active = true;
          for (const check of checks) {
            try {
              active = check() !== false && active;
            } catch {
              active = false;
            }
          }
          return active;
        },
        composeSessionSourceAssertion(sources),
        {
          assertScopeCurrent: () => {
            for (const source of sources) {
              (source.assertScopeCurrent ?? source)();
            }
          },
        },
      );
}

/** Preserve boolean refusal across the receipt owner's prepared assertion. */
export function captureGatewayToolReceiptAssertion(
  receipt: ReceiptAuthority,
  message = "agent tool caller authority is no longer active",
): SessionSourceAssertion {
  const assertAllowed = (result: boolean | void) => {
    if (result === false) {
      throw new Error(message);
    }
  };
  const prepare = receipt.prepareSessionSource?.bind(receipt);
  const prepareEffect = receipt.prepareSessionSourceEffect?.bind(receipt);
  return Object.assign(() => assertAllowed(receipt()), {
    nativeSource: receipt.nativeSource,
    opaqueCommitGuard: receipt.opaqueCommitGuard,
    assertScopeCurrent: receipt.assertScopeCurrent?.bind(receipt),
    prepareSessionSourceScope: receipt.prepareSessionSourceScope?.bind(receipt),
    ...(prepareEffect
      ? {
          async prepareSessionSourceEffect() {
            const prepared = await prepareEffect();
            return {
              ...prepared,
              assertCurrent: () => assertAllowed(prepared.assertCurrent()),
              release: prepared.release?.bind(prepared),
            };
          },
        }
      : {}),
    ...(prepare
      ? {
          async prepareSessionSource() {
            const prepared = await prepare();
            const release = prepared.release?.bind(prepared);
            const assertPrepared = prepared.assertPreparedCurrent?.bind(prepared);
            return {
              ...prepared,
              nativeSource: prepared.nativeSource,
              opaqueCommitGuard: prepared.opaqueCommitGuard,
              checks: prepared.checks,
              assertCurrent: () => assertAllowed(prepared.assertCurrent()),
              ...(assertPrepared
                ? { assertPreparedCurrent: () => assertAllowed(assertPrepared()) }
                : {}),
              ...(release ? { release } : {}),
            };
          },
        }
      : {}),
  });
}

/** Builds host-owned Gateway authority from the exact admitted execution. */
export function createAdmittedGatewayToolCallerIdentity(
  params: AdmittedGatewayToolCallerParams,
): GatewayToolCallerIdentity | undefined {
  const agentId = params.agentId?.trim();
  const sessionKey = params.sessionKey?.trim();
  if (!agentId || !sessionKey) {
    return undefined;
  }
  const delegatedAuthority = getAdmittedRunDelegatedAuthority(params.admittedRunContext);
  const operatorAuthority = readAdmittedRunOperatorAuthority(params.admittedRunContext);
  return {
    agentId,
    sessionKey,
    requesterOrigin: captureRequesterOrigin({ requesterOrigin: params.requesterOrigin }),
    operationalRunInstance: params.admittedRunContext.operationalRunInstance,
    ...(delegatedAuthority ? { approvalAuthority: delegatedAuthority } : {}),
    ...(operatorAuthority ? { operatorAuthority } : {}),
    ...(params.receiptAuthority ? { approvalAuthorityCheck: params.receiptAuthority } : {}),
    ...(params.cronAuthorityCheck ? { cronAuthorityCheck: params.cronAuthorityCheck } : {}),
    executionIdentityToken: params.admittedRunContext.executionIdentityToken,
    gatewayContextResolver: captureGatewayContextResolver(
      getGatewayContextResolver(params.admittedRunContext),
    ),
    receiptAuthority: composeReceiptAuthority(
      (delegatedAuthority &&
        captureAdmittedRunActiveAssertion(params.admittedRunContext, delegatedAuthority)) ??
        (() => false),
      params.receiptAuthority,
    ),
    ...(params.receiptAdmission ? { receiptAdmissions: [params.receiptAdmission] } : {}),
    ...(params.approvalSignals?.length ? { approvalSignals: params.approvalSignals } : {}),
    ...(params.mintCronRequesterGrant
      ? { mintCronRequesterGrant: params.mintCronRequesterGrant }
      : {}),
    turnSourceChannel: params.turnSourceChannel,
    turnSourceLocal: params.turnSourceLocal,
    turnSourceTo: params.turnSourceTo,
    turnSourceAccountId: params.turnSourceAccountId,
    turnSourceThreadId: params.turnSourceThreadId,
  };
}

export function getGatewayToolCallerIdentity(): GatewayToolCallerIdentity | undefined {
  return gatewayToolCallerStorage.getStore();
}

/** Selection is model input; only the turn's host-owned participants grant a target. */
export async function withGatewayPersonalToolUser<T>(
  user: string | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  const caller = getGatewayToolCallerIdentity();
  if (!caller) {
    if (user !== undefined) {
      throw new Error("Selecting user requires an active personal-tool turn.");
    }
    return await run();
  }
  return await runWithAsyncStore(
    gatewayToolCallerStorage,
    {
      ...caller,
      personalToolUser: user,
      personalToolIdentityScoped: true,
      personalToolSelection: undefined,
    },
    run,
  );
}

/** One prepared identity per tool call; execution, approvals and receipts stay turn-owned. */
export function resolveGatewayToolOperatorSelection(options?: {
  requireRequesterOrigin?: boolean;
}): GatewayToolOperatorSelection {
  const caller = getGatewayToolCallerIdentity();
  let selection = caller?.personalToolSelection;
  if (!selection) {
    const participant =
      caller?.personalToolUser !== undefined ? resolveGatewayPersonalToolParticipant() : undefined;
    const selectedParticipant =
      participant?.profileId !== caller?.operatorAuthority?.profileId ? participant : undefined;
    const operatorAuthority = selectedParticipant?.operatorAuthority ?? caller?.operatorAuthority;
    selection = Object.freeze({
      operatorAuthority,
      requesterOrigin: selectedParticipant?.requesterOrigin
        ? captureRequesterOrigin({
            requesterOrigin: {
              ...selectedParticipant.requesterOrigin,
              delegatedCreatorProfileId: requesterCreatorProfileId(caller?.requesterOrigin) ?? null,
            },
          })
        : selectedParticipant
          ? undefined
          : caller?.requesterOrigin,
      assertCurrent: composeSessionSourceAssertion([
        participant?.assertCurrent,
        operatorAuthority?.assertCurrent,
      ]),
    });
    if (caller?.personalToolIdentityScoped) {
      caller.personalToolSelection = selection;
    }
  }
  if (
    options?.requireRequesterOrigin &&
    selection.operatorAuthority &&
    selection.operatorAuthority.profileId !== caller?.operatorAuthority?.profileId &&
    selection.requesterOrigin?.operatorProfileId !== selection.operatorAuthority.profileId
  ) {
    throw new Error("Selected user's requester identity is unavailable; ask them in a new turn.");
  }
  return selection;
}

/** The accepting collector already holds this source independently of the spawning turn. */
export function withGatewayToolOperatorContinuation<T>(
  selection: Pick<GatewayToolOperatorSelection, "operatorAuthority" | "requesterOrigin">,
  run: () => T,
): T {
  const caller = getGatewayToolCallerIdentity();
  if (!caller) {
    return run();
  }
  const { operatorAuthority, requesterOrigin } = selection;
  operatorAuthority?.assertCurrent();
  return runWithAsyncStore(
    gatewayToolCallerStorage,
    {
      ...caller,
      personalToolParticipants: undefined,
      personalToolUser: undefined,
      personalToolIdentityScoped: true,
      personalToolSelection: Object.freeze({
        operatorAuthority,
        requesterOrigin,
        assertCurrent: composeSessionSourceAssertion([operatorAuthority?.assertCurrent]),
      }),
    },
    run,
  );
}

export function resolveGatewayPersonalToolParticipant(
  runtimeIdentity?: AgentRuntimeIdentity,
  options?: { requireSingleParticipant?: boolean },
) {
  const caller = getGatewayToolCallerIdentity();
  if (caller?.personalToolParticipants) {
    return caller.personalToolParticipants.resolve(
      options?.requireSingleParticipant ? undefined : caller.personalToolUser,
    );
  }
  if (caller?.personalToolUser !== undefined) {
    throw new Error("Selecting user requires an active personal-tool turn.");
  }
  if (runtimeIdentity) {
    const registered = captureActiveEmbeddedRunPersonalToolParticipants(runtimeIdentity);
    if (!registered) {
      return undefined;
    }
    const participant = registered.participants?.resolve();
    return (
      participant && {
        ...participant,
        assertCurrent: composeSessionSourceAssertion([
          registered.assertCurrent,
          participant.assertCurrent,
        ]),
      }
    );
  }
  return undefined;
}

/** Capture the admitted run and worker owner, independently of optional audit collection. */
export function captureGatewayToolCallerAssertion(
  boundMethod?: string,
): ((method?: string) => void) | undefined {
  const caller = getGatewayToolCallerIdentity();
  if (!caller?.operationalRunInstance) {
    return undefined;
  }
  const isCurrent = caller.receiptAuthority;
  const signals = caller.approvalSignals ?? [];
  const selection = caller.personalToolIdentityScoped
    ? resolveGatewayToolOperatorSelection()
    : undefined;
  const assertMethod = (method?: string) => {
    if (method?.startsWith("cron.") && caller.cronAuthorityCheck?.() === false) {
      throw new Error("Automation caller authority is no longer active.");
    }
  };
  const assertCurrent = composeSessionSourceAssertion(
    [
      selection?.assertCurrent,
      // Selection already checks its exact operator source in this synchronous guard.
      selection?.operatorAuthority === caller.operatorAuthority
        ? undefined
        : caller.operatorAuthority?.assertCurrent,
      composeSessionSourceAssertion(
        isCurrent ? [captureGatewayToolReceiptAssertion(isCurrent)] : [],
        (assertReceipt) => {
          try {
            if (!isCurrent || signals.some((signal) => signal.aborted)) {
              throw new Error("agent tool caller authority is no longer active");
            }
            assertReceipt();
          } catch {
            throw new Error("agent tool caller authority is no longer active");
          }
        },
      ),
    ],
    (assertSources) => {
      assertSources();
      assertMethod(boundMethod);
    },
  );
  return Object.assign((method = boundMethod) => {
    assertCurrent();
    if (method !== boundMethod) {
      assertMethod(method);
    }
  }, assertCurrent);
}

/** Watch admission preserves opaque lifecycle assertions while moving registered row predicates. */
export async function prepareGatewayToolCallerAssertion(): Promise<{
  assertCurrent?: () => void;
  sessionEntriesCurrent?: SessionEntriesCurrentCheck;
  release(): void;
}> {
  const caller = getGatewayToolCallerIdentity();
  const assertion = captureGatewayToolCallerAssertion();
  const admissions = [...new Set(caller?.receiptAdmissions ?? [])];
  const prepared = await Promise.all(admissions.map((admission) => admission.prepare()));
  const predicates = new Map(
    admissions.map((admission, index) => [admission, () => prepared[index]!.isCurrent()] as const),
  );
  let active = true;
  const assertCurrent = () => {
    if (!active) {
      throw new Error("agent tool caller admission is no longer active");
    }
    runWithAsyncStore(receiptAdmissionStorage, predicates, () => assertion?.());
  };
  assertCurrent();
  return {
    assertCurrent,
    ...(prepared.length
      ? {
          sessionEntriesCurrent: {
            sources: prepared.flatMap((entry) => entry.current.sources),
            assertCurrent(entries) {
              let offset = 0;
              for (const entry of prepared) {
                entry.current.assertCurrent(
                  entries.slice(offset, offset + entry.current.sources.length),
                );
                offset += entry.current.sources.length;
              }
              assertCurrent();
            },
          },
        }
      : {}),
    release() {
      active = false;
      predicates.clear();
    },
  };
}

/** Process-owned work must not retain the turn that authorized its launch. */
export function withoutGatewayToolCallerIdentity<T>(run: () => T): T {
  return gatewayToolCallerStorage.exit(run);
}

export async function withGatewayToolCallerIdentity<T>(
  identity: GatewayToolCallerIdentity | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  if (!identity?.agentId?.trim() || !identity.sessionKey?.trim()) {
    return await run();
  }
  const inherited = gatewayToolCallerStorage.getStore();
  const suppliedRun = identity.operationalRunInstance;
  const inheritedRun = inherited?.operationalRunInstance;
  // Wrappers without a run inherit the admitted owner. A distinct admitted run
  // starts a new root; retaining the outer run would let child work outlive its owner.
  const inheritedOwner = !suppliedRun || inheritedRun === suppliedRun ? inherited : undefined;
  const inheritedValue = <K extends keyof GatewayToolCallerIdentity>(key: K) =>
    inheritedOwner?.[key] ?? identity[key];
  let approvalAuthority = inheritedOwner?.approvalAuthority ?? identity.approvalAuthority;
  if (
    inheritedOwner?.approvalAuthority &&
    identity.approvalAuthority &&
    inheritedOwner.approvalAuthority !== identity.approvalAuthority
  ) {
    if (
      validateAgentRunDelegatedAuthority(
        identity.approvalAuthority,
        inheritedOwner.approvalAuthority,
      )
    ) {
      approvalAuthority = identity.approvalAuthority;
    } else if (
      !validateAgentRunDelegatedAuthority(
        inheritedOwner.approvalAuthority,
        identity.approvalAuthority,
      )
    ) {
      throw new Error("agent tool caller approval scopes do not retain the same source");
    }
  }
  const receiptAdmissions = [
    ...new Set([
      ...(inheritedOwner?.receiptAdmissions ?? []),
      ...(identity.receiptAdmissions ?? []),
    ]),
  ];
  const toolPolicyAssertions = [
    ...new Set(
      [inheritedOwner?.assertToolAllowed, identity.assertToolAllowed].filter(
        (assertion): assertion is (toolName: string) => void => assertion !== undefined,
      ),
    ),
  ];
  const assertToolAllowed = toolPolicyAssertions.length
    ? (toolName: string) => {
        for (const assertion of toolPolicyAssertions) {
          assertion(toolName);
        }
      }
    : undefined;
  const approvalSignals = [
    ...new Set([...(inheritedOwner?.approvalSignals ?? []), ...(identity.approvalSignals ?? [])]),
  ];
  return await runWithAsyncStore(
    gatewayToolCallerStorage,
    {
      agentId: inheritedOwner?.agentId ?? identity.agentId.trim(),
      sessionKey: inheritedOwner?.sessionKey ?? identity.sessionKey.trim(),
      approvalOrigin: identity.approvalOwnerPluginId
        ? identity.approvalOrigin
        : inheritedOwner?.approvalOrigin,
      approvalConversation: identity.approvalOwnerPluginId
        ? identity.approvalConversation
        : inheritedOwner?.approvalConversation,
      watchdogAttempt: identity.watchdogAttempt ?? inheritedOwner?.watchdogAttempt,
      requesterOrigin: inheritedOwner?.requesterOrigin ?? identity.requesterOrigin,
      sessionEventDelivery:
        inheritedOwner?.sessionEventDelivery === false || identity.sessionEventDelivery === false
          ? false
          : undefined,
      sessionEventSettings:
        identity.sessionEventSettings && inheritedOwner?.sessionEventSettings
          ? narrowSessionEventSettings(
              inheritedOwner.sessionEventSettings,
              identity.sessionEventSettings,
            )
          : (identity.sessionEventSettings ?? inheritedOwner?.sessionEventSettings),
      ...inheritSessionEventToolPolicy(identity, inheritedOwner),
      workspaceBaseRefreshSandbox: inheritedValue("workspaceBaseRefreshSandbox"),
      workspacePrAdoptionSessionId: inheritedValue("workspacePrAdoptionSessionId"),
      workspacePublicationRunId: inheritedValue("workspacePublicationRunId"),
      workspacePublicationPolicy: inheritedValue("workspacePublicationPolicy"),
      workspaceEvidenceSandbox: inheritedValue("workspaceEvidenceSandbox"),
      personalToolParticipants: inheritedValue("personalToolParticipants"),
      personalToolUser: inheritedValue("personalToolUser"),
      personalToolIdentityScoped: inheritedValue("personalToolIdentityScoped"),
      personalToolSelection: inheritedValue("personalToolSelection"),
      // Same-run wrappers can narrow a prepared posture, never erase a restriction.
      fullPermission:
        inheritedOwner?.fullPermission === false || identity.fullPermission === false
          ? false
          : inheritedValue("fullPermission"),
      assertAutoApproveChangesCurrent:
        inheritedOwner?.assertAutoApproveChangesCurrent || identity.assertAutoApproveChangesCurrent
          ? () => {
              inheritedOwner?.assertAutoApproveChangesCurrent?.();
              identity.assertAutoApproveChangesCurrent?.();
            }
          : undefined,
      operationalRunInstance: inheritedValue("operationalRunInstance"),
      embeddedRunToolAuthorityBinding:
        identity.embeddedRunToolAuthorityBinding ?? inheritedOwner?.embeddedRunToolAuthorityBinding,
      approvalAuthority,
      operatorAuthority: inheritedValue("operatorAuthority"),
      approvalAuthorityCheck: inheritedValue("approvalAuthorityCheck"),
      approvalOwnerPluginId:
        identity.approvalOwnerPluginId?.trim() ||
        inheritedOwner?.approvalOwnerPluginId ||
        undefined,
      signedAgentRuntimeIdentityToken:
        (inheritedOwner?.signedAgentRuntimeIdentityToken ??
          identity.signedAgentRuntimeIdentityToken?.trim()) ||
        undefined,
      cronSelfManagementJobId:
        (identity.cronSelfManagementJobId?.trim() ?? inheritedOwner?.cronSelfManagementJobId) ||
        undefined,
      cronToolsAllowCapture:
        identity.cronToolsAllowCapture ?? inheritedOwner?.cronToolsAllowCapture,
      cronExecToolTarget: identity.cronExecToolTarget ?? inheritedOwner?.cronExecToolTarget,
      cronCreatorAuthorityGrant:
        identity.cronCreatorAuthorityGrant ?? inheritedOwner?.cronCreatorAuthorityGrant,
      mintCronRequesterGrant: inheritedValue("mintCronRequesterGrant"),
      cronManagementGrant: identity.cronManagementGrant ?? inheritedOwner?.cronManagementGrant,
      cronAuthorityCheck: composeReceiptAuthority(
        inheritedOwner?.cronAuthorityCheck,
        identity.cronAuthorityCheck,
      ),
      executionIdentityToken: inheritedValue("executionIdentityToken"),
      receiptAuthority: composeReceiptAuthority(
        inheritedOwner?.receiptAuthority,
        identity.receiptAuthority,
      ),
      receiptAdmissions: receiptAdmissions.length ? receiptAdmissions : undefined,
      assertToolAllowed,
      approvalSignals: approvalSignals.length ? approvalSignals : undefined,
      workerTurnClaim: inheritedValue("workerTurnClaim"),
      workerTurnExecutionIdentityCapability: inheritedValue(
        "workerTurnExecutionIdentityCapability",
      ),
      gatewayContextResolver:
        inheritedOwner?.gatewayContextResolver ??
        captureGatewayContextResolver(identity.gatewayContextResolver),
      gatewayUiCommandTarget: inheritedValue("gatewayUiCommandTarget"),
      turnSourceChannel:
        (inheritedOwner?.turnSourceChannel ?? identity.turnSourceChannel?.trim()) || undefined,
      turnSourceLocal: inheritedValue("turnSourceLocal"),
      turnSourceTo: (inheritedOwner?.turnSourceTo ?? identity.turnSourceTo?.trim()) || undefined,
      turnSourceAccountId:
        (inheritedOwner?.turnSourceAccountId ?? identity.turnSourceAccountId?.trim()) || undefined,
      turnSourceThreadId: inheritedValue("turnSourceThreadId"),
    },
    run,
  );
}

/** Narrows one host-owned approval call to the exact registered policy/harness owner. */
export async function withGatewayToolApprovalOwner<T>(
  pluginId: string | undefined,
  run: () => Promise<T> | T,
  approvalConversation?: BusinessApprovalConversation,
): Promise<T> {
  const identity = gatewayToolCallerStorage.getStore();
  const approvalOwnerPluginId = pluginId?.trim();
  if (!identity || !approvalOwnerPluginId) {
    return await run();
  }
  return await withGatewayToolCallerIdentity(
    {
      ...identity,
      approvalOwnerPluginId,
      approvalOrigin: approvalConversation ? "plugin" : undefined,
      approvalConversation,
    },
    run,
  );
}

export function wrapToolWithGatewayCallerIdentity(
  tool: AnyAgentTool,
  identity: GatewayToolCallerIdentity | undefined,
): AnyAgentTool {
  if (!identity?.agentId?.trim() || !identity.sessionKey?.trim() || !tool.execute) {
    return tool;
  }
  return wrapAgentToolExecutionContext(
    tool,
    (...args) => withGatewayToolCallerIdentity(identity, () => tool.execute?.(...args)),
    (operation) => withGatewayToolCallerIdentity(identity, operation),
    (source) => wrapToolWithGatewayCallerIdentity(source, identity),
  );
}

export function createGatewayToolCallerWrapper(
  agentId: string | undefined,
  source: GatewayToolCallerSource | undefined,
): (tool: AnyAgentTool) => AnyAgentTool {
  const identity =
    agentId && source?.agentSessionKey?.trim()
      ? {
          agentId,
          sessionKey: source.agentSessionKey.trim(),
          gatewayUiCommandTarget: source.gatewayUiCommandTarget,
          turnSourceChannel: source.agentChannel,
          turnSourceTo: source.currentMessagingTarget ?? source.currentChannelId ?? source.agentTo,
          turnSourceAccountId: source.agentAccountId,
          turnSourceThreadId: source.currentThreadTs ?? source.agentThreadId,
        }
      : undefined;
  return (tool) => wrapToolWithGatewayCallerIdentity(tool, identity);
}

/** Opt an identity-scoped tool into participant selection, including unnamed calls. */
export function wrapGatewayPersonalToolExecution(
  execute: AnyAgentTool["execute"],
): AnyAgentTool["execute"] {
  return async (...args) =>
    await withGatewayPersonalToolUser(
      readToolStringParam(asNonArrayRecord(args[1]) ?? {}, "user"),
      async () => {
        const caller = getGatewayToolCallerIdentity();
        const selection = resolveGatewayToolOperatorSelection();
        selection.assertCurrent();
        const result = await execute(...args);
        // Existing no-registry tools own their handled failure and cleanup receipts.
        if (caller?.personalToolParticipants) {
          selection.assertCurrent();
        }
        return result;
      },
    );
}

export { type GatewayToolOperatorSelection } from "./gateway-caller-identity.types.js";
