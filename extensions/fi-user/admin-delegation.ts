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
 * Sessions and runs remembered at once. Nothing here is dropped on a clock:
 * which runs take up a queued message is not all visible to a plugin, so an
 * arrival is forgotten only when a message run takes it up or the host retires
 * the session. Past the cap nothing is admitted until the plugin is reloaded.
 */
const MAX_TRACKED = 5_000;
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

type Arrivals = {
  senders: Set<string>;
  proven: boolean;
  /** Event ids of the proven Matrix room messages among them; empty for a direct session. */
  roomEvents: Set<string>;
};
type Proof = { sender: string; roomEventId?: string };
type Run = { sessionKey: string; sender?: string };
type Inbound = {
  channel?: string;
  senderId?: string;
  senderAuthentication?: "verified" | "asserted";
  /** False only when the channel itself classified the conversation as one person's. */
  isGroup?: boolean;
  /** The channel's own id of the dispatched message: for Matrix, the room event. */
  messageId?: string;
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
 * that sends only `command` cannot be told apart; see the plugin's README.
 *
 * With no `host` the effective one is configuration's, which a plugin cannot
 * see, so a call that gets a token is also pinned to the sandbox by the caller.
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
 * refused.
 *
 * A Slack session must be the sender's own direct one. A Matrix room or thread
 * is admitted one message at a time (owner decision, 2026-10-06): the run must
 * also be the one the host started for that very room event, so the token is
 * that run's and that sender's, and the next run in the thread stands on its
 * own message. The agent still reads other people's words in the room without
 * their being dispatched to it; Fi decides whether the sender is an admin.
 *
 * An arrival is never forgotten on a clock: a message queued behind a long run
 * still counts when it is collected with a later one, at the price of one
 * refused turn for the owner after someone else's message was steered in.
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
  let overflowed = false;
  const hasRoom = (tracked: { size: number }) => {
    if (tracked.size < MAX_TRACKED) {
      return true;
    }
    if (!overflowed) {
      overflowed = true;
      api.logger.warn("fi-user: admin delegation is off until reload; too many sessions tracked");
    }
    return false;
  };
  const reset = () => {
    arrivals.clear();
    runs.clear();
    voiced.clear();
    overflowed = false;
  };
  /**
   * The sender a verified dispatched message proves for the admin agent's
   * session, by the session key the host routed (compared in lower case):
   * - Slack: `agent:<admin>:slack:direct:<peer>`, and the sender is that peer.
   *   A Slack channel or thread proves nobody.
   * - Matrix: `agent:<admin>:matrix:…`, whose key does not say what kind of
   *   room it is, so the Matrix monitor must have classified the message. A
   *   direct message proves its sender; a room or thread message proves its
   *   sender for that one room event only.
   */
  const provenSender = (
    adminAgentId: string,
    sessionKey: string,
    message: Inbound,
  ): Proof | undefined => {
    const requester = onBehalfOfRequester(message);
    const prefix = `agent:${adminAgentId.toLowerCase()}:`;
    if (!requester || !sessionKey.startsWith(prefix)) {
      return undefined;
    }
    const rest = sessionKey.slice(prefix.length);
    const sender = JSON.stringify(requester);
    if ("requester_slack_user_id" in requester) {
      return rest === `slack:direct:${requester.requester_slack_user_id.toLowerCase()}`
        ? { sender }
        : undefined;
    }
    if (!("requester_matrix_user_id" in requester) || !rest.startsWith("matrix:")) {
      return undefined;
    }
    if (message.isGroup === false) {
      return { sender };
    }
    return message.isGroup === true && message.messageId?.startsWith("$")
      ? { sender, roomEventId: message.messageId }
      : undefined;
  };
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
    dispose: reset,
    cleanup: ({ runId, sessionKey }) => {
      if (runId) {
        runs.delete(runId);
      } else if (sessionKey) {
        const key = sessionKey.toLowerCase();
        arrivals.delete(key);
        voiced.delete(key);
        for (const [id, run] of runs) {
          if (run.sessionKey === key) {
            runs.delete(id);
          }
        }
      } else {
        reset();
      }
    },
  });
  api.on(
    "before_agent_reply",
    (_event, context) => {
      const config = configFromRuntime(api);
      const sessionKey = context.sessionKey?.toLowerCase();
      const runId = context.runId;
      if (!isAdminAgent(config, context.agentId) || !sessionKey || !runId || runs.has(runId)) {
        return undefined;
      }
      if (context.channelContext?.chat?.talkThreadRootEventId !== undefined) {
        voiced.add(sessionKey);
      }
      if (!hasRoom(runs)) {
        return undefined;
      }
      // Remembered whether admitted or not, so a second attempt of the same
      // run does not take up what arrived for the next one.
      const run: Run = { sessionKey };
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
      // The Matrix monitor puts the homeserver event that started the run on
      // the host-owned context. A room message admits only that event's run.
      const origin = context.channelContext;
      const startedByArrival =
        arrived?.roomEvents.size === 0 ||
        (typeof origin?.chat?.eventId === "string" &&
          arrived?.roomEvents.has(origin.chat.eventId) === true);
      if (
        sender &&
        !overflowed &&
        arrived?.proven &&
        arrived.senders.size === 1 &&
        arrived.senders.has(sender) &&
        startedByArrival &&
        // Another agent's account is a proven sender but not a person.
        origin?.sender?.isBot !== true &&
        !voiced.has(sessionKey)
      ) {
        run.sender = sender;
      }
      return undefined;
    },
    { priority: 10_000 },
  );

  /** `sender` is the session's proven or named person; anyone else is unknown. */
  const observe = (sessionKey: string, sender: string, proof?: Proof): void => {
    let arrived = arrivals.get(sessionKey);
    if (!arrived && hasRoom(arrivals)) {
      arrived = { senders: new Set(), proven: false, roomEvents: new Set() };
      arrivals.set(sessionKey, arrived);
    }
    if (arrived) {
      arrived.senders.add(sender);
      arrived.proven ||= proof !== undefined;
      if (proof?.roomEventId) {
        arrived.roomEvents.add(proof.roomEventId);
      }
    }
    for (const run of runs.values()) {
      if (run.sessionKey === sessionKey && run.sender !== sender) {
        delete run.sender;
      }
    }
  };
  const adminSession = (message: Inbound) => {
    const { adminAgentId } = configFromRuntime(api);
    const sessionKey = message.sessionKey?.toLowerCase();
    return sessionKey?.startsWith(`agent:${adminAgentId.toLowerCase()}:`)
      ? { adminAgentId, sessionKey }
      : undefined;
  };

  /**
   * A message the host is about to dispatch to the agent. Only here does the
   * channel say whether it proved the sender itself (Slack for its own events,
   * Matrix for the homeserver's), whether the conversation is one person's and
   * which event it is. Anything else counts as someone unknown.
   */
  const dispatched = (message: Inbound): void => {
    const session = adminSession(message);
    if (!session) {
      return;
    }
    const proof =
      message.senderAuthentication === "verified"
        ? provenSender(session.adminAgentId, session.sessionKey, message)
        : undefined;
    observe(session.sessionKey, proof?.sender ?? UNPROVEN, proof);
  };

  /**
   * Any input the host accepted for a session, including one injected into a
   * running turn without a dispatch. It proves nobody, and counts against a
   * turn that belongs to somebody else.
   */
  const received = (message: Inbound): void => {
    const session = adminSession(message);
    if (!session) {
      return;
    }
    const requester = onBehalfOfRequester(message);
    observe(session.sessionKey, requester ? JSON.stringify(requester) : UNPROVEN);
  };

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
      overflowed
    ) {
      return undefined;
    }
    const sessionKey = ctx.sessionKey.toLowerCase();
    if (voiced.has(sessionKey)) {
      return undefined;
    }
    const run = ctx.runId ? runs.get(ctx.runId) : undefined;
    const requester = onBehalfOfRequester(ctx.requester);
    const sender = requester && JSON.stringify(requester);
    if (!run || !requester || !sender || run.sessionKey !== sessionKey || run.sender !== sender) {
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
