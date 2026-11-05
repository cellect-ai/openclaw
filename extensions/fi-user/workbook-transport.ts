import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import type { registerAdminDelegation } from "./admin-delegation.js";
import {
  brokerToken,
  configFromRuntime,
  FI_ADMIN_DELEGATION_AGENT_ID,
  FI_USER_AGENT_ID,
  lookupDelegation,
  matrixConnection,
  pluginConfig,
  requesterIdentity,
} from "./fi-delegation.js";
import type { MatrixEntitlements } from "./matrix-entitlements.js";

export type WorkbookTransport = {
  signal?: AbortSignal;
  assertCurrent(): void;
  authorize(
    signal: AbortSignal,
  ): Promise<{ url: string; token: string; orgId: string; proof?: object }>;
};
type WorkbookTurn = NonNullable<ReturnType<MatrixEntitlements["workbookTurn"]>>;

export function matrixWorkbookTransport(
  api: OpenClawPluginApi,
  turn: WorkbookTurn,
): WorkbookTransport {
  return {
    signal: turn.signal,
    assertCurrent: turn.assertCurrent,
    async authorize(signal) {
      turn.assertCurrent();
      signal.throwIfAborted();
      const connection = matrixConnection(configFromRuntime(api), turn.accountId);
      const token = connection && brokerToken(connection);
      if (!connection || !token) {
        throw new Error("Workbook requester scope unavailable");
      }
      const {
        agentId,
        roomId,
        eventId,
        threadRootEventId,
        senderMxid,
        accountId,
        runId,
        sessionKey,
      } = turn;
      return {
        url: `${connection.baseUrl}/api/threads/workbook`,
        token,
        orgId: turn.orgId,
        proof: {
          agentId,
          roomId,
          eventId,
          threadRootEventId,
          senderMxid,
          accountId,
          runId,
          sessionKey,
        },
      };
    },
  };
}

/** Reuse the requester owner used by native Fi tools and artifact filing. The
 * short-lived token stays in this call; no shell credential or new actor proof. */
export function delegatedWorkbookTransport(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext<2>,
  adminRequester: ReturnType<typeof registerAdminDelegation>["provenToolRequester"],
): WorkbookTransport | undefined {
  // Native Matrix text uses its event-admission owner above. A missing native
  // proof must never become a less-specific member delegation.
  if (context.messageChannel === "matrix") {
    return undefined;
  }
  const capture = () => {
    if (context.agentId === FI_USER_AGENT_ID) {
      const identity = requesterIdentity(context);
      if (!identity) {
        return undefined;
      }
      const { channel: _channel, ...body } = identity;
      return { connection: pluginConfig(api, context), body, agentId: FI_USER_AGENT_ID } as const;
    }
    const proven = adminRequester(context);
    return proven ? ({ ...proven, agentId: FI_ADMIN_DELEGATION_AGENT_ID } as const) : undefined;
  };
  const initial = capture();
  if (!initial?.connection.tenantOrgId || initial.connection.tenantOrgConflict) {
    return undefined;
  }
  const assertCurrent = () => {
    context.assertInvocationCurrent();
    const current = capture();
    if (
      !current ||
      current.agentId !== initial.agentId ||
      current.connection.tenantOrgId !== initial.connection.tenantOrgId ||
      current.connection.tenantOrgConflict ||
      current.connection.baseUrl !== initial.connection.baseUrl ||
      current.connection.brokerTokenEnv !== initial.connection.brokerTokenEnv ||
      JSON.stringify(current.body) !== JSON.stringify(initial.body)
    ) {
      throw new Error("Workbook requester scope unavailable");
    }
  };
  return {
    assertCurrent,
    async authorize(signal) {
      assertCurrent();
      signal.throwIfAborted();
      const delegation = await lookupDelegation(initial.connection, initial.body, {
        agentId: initial.agentId,
        signal,
      });
      assertCurrent();
      signal.throwIfAborted();
      if (!delegation?.user.orgId || !delegation.fi?.token) {
        throw new Error("Workbook requester scope unavailable");
      }
      return {
        url: `${initial.connection.baseUrl}/api/${encodeURIComponent(delegation.user.orgSlug)}/workbook`,
        token: delegation.fi.token,
        orgId: delegation.user.orgId,
      };
    },
  };
}
