import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import { publishAdminActionCard } from "./admin-action-card.js";
import { approvedRoomFiling, executeApprovedRoomFiling } from "./admin-action-filing.js";
import {
  loadAdminAction,
  transitionAdminAction,
  RECORD_TTL_MS,
  type AdminActionRecord,
} from "./admin-action.js";
import {
  brokerToken,
  configFromRuntime,
  matrixConnection,
  lookupDelegation,
  FI_ADMIN_DELEGATION_AGENT_ID,
} from "./fi-delegation.js";

export type AdminActionTarget = {
  tenantOrgId: string;
  requestId: string;
  revision: number;
  roomId: string;
  threadRootEventId: string;
  agentMxid: string;
  requesterMatrixUserId: string;
};
type Decision = "approve" | "hold" | "decline" | "resume";

function targetFromParams(params: Record<string, unknown>): AdminActionTarget {
  const keys = [
    "tenantOrgId",
    "requestId",
    "roomId",
    "threadRootEventId",
    "agentMxid",
    "requesterMatrixUserId",
  ] as const;
  for (const key of keys) {
    if (typeof params[key] !== "string" || !params[key] || (params[key] as string).length > 512) {
      throw new Error("Invalid approval target.");
    }
  }
  if (
    !Number.isSafeInteger(params.revision) ||
    Number(params.revision) < 1 ||
    !/^[A-Z0-9]{6}$/.test(String(params.requestId)) ||
    !/^@[^\s:]+:[^\s]+$/.test(String(params.requesterMatrixUserId))
  ) {
    throw new Error("Invalid approval revision or identity.");
  }
  return {
    tenantOrgId: String(params.tenantOrgId),
    requestId: String(params.requestId),
    revision: Number(params.revision),
    roomId: String(params.roomId),
    threadRootEventId: String(params.threadRootEventId),
    agentMxid: String(params.agentMxid),
    requesterMatrixUserId: String(params.requesterMatrixUserId),
  };
}

function matches(record: AdminActionRecord, target: AdminActionTarget) {
  return (
    record.id === target.requestId &&
    record.origin?.orgId === target.tenantOrgId &&
    record.origin.roomId === target.roomId &&
    record.origin.threadRootEventId === target.threadRootEventId &&
    record.origin.agentMxid === target.agentMxid
  );
}

export function adminActionView(record: AdminActionRecord) {
  return {
    id: record.id,
    revision: record.revision ?? 1,
    origin: record.origin,
    state:
      ["pending", "held"].includes(record.status) && record.createdAt + RECORD_TTL_MS <= Date.now()
        ? "expired"
        : (record.execution?.state ?? (record.status === "failed" ? "unknown" : record.status)),
  };
}

/** Only the exact authenticated Fi server device may carry its session reviewer. */
async function authorize(
  api: OpenClawPluginApi,
  options: GatewayRequestHandlerOptions,
  record: AdminActionRecord,
  target: AdminActionTarget,
) {
  const gatewayDeviceId = options.client?.connect.device?.id;
  const assertCurrent = () => {
    if (!gatewayDeviceId || !options.hasCurrentClientAuthority?.() || options.signal?.aborted) {
      throw new Error("The authenticated approval connection is no longer current.");
    }
  };
  assertCurrent();
  const base = configFromRuntime(api);
  const connection = matrixConnection(base, record.delivery?.accountId);
  if (!connection || base.tenantOrgConflict || base.tenantOrgId !== target.tenantOrgId) {
    throw new Error("Approval environment or tenant mismatch.");
  }
  const config = { ...base, ...connection };
  const token = brokerToken(config);
  if (!token) {
    throw new Error("Approval verifier unavailable.");
  }
  const response = await fetch(
    `${config.baseUrl.replace(/\/+$/, "")}/api/threads/admin-action-authorize`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...target, gatewayDeviceId }),
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    throw new Error("The current Fi administrator and conversation could not be verified.");
  }
  const result = (await response.json()) as {
    ok?: boolean;
    orgId?: string;
    matrixUserId?: string;
    role?: string;
    email?: string;
  };
  assertCurrent();
  if (
    result.ok !== true ||
    result.orgId !== target.tenantOrgId ||
    result.matrixUserId !== target.requesterMatrixUserId ||
    !["admin", "owner"].includes(result.role ?? "")
  ) {
    throw new Error("Only a current administrator of this organization may decide this request.");
  }
  return { assertCurrent, config, email: result.email };
}

