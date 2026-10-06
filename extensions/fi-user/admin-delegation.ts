import { createHash } from "node:crypto";
import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
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

/**
 * The host gives every before_tool_call handler 15 s in all, and the Matrix
 * grant check that runs first may take 12 s of it. Fi is asked only with what
 * is left of 13 s, never for more than 8 s, and not at all with under half a
 * second: the command then runs without a token instead of being denied.
 */
const HOOK_BUDGET_MS = 13_000;
const MAX_MINT_MS = 8_000;
const MIN_MINT_MS = 500;
/** A token this close to expiry is not handed to a command. */
const MIN_REMAINING_SECONDS = 60;
/** Sessions, runs, sandboxes and issued tokens remembered at once; the oldest is dropped. */
const MAX_TRACKED = 5_000;
/**
 * How long what arrived for a session waits for a message run to take it up.
 * Far longer than any run a queued message waits behind; a Matrix run must
 * also match one of the remembered events, so forgetting only refuses.
 */
const ARRIVAL_TTL_MS = 6 * 60 * 60 * 1000;
/** Shown to whoever reaches a sandbox that still holds another person's token. */
const HELD = "Another admin's command is still finishing here. Try again in a few minutes.";
/**
 * The tools that reach the sandbox's processes or files: the host's sandbox
 * tool list (`DEFAULT_TOOL_ALLOW` in src/agents/sandbox/constants.ts) without
 * its session tools, and the Codex names for exec and process.
 */
const SANDBOX_TOOLS = new Set([
  "exec",
  "sandbox_exec",
  "process",
  "sandbox_process",
  "read",
  "ls",
  "write",
  "edit",
  "apply_patch",
  "view_image",
]);
const JWT_ANYWHERE = /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const REDACTED = "[redacted Fi token]";
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
  /** Event ids of the proven Matrix messages among them. */
  events: Set<string>;
  /** When the last of them was observed. */
  at: number;
};
type Proof = { sender: string; eventId?: string };
/** Who a sandbox last ran a token-bearing command for, and until when that token lives. */
type Custody = { sender: string; expiresAt: number };

