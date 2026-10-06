import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginHookToolContext } from "openclaw/plugin-sdk/types";
import { adminActionSessions } from "./admin-action.js";
import {
  configFromRuntime,
  FI_ADMIN_DELEGATION_AGENT_ID,
  lookupDelegation,
  matrixConnection,
  type ResolvedPluginConfig,
} from "./fi-delegation.js";
import { ON_BEHALF_OF_TOOLS, onBehalfOfRequester } from "./on-behalf-of.js";

/** Shorter than the tool-hook deadline, and leaves room for the Matrix grant check before it. */
const MINT_TIMEOUT_MS = 8_000;
/** A token this close to expiry is not handed to a command. */
const MIN_REMAINING_SECONDS = 60;
/** A queued message waits no longer than the run ahead of it; older arrivals start nothing. */
const INBOUND_TTL_MS = 30 * 60 * 1000;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const UNPROVEN = "unproven";

type Run = { agentId: string; sessionKey: string; sender: string };

/**
 * The requester's own Fi token for one admin-agent shell command.
 *
 * Fi mints it for the person the host proved sent the message that started
 * this turn, and it reaches only the commands Fi lists for the admin agent. It
 * is asked for per call and returned to the caller for that call's `env`:
 * nothing here keeps a token, and a failure of any kind yields none.
 *
 * A tool call names its requester but not what started its run, and the host
 * reuses a stored sender when it resumes a run. So a turn is admitted only by
 * what arrived for it: the messages dispatched to the session since its last
 * run must all come from one channel-proven sender, the run must be a user
 * turn by that same sender, and nobody else may write into the session while
 * it runs. Cron, heartbeat, webhook, sub-agent and inter-session runs bring no
 * such message; a batch from several people and a run another person steers
 * are refused. An approved admin action acts for the requester Fi recorded.
 */
