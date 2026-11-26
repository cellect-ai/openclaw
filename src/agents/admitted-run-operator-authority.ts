import type { ProviderModelRef as ModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { CyberAccessProgram } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import { isGatewayOperatorAccessUnavailable } from "../gateway/operator-access-errors.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import type { AdmittedRunOperatorAuthority } from "./admitted-run-operator-authority.types.js";
import { isOperatorAccessProgramAllowed } from "./operator-access-program.js";

type OperatorModelSelection = ModelRef & { cyberAccessProgram?: CyberAccessProgram };

// Source and bundled module instances must recognize the same host-issued object.
const operatorAuthorityIssuers = resolveGlobalSingleton(
  Symbol.for("openclaw.admittedRunOperatorAuthority.issuers"),
  () => new WeakSet<object>(),
);

/** Host-only construction; public reply options cannot manufacture a source capability. */
export function createAdmittedRunOperatorAuthority(
  source: AdmittedRunOperatorAuthority,
): AdmittedRunOperatorAuthority {
  const check = source.assertCurrent;
  const signal = source.signal;
  let revoked = false;
  let revocationReason: unknown;
  const assertCurrent = composeSessionSourceAssertion([check], (assertSource) => {
    if (revoked) {
      throw revocationReason;
    }
    try {
      signal?.throwIfAborted();
      assertSource();
    } catch (error) {
      if (!isGatewayOperatorAccessUnavailable(error)) {
        revoked = true;
        revocationReason = error;
      }
      throw error;
    }
  });
  const readRoleFacts = source.readCurrentRoleFacts;
  const authority = Object.freeze({
    profileId: source.profileId,
    recoverySnapshot: source.recoverySnapshot
      ? freezeJsonSnapshot(structuredClone(source.recoverySnapshot))
      : undefined,
    channelRecoverySource: source.channelRecoverySource
      ? Object.freeze({
          reference: Object.freeze({ ...source.channelRecoverySource.reference }),
          modelPolicy: source.channelRecoverySource.modelPolicy,
        })
      : undefined,
    scopes: Object.freeze([...source.scopes]),
    gatewayAccessGrant: source.gatewayAccessGrant
      ? Object.freeze({ ...source.gatewayAccessGrant })
      : source.gatewayAccessGrant,
    source: source.source ?? {},
    signal,
    retain: source.retain,
    onModelPolicyChanged: source.onModelPolicyChanged,
    get modelPolicy() {
      return source.modelPolicy;
    },
    assertCurrent,
    readCurrentRoleFacts: readRoleFacts
      ? () => {
          assertCurrent();
          return readRoleFacts();
        }
      : undefined,
    rolePolicy: source.rolePolicy
      ? Object.freeze({
          ...source.rolePolicy,
          ...(source.rolePolicy.accessPrograms
            ? {
                accessPrograms: Object.freeze({
                  cyber: Object.freeze(
                    [...new Set(source.rolePolicy.accessPrograms.cyber)].toSorted(),
                  ),
                }),
              }
            : {}),
          agents:
            source.rolePolicy.agents === "*"
              ? "*"
              : Object.freeze([...new Set(source.rolePolicy.agents)].toSorted()),
        })
      : undefined,
  });
  operatorAuthorityIssuers.add(authority);
  return authority;
}

export function assertAdmittedRunOperatorAuthority(
  authority: unknown,
): asserts authority is AdmittedRunOperatorAuthority {
  if (!authority || typeof authority !== "object" || !operatorAuthorityIssuers.has(authority)) {
    throw new Error("operator run authority must be issued by the host");
  }
}

/** Selection never grants authority; callers must pass the original host-issued source. */
export function assertOperatorModelAllowed(
  authority: AdmittedRunOperatorAuthority | undefined,
  model: OperatorModelSelection | undefined,
): void {
  createOperatorModelSelectionAssertion(authority, model)();
}

/** Carry the operator's source checks into writes without rereading its store on the host. */
export function createOperatorModelSelectionAssertion(
  authority: AdmittedRunOperatorAuthority | undefined,
  model: OperatorModelSelection | undefined,
): SessionSourceAssertion {
  return composeSessionSourceAssertion([authority?.assertCurrent], (assertSource) => {
    if (!authority) {
      return;
    }
    assertAdmittedRunOperatorAuthority(authority);
    assertSource();
    const policy = authority.modelPolicy;
    if (policy && (!model || !policy.allows(model))) {
      throw new Error(
        "Your operator role cannot use this model. Choose an allowed model or ask a gateway administrator to update your role's model policy.",
      );
    }
    assertOperatorAccessProgramAllowed(authority, model?.cyberAccessProgram);
  });
}

/** Clearing a stale Access selection must not require permission to its old model. */
export function assertOperatorAccessProgramAllowed(
  authority: AdmittedRunOperatorAuthority | undefined,
  program: CyberAccessProgram | undefined,
): void {
  if (!authority) {
    return;
  }
  assertAdmittedRunOperatorAuthority(authority);
  authority.assertCurrent();
  if (!isOperatorAccessProgramAllowed(authority, program)) {
    throw new Error(
      "Your operator role cannot use this Access level. Choose Standard or ask a gateway administrator to grant this Access level to your role.",
    );
  }
}

/** Keeps one selected model current without revoking other work from the same source. */
export function bindOperatorModelExecution(
  authority: AdmittedRunOperatorAuthority | undefined,
  model: OperatorModelSelection | undefined,
  mapAuthorizationError?: (error: unknown) => Error,
): Readonly<{ signal: AbortSignal; assertCurrent: () => void; release: () => void }> | undefined {
  if (!authority) {
    return undefined;
  }
  const selected = model ? { ...model } : undefined;
  const assertModelAllowed = createOperatorModelSelectionAssertion(authority, selected);
  const mapError = (error: unknown) => mapAuthorizationError?.(error) ?? error;
  let releaseAuthority: (() => void) | undefined;
  try {
    assertModelAllowed();
    releaseAuthority = authority.retain?.();
  } catch (error) {
    throw mapError(error);
  }
  const revoked = new AbortController();
  let released = false;
  const assertCurrent = () => {
    if (released) {
      throw mapError(new Error("operator model execution authority is no longer active"));
    }
    revoked.signal.throwIfAborted();
    try {
      assertModelAllowed();
    } catch (error) {
      const failure = mapError(error);
      revoked.abort(failure);
      throw failure;
    }
  };
  const recheck = () => {
    try {
      assertCurrent();
    } catch {
      // The latched signal owns cancellation; notification must reach other executions.
    }
  };
  const onSourceAbort = () => revoked.abort(mapError(authority.signal?.reason));
  authority.signal?.addEventListener("abort", onSourceAbort, { once: true });
  const unsubscribe = authority.onModelPolicyChanged?.(recheck);
  recheck();
  return {
    signal: revoked.signal,
    assertCurrent,
    release: () => {
      if (!released) {
        released = true;
        unsubscribe?.();
        authority.signal?.removeEventListener("abort", onSourceAbort);
        releaseAuthority?.();
      }
    },
  };
}