/** Set `key` as the newest entry, dropping the oldest ones past the cap. */
function remember<V>(tracked: Map<string, V>, key: string, value: V): void {
  tracked.delete(key);
  tracked.set(key, value);
  for (const oldest of tracked.keys()) {
    if (tracked.size <= MAX_TRACKED) {
      break;
    }
    tracked.delete(oldest);
  }
}
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
 * (Codex, Claude Code) is also called `exec` here but takes no `env`; one that
 * sends only `command` cannot be told apart, and the host refuses the rewrite
 * of such a call, so the token never reaches it. A terminal or a command sent
 * to the background outlives the call that was given the token.
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
    !params.elevated &&
    !params.pty &&
    !params.background
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
 * An arrival waits six hours for a message run: a message queued behind a long
 * run still counts when it is collected with a later one, at the price of one
 * refused turn for the owner after someone else's message was steered in.
 *
 * A token is issued only where pinning its command to the sandbox changes
 * nothing for the deployment: the admin agent always runs sandboxed, its exec
 * host is the sandbox, and elevation is off. Elsewhere nothing is issued and
 * nothing is pinned. The sandbox that ran a token-bearing command is then kept
 * to that person until the token expires: what the command printed or left
 * behind is still there for the agent's next tool call.
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
  const custody = new Map<string, Custody>();
  /** SHA-256 of each issued token and when it expires; never the token. */
  const issued = new Map<string, { length: number; expiresAt: number }>();
  const reset = () => {
    arrivals.clear();
    runs.clear();
    voiced.clear();
  };
  /**
   * What this runtime's configuration says about the admin agent's commands,
   * read as the host reads it (`resolveSandboxConfigForAgent`, the exec host
   * default in `resolveExecTarget`, `resolveElevatedPermissions`): the agent's
   * own setting, then the default. A per-session override is not visible here.
   */
  const posture = (adminAgentId: string) => {
    const cfg = (api.runtime.config?.current?.() ?? api.config) as OpenClawConfig;
    const agent = resolveAgentConfig(cfg, adminAgentId);
    const defaults = cfg.agents?.defaults?.sandbox;
    const execHost = agent?.tools?.exec?.host ?? cfg.tools?.exec?.host ?? "auto";
    return {
      /** Naming the sandbox and no elevation is what every command already gets. */
      pinIsHarmless:
        (agent?.sandbox?.mode ?? defaults?.mode ?? "off") === "all" &&
        (execHost === "auto" || execHost === "sandbox") &&
        (cfg.tools?.elevated?.enabled === false || agent?.tools?.elevated?.enabled === false) &&
        // Talk steers a session without these hooks; its own agent must not be this one.
        cfg.talk?.agentId?.trim().toLowerCase() !== adminAgentId.toLowerCase(),
      scope: agent?.sandbox?.scope ?? defaults?.scope ?? "agent",
    };
  };
  /** One sandbox per session only under that scope; otherwise the agent's sessions share it. */
  const sandboxKey = (adminAgentId: string, sessionKey: string): string =>
    posture(adminAgentId).scope === "session" ? sessionKey : `agent:${adminAgentId.toLowerCase()}`;
  const digest = (token: string) => createHash("sha256").update(token).digest("hex");
  /** `value` with every issued token in it replaced, or `value` itself when there is none. */
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.replace(JWT_ANYWHERE, (candidate) => {
        const known = issued.get(digest(candidate));
        return known?.length === candidate.length ? REDACTED : candidate;
      });
    }
    if (Array.isArray(value)) {
      const next = value.map(scrub);
      return next.some((item, index) => item !== value[index]) ? next : value;
    }
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      const entries = Object.entries(value).map(([key, item]) => [key, scrub(item)] as const);
      return entries.some(([key, item]) => item !== (value as Record<string, unknown>)[key])
        ? Object.fromEntries(entries)
        : value;
    }
    return value;
  };
  // The model can print the token; what a tool returns is scrubbed of it
  // before the model, the transcript or the channel sees the result.
  api.registerAgentToolResultMiddleware((event, context) => {
    if (issued.size === 0 || !isAdminAgent(configFromRuntime(api), context.agentId)) {
      return undefined;
    }
    const result = scrub(event.result) as typeof event.result;
    return result === event.result ? undefined : { result };
  });
  /**
   * The sender a verified dispatched message proves for the admin agent's
   * session, by the session key the host routed (compared in lower case):
   * - Slack: `agent:<admin>:slack:direct:<peer>`, and the sender is that peer.
   *   A Slack channel or thread proves nobody.
   * - Matrix: `agent:<admin>:matrix:…`, whose key does not say what kind of
   *   room it is, so the Matrix monitor must have classified the message as
   *   direct or as a room's. Either proves its sender for that one homeserver
   *   event only.
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
    return typeof message.isGroup === "boolean" && message.messageId?.startsWith("$")
      ? { sender, eventId: message.messageId }
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
      // Remembered whether admitted or not, so a second attempt of the same
      // run does not take up what arrived for the next one.
      const run: Run = { sessionKey };
      remember(runs, runId, run);
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
      // The Matrix monitor puts the homeserver event that started the run and
      // its sender on the host-owned context. A Matrix message admits only the
      // run of that very event, by that very sender.
      const origin = context.channelContext;
      const startedByArrival =
        !requester ||
        !("requester_matrix_user_id" in requester) ||
        (origin?.sender?.id === requester.requester_matrix_user_id &&
          typeof origin.chat?.eventId === "string" &&
          arrived?.events.has(origin.chat.eventId) === true);
      if (
        sender &&
        arrived?.proven &&
        arrived.at > Date.now() - ARRIVAL_TTL_MS &&
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
    const now = Date.now();
    let arrived = arrivals.get(sessionKey);
    if (!arrived || arrived.at <= now - ARRIVAL_TTL_MS) {
      // What no run took up in time is forgotten, here and for every other session.
      for (const [key, stale] of arrivals) {
        if (stale.at <= now - ARRIVAL_TTL_MS) {
          arrivals.delete(key);
        }
      }
      arrived = { senders: new Set(), proven: false, events: new Set(), at: now };
    }
    arrived.senders.add(sender);
    arrived.proven ||= proof !== undefined;
    arrived.at = now;
    if (proof?.eventId) {
      arrived.events.add(proof.eventId);
    }
    remember(arrivals, sessionKey, arrived);
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
   * Why this tool call may not reach the sandbox now, or nothing. While a
   * token issued into a sandbox is alive, only runs proven to be its owner's
   * may use the tools that reach that sandbox: anyone else's run, and a run
   * nobody proved (cron, heartbeat, an approved action), waits it out.
   */
  const held = (
    config: ResolvedPluginConfig,
    toolName: string,
    ctx: PluginHookToolContext,
  ): { block: true; blockReason: string } | undefined => {
    if (!isAdminAgent(config, ctx.agentId) || !SANDBOX_TOOLS.has(toolName) || !ctx.sessionKey) {
      return undefined;
    }
    const sessionKey = ctx.sessionKey.toLowerCase();
    const sandbox = sandboxKey(config.adminAgentId, sessionKey);
    const holder = custody.get(sandbox);
    if (!holder) {
      return undefined;
    }
    if (holder.expiresAt <= Date.now()) {
      custody.delete(sandbox);
      return undefined;
    }
    const run = ctx.runId ? runs.get(ctx.runId) : undefined;
    return run?.sessionKey === sessionKey && run.sender === holder.sender
      ? undefined
      : { block: true, blockReason: HELD };
  };

  /**
   * The token for this tool call, or nothing. Synchronous refusals stay
   * synchronous so a call that gets no token is not delayed by asking Fi.
   */
  const mint = (
    config: ResolvedPluginConfig,
    event: { toolName: string; toolKind?: string; params: Record<string, unknown> },
    ctx: PluginHookToolContext,
    /** When the host entered this tool call's hook; its deadline runs from then. */
    enteredAt: number,
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
      !posture(config.adminAgentId).pinIsHarmless
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
    const budget = Math.min(MAX_MINT_MS, HOOK_BUDGET_MS - (Date.now() - enteredAt));
    if (budget < MIN_MINT_MS) {
      return undefined;
    }
    const sandbox = sandboxKey(config.adminAgentId, sessionKey);
    return lookupDelegation({ ...config, ...connection }, body, {
      agentId: FI_ADMIN_DELEGATION_AGENT_ID,
      signal: AbortSignal.timeout(budget),
    }).then(
      (delegation) => {
        const token: unknown = delegation?.fi?.token;
        const expiresAt: unknown = delegation?.fi?.expiresAt;
        if (
          typeof token !== "string" ||
          !JWT.test(token) ||
          typeof expiresAt !== "number" ||
          expiresAt - Date.now() / 1000 < MIN_REMAINING_SECONDS ||
          ctx.abortSignal?.aborted ||
          runs.get(ctx.runId ?? "") !== run ||
          run.sender !== sender ||
          voiced.has(run.sessionKey) ||
          held(config, event.toolName, ctx)
        ) {
          return undefined;
        }
        // From here the token is in the sandbox: it is this person's until it expires.
        const heldUntil = Math.max(custody.get(sandbox)?.expiresAt ?? 0, expiresAt * 1000);
        remember(custody, sandbox, { sender, expiresAt: heldUntil });
        remember(issued, digest(token), { length: token.length, expiresAt: expiresAt * 1000 });
        return token;
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

  return { dispatched, received, held, mint };
}
