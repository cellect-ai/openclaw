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
/**
 * How long an idle session keeps arrivals no run took up. A queued message is
 * drained when the run ahead of it ends, so one still here this long after the
 * session went idle was steered into that run, not left waiting.
 */
const IDLE_ARRIVALS_TTL_MS = 30 * 60 * 1000;
/** A run whose end was never reported stops holding its session's arrivals. */
const RUN_RECORD_TTL_MS = 24 * 60 * 60 * 1000;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const UNPROVEN = "unproven";
/** The parameters OpenClaw's own exec tool takes; a native harness shell names others. */
const EXEC_PARAMS = new Set([
  "title",
  "command",
  "workdir",
  "env",
  "yieldMs",
  "background",
  "timeoutSeconds",
  "pty",
  "elevated",
  "host",
  "ask",
  "node",
]);

type Arrivals = { senders: Set<string>; proven: boolean; at: number };
type Run = { sessionKey: string; at: number; sender?: string };
type Inbound = {
  channel?: string;
  senderId?: string;
  senderAuthentication?: "verified" | "asserted";
  sessionKey?: string;
};

/** Agent ids are compared as the host normalizes them: without regard to case. */
export function isAdminAgent(
  config: Pick<ResolvedPluginConfig, "adminAgentId">,
  agentId: string | undefined,
): boolean {
  return agentId?.toLowerCase() === config.adminAgentId.toLowerCase();
}

/**
 * Whether these are OpenClaw exec parameters for a command in the sandbox. A
 * Codex `gateway_exec` or `node_exec` reaches the hook as `exec` with its host
 * pinned, and elevation leaves the sandbox too. A harness's native shell
 * (Codex, Claude Code) is also called `exec` here but takes no `env`: a token
 * written into its input would be shown to the model and used by nothing. One
 * that sends only `command` cannot be told apart; see the plugin's deploy notes.
 */
function runsInSandbox(params: Record<string, unknown>): boolean {
  return (
    typeof params.command === "string" &&
    Object.keys(params).every((key) => EXEC_PARAMS.has(key)) &&
    (params.host === undefined || params.host === "sandbox") &&
    params.node === undefined &&
    !params.elevated
  );
}

/** The command's own Fi origin, when it names one that is not `appUrl`. */
function namesAnotherFi(params: Record<string, unknown>, appUrl: string): boolean {
  const env =
    params.env && typeof params.env === "object" && !Array.isArray(params.env)
      ? (params.env as Record<string, unknown>)
      : {};
  return Object.entries(env).some(
    ([key, value]) =>
      key.toUpperCase() === "FI_APP_URL" &&
      (typeof value !== "string" || value.trim().replace(/\/+$/, "") !== appUrl),
  );
}

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
 * what arrived for it: everything observed for the session since a message
 * run last took it up must come from one sender, the channel must have proven
 * that sender on a dispatched message, the run must be a user turn by that
 * same sender, and nobody else may write into the session while it runs.
 * Cron, heartbeat, webhook, sub-agent and inter-session runs bring no such
 * message; a batch from several people and a run another person steers are
 * refused. Arrivals are never forgotten while a run is active: a message
 * queued behind a long run still counts when it is collected with a later one.
 *
 * Voice is not observable here: a Talk consult is dispatched by the Gateway
 * without these hooks. A session is refused from the first consult this
 * process sees on it; a binding that has not yet produced a consult is
 * invisible to a plugin.
 */