export function registerAdminActionRpc(api: OpenClawPluginApi) {
  for (const method of ["describe", "decide"] as const) {
    api.registerGatewayMethod(
      `fi.adminAction.${method}`,
      async (options) => {
        try {
          const target = targetFromParams(options.params);
          const record = await loadAdminAction(api, target.requestId);
          if (!record || !record.publicationEventId || !matches(record, target)) {
            throw new Error("Approval request is unavailable in this conversation.");
          }
          const { assertCurrent, config, email } = await authorize(api, options, record, target);
          if (method === "describe") {
            const current = await loadAdminAction(api, target.requestId);
            assertCurrent();
            if (!current || !matches(current, target)) {
              throw new Error("Approval request changed.");
            }
            options.respond(true, adminActionView(current));
            return;
          }
          const decision = options.params.decision as Decision;
          if (!["approve", "hold", "decline", "resume"].includes(decision)) {
            throw new Error("Invalid decision.");
          }
          if (
            target.revision !== (record.revision ?? 1) ||
            record.createdAt + RECORD_TTL_MS <= Date.now()
          ) {
            throw new Error("This approval card changed or expired. Refresh the conversation.");
          }
          const allowed =
            record.status === "pending"
              ? ["approve", "hold", "decline"]
              : record.status === "held"
                ? ["resume", "decline"]
                : [];
          if (!allowed.includes(decision)) {
            options.respond(true, { ...adminActionView(record), applied: false });
            return;
          }
          const filing =
            decision === "approve" && email ? approvedRoomFiling(record, email) : undefined;
          const delegation = filing
            ? await lookupDelegation(
                config,
                { requesterMatrixUserId: target.requesterMatrixUserId },
                { agentId: FI_ADMIN_DELEGATION_AGENT_ID, signal: options.signal },
              )
            : undefined;
          if (filing) {
            if (
              !delegation ||
              !["admin", "owner"].includes(delegation.user.role) ||
              delegation.user.email !== email
            ) {
              throw new Error("The approver's current administrator delegation is unavailable.");
            }
            // Refresh tenant membership and the exact session/device binding after
            // awaiting delegation, before admitting a durable decision or effect.
            await authorize(api, options, record, target);
          }
          let next: AdminActionRecord = {
            ...record,
            revision: (record.revision ?? 1) + 1,
            status:
              decision === "hold"
                ? "held"
                : decision === "resume"
                  ? "pending"
                  : decision === "decline"
                    ? "denied"
                    : "approved",
            ...(decision === "approve" || decision === "decline"
              ? { decidedBy: target.requesterMatrixUserId }
              : {}),
            ...(decision === "approve"
              ? {
                  execution: {
                    state: filing ? ("unknown" as const) : ("not_executed" as const),
                    operationId: `fi-admin-action-${record.id}`,
                    message: filing
                      ? "Approval recorded. Filing has not yet been authoritatively verified."
                      : "Approval recorded. Not executed: this request requires a supported exact-target operation in Fi.",
                  },
                }
              : {}),
          };
          if (!(await transitionAdminAction(api, record, next, assertCurrent))) {
            throw new Error("Another decision changed this request. Refresh the conversation.");
          }
          if (filing && delegation) {
            const execution = await executeApprovedRoomFiling(
              config,
              delegation,
              filing,
              `fi-admin-action-${record.id}`,
              assertCurrent,
              {
                expectedRoomVersion: record.preparedFiling!.expectedRoomVersion,
                sourceSha256: record.preparedFiling!.sourceSha256,
                sourceUpdatedAt: record.preparedFiling!.sourceUpdatedAt,
              },
            );
            const completed = { ...next, execution };
            // If receipt persistence becomes uncertain, the committed owner stays
            // unknown. Neither a repeat decision nor restart repeats the effect.
            try {
              if (await transitionAdminAction(api, next, completed, assertCurrent)) {
                next = completed;
              }
            } catch {
              api.logger.warn(
                "fi-user: filing receipt could not be recorded; outcome remains unconfirmed",
              );
            }
          }
          // The durable decision wins even if publication fails. Retrying an old
          // card cannot repeat a business effect or reset the original expiry.
          try {
            await publishAdminActionCard(api, next, assertCurrent);
          } catch {
            api.logger.warn("fi-user: approval committed; card publication unavailable");
          }
          options.respond(true, { ...adminActionView(next), applied: true });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Approval unavailable; nothing was executed.";
          options.respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
        }
      },
      { scope: "operator.approvals" },
    );
  }
}