export function registerAdminDelegation(api: OpenClawPluginApi) {
  const inbound = new Map<string, { senders: Set<string>; at: number }>();
  const runs = new Map<string, Run>();
  api.agent.events.registerAgentEventSubscription({
    id: "admin-delegation-turn-retirement",
    streams: ["lifecycle"],
    handle(event) {
      if (
        event.data.executionSettled === true &&
        (event.data.phase === "end" || event.data.phase === "error")
      ) {
        runs.delete(event.runId);
      }
    },
  });
  api.lifecycle.registerRuntimeLifecycle({
    id: "admin-delegation-turns",
    dispose: () => {
      inbound.clear();
      runs.clear();
    },
    cleanup: ({ runId, sessionKey }) => {
      if (runId) {
        runs.delete(runId);
      } else if (sessionKey) {
        inbound.delete(sessionKey);
        for (const [id, run] of runs) {
          if (run.sessionKey === sessionKey) {
            runs.delete(id);
          }
        }
      } else {
        inbound.clear();
        runs.clear();
      }
    },
  });
  api.on(
    "before_agent_reply",
    (_event, context) => {
      const { adminAgentId } = configFromRuntime(api);
      if (context.agentId !== adminAgentId || !context.sessionKey || !context.runId) {
        return undefined;
      }
      if (runs.has(context.runId)) {
        return undefined;
      }
      const arrived = inbound.get(context.sessionKey);
      inbound.delete(context.sessionKey);
      const requester = onBehalfOfRequester({
        channel: context.channel,
        senderId: context.senderId,
      });
      if (
        context.trigger === "user" &&
        requester &&
        arrived &&
        Date.now() - arrived.at <= INBOUND_TTL_MS &&
        arrived.senders.size === 1 &&
        arrived.senders.has(JSON.stringify(requester))
      ) {
        runs.set(context.runId, {
          agentId: adminAgentId,
          sessionKey: context.sessionKey,
          sender: JSON.stringify(requester),
        });
      }
      return undefined;
    },
    { priority: 10_000 },
  );

  /** Record a message the host is about to dispatch to an admin-agent session. */
  const noteInbound = (message: {
    channel?: string;
    senderId?: string;
    senderAuthentication?: "verified" | "asserted";
    sessionKey?: string;
  }): void => {
    const { adminAgentId } = configFromRuntime(api);
    const sessionKey = message.sessionKey;
    if (!sessionKey?.startsWith(`agent:${adminAgentId}:`)) {
      return;
    }
    // Slack says when it proved the sender itself. Matrix reports nothing: its
    // sender is the homeserver's, so only a sender someone else named is refused.
    const proven =
      message.channel === "slack"
        ? message.senderAuthentication === "verified"
        : message.channel === "matrix" && message.senderAuthentication !== "asserted";
    const requester = proven ? onBehalfOfRequester(message) : undefined;
    const sender = requester ? JSON.stringify(requester) : UNPROVEN;
    const arrived = inbound.get(sessionKey);
    const fresh = arrived && Date.now() - arrived.at <= INBOUND_TTL_MS;
    inbound.set(sessionKey, {
      senders: new Set([...(fresh ? arrived.senders : []), sender]),
      at: Date.now(),
    });
    for (const [id, run] of runs) {
      if (run.sessionKey === sessionKey && run.sender !== sender) {
        runs.delete(id);
      }
    }
  };

  /**
   * The token for this tool call, or nothing. Synchronous refusals stay
   * synchronous so a call that gets no token is not delayed by asking Fi.
   */
  const mint = (
    config: ResolvedPluginConfig,
    event: { toolName: string; toolKind?: string },
    ctx: PluginHookToolContext,
  ): Promise<{ token: string; appUrl: string } | undefined> | undefined => {
    if (
      !config.tenantOrgId ||
      ctx.agentId !== config.adminAgentId ||
      !ON_BEHALF_OF_TOOLS.has(event.toolName) ||
      event.toolKind ||
      ctx.toolKind
    ) {
      return undefined;
    }
    const adminAction = ctx.sessionKey ? adminActionSessions.get(ctx.sessionKey) : undefined;
    const run = !adminAction && ctx.runId ? runs.get(ctx.runId) : undefined;
    const requester = onBehalfOfRequester(ctx.requester, adminAction);
    if (!requester) {
      return undefined;
    }
    if (
      !adminAction &&
      (!run ||
        run.agentId !== ctx.agentId ||
        run.sessionKey !== ctx.sessionKey ||
        run.sender !== JSON.stringify(requester))
    ) {
      return undefined;
    }
    let body: Record<string, string>;
    let connection: Pick<ResolvedPluginConfig, "baseUrl" | "brokerTokenEnv"> | undefined;
    if ("requester_slack_user_id" in requester) {
      body = { requesterSenderId: requester.requester_slack_user_id };
      connection = config;
    } else if ("requester_matrix_user_id" in requester) {
      body = { requesterMatrixUserId: requester.requester_matrix_user_id };
      connection = matrixConnection(
        config,
        adminAction
          ? adminAction.delivery?.channel === "matrix"
            ? adminAction.delivery.accountId
            : undefined
          : ctx.requester?.accountId,
      );
    } else {
      // Fi does not exchange a webchat identity for the admin agent's token.
      return undefined;
    }
    if (!connection) {
      return undefined;
    }
    const appUrl = connection.baseUrl.replace(/\/+$/, "");
    const stillAdmitted = () =>
      !ctx.abortSignal?.aborted &&
      (adminAction
        ? adminActionSessions.get(ctx.sessionKey ?? "") === adminAction
        : runs.get(ctx.runId ?? "") === run);
    return lookupDelegation({ ...config, ...connection }, body, {
      agentId: FI_ADMIN_DELEGATION_AGENT_ID,
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    }).then(
      (delegation) => {
        const token: unknown = delegation?.fi?.token;
        const expiresAt: unknown = delegation?.fi?.expiresAt;
        if (
          typeof token !== "string" ||
          !JWT.test(token) ||
          typeof expiresAt !== "number" ||
          expiresAt - Date.now() / 1000 < MIN_REMAINING_SECONDS ||
          !stillAdmitted()
        ) {
          return undefined;
        }
        return { token, appUrl };
      },
      (error: unknown) => {
        // Status only: the failure may quote the request, which carries the credential.
        const status = /\((\d{3})\)$/.exec(error instanceof Error ? error.message : "")?.[1];
        api.logger.warn(
          `fi-user: admin delegation not issued (${status ? `status ${status}` : "unavailable"})`,
        );
        return undefined;
      },
    );
  };

  return { noteInbound, mint };
}