export function registerAdminDelegation(api: OpenClawPluginApi) {
  const arrivals = new Map<string, Arrivals>();
  const runs = new Map<string, Run>();
  const voiced = new Set<string>();
  const hasActiveRun = (sessionKey: string) => {
    for (const run of runs.values()) {
      if (run.sessionKey === sessionKey) {
        return true;
      }
    }
    return false;
  };
  const sweep = () => {
    const now = Date.now();
    for (const [id, run] of runs) {
      if (now - run.at > RUN_RECORD_TTL_MS) {
        runs.delete(id);
      }
    }
    for (const [sessionKey, arrived] of arrivals) {
      if (now - arrived.at > IDLE_ARRIVALS_TTL_MS && !hasActiveRun(sessionKey)) {
        arrivals.delete(sessionKey);
      }
    }
  };
  const settle = (runId: string) => {
    const run = runs.get(runId);
    runs.delete(runId);
    const arrived = run && arrivals.get(run.sessionKey);
    if (arrived && !hasActiveRun(run.sessionKey)) {
      // The idle clock starts when the session does, not when the message came.
      arrived.at = Date.now();
    }
  };
  api.agent.events.registerAgentEventSubscription({
    id: "admin-delegation-turn-retirement",
    streams: ["lifecycle"],
    handle(event) {
      if (
        event.data.executionSettled === true &&
        (event.data.phase === "end" || event.data.phase === "error")
      ) {
        settle(event.runId);
      }
    },
  });
  api.lifecycle.registerRuntimeLifecycle({
    id: "admin-delegation-turns",
    dispose: () => {
      arrivals.clear();
      runs.clear();
      voiced.clear();
    },
    cleanup: ({ runId, sessionKey }) => {
      if (runId) {
        settle(runId);
      } else if (sessionKey) {
        arrivals.delete(sessionKey);
        voiced.delete(sessionKey);
        for (const [id, run] of runs) {
          if (run.sessionKey === sessionKey) {
            runs.delete(id);
          }
        }
      } else {
        arrivals.clear();
        runs.clear();
        voiced.clear();
      }
    },
  });
  api.on(
    "before_agent_reply",
    (_event, context) => {
      const config = configFromRuntime(api);
      const { sessionKey, runId } = context;
      if (!isAdminAgent(config, context.agentId) || !sessionKey || !runId || runs.has(runId)) {
        return undefined;
      }
      sweep();
      if (context.channelContext?.chat?.talkThreadRootEventId !== undefined) {
        voiced.add(sessionKey);
      }
      const run: Run = { sessionKey, at: Date.now() };
      runs.set(runId, run);
      // Only a run that carries a message takes up what arrived; a heartbeat
      // or inter-session run in between must not clear a queued message.
      if (context.trigger !== "user" || !context.senderId) {
        return undefined;
      }
      const arrived = arrivals.get(sessionKey);
      arrivals.delete(sessionKey);
      const requester = onBehalfOfRequester({
        channel: context.channel,
        senderId: context.senderId,
      });
      const sender = requester && JSON.stringify(requester);
      if (
        sender &&
        arrived?.proven &&
        arrived.senders.size === 1 &&
        arrived.senders.has(sender) &&
        !voiced.has(sessionKey)
      ) {
        run.sender = sender;
      }
      return undefined;
    },
    { priority: 10_000 },
  );

  const observe = (message: Inbound, proven: boolean): void => {
    const config = configFromRuntime(api);
    const sessionKey = message.sessionKey;
    if (!sessionKey?.toLowerCase().startsWith(`agent:${config.adminAgentId.toLowerCase()}:`)) {
      return;
    }
    sweep();
    const requester = onBehalfOfRequester(message);
    const sender = requester ? JSON.stringify(requester) : UNPROVEN;
    const arrived = arrivals.get(sessionKey) ?? { senders: new Set(), proven: false, at: 0 };
    arrived.senders.add(sender);
    arrived.proven ||= proven && sender !== UNPROVEN;
    arrived.at = Date.now();
    arrivals.set(sessionKey, arrived);
    for (const run of runs.values()) {
      if (run.sessionKey === sessionKey && run.sender !== sender) {
        delete run.sender;
      }
    }
  };

  /**
   * A message the host is about to dispatch to the agent. Only here does the
   * channel say whether it proved the sender itself: Slack for its own events,
   * Matrix for the homeserver's. Anything else counts as someone unknown.
   */
  const dispatched = (message: Inbound): void =>
    message.senderAuthentication === "verified"
      ? observe(message, true)
      : observe({ sessionKey: message.sessionKey }, false);

  /**
   * Any input the host accepted for a session, including one injected into a
   * running turn without a dispatch. It proves nobody, and counts against a
   * turn that belongs to somebody else.
   */
  const received = (message: Inbound): void => observe(message, false);

  /**
   * The token for this tool call, or nothing. Synchronous refusals stay
   * synchronous so a call that gets no token is not delayed by asking Fi.
   */
  const mint = (
    config: ResolvedPluginConfig,
    event: { toolName: string; toolKind?: string; params: Record<string, unknown> },
    ctx: PluginHookToolContext,
  ): Promise<string | undefined> | undefined => {
    if (
      !config.tenantOrgId ||
      !isAdminAgent(config, ctx.agentId) ||
      !ON_BEHALF_OF_TOOLS.has(event.toolName) ||
      event.toolKind ||
      ctx.toolKind ||
      !runsInSandbox(event.params) ||
      !ctx.sessionKey ||
      // An approved admin action keeps today's attribution; it is not this turn's requester.
      adminActionSessions.has(ctx.sessionKey) ||
      voiced.has(ctx.sessionKey)
    ) {
      return undefined;
    }
    const run = ctx.runId ? runs.get(ctx.runId) : undefined;
    const requester = onBehalfOfRequester(ctx.requester);
    const sender = requester && JSON.stringify(requester);
    if (
      !run ||
      !requester ||
      !sender ||
      run.sessionKey !== ctx.sessionKey ||
      run.sender !== sender
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
      connection = matrixConnection(config, ctx.requester?.accountId);
    } else {
      return undefined;
    }
    // The command chooses where its bearer goes; this is not a control over it.
    // A call that names another Fi is simply not this Fi's to give a token to.
    if (!connection || namesAnotherFi(event.params, connection.baseUrl.replace(/\/+$/, ""))) {
      return undefined;
    }
    return lookupDelegation({ ...config, ...connection }, body, {
      agentId: FI_ADMIN_DELEGATION_AGENT_ID,
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    }).then(
      (delegation) => {
        const token: unknown = delegation?.fi?.token;
        const expiresAt: unknown = delegation?.fi?.expiresAt;
        return typeof token === "string" &&
          JWT.test(token) &&
          typeof expiresAt === "number" &&
          expiresAt - Date.now() / 1000 >= MIN_REMAINING_SECONDS &&
          !ctx.abortSignal?.aborted &&
          runs.get(ctx.runId ?? "") === run &&
          run.sender === sender &&
          !voiced.has(run.sessionKey)
          ? token
          : undefined;
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

  return { dispatched, received, mint };
}
