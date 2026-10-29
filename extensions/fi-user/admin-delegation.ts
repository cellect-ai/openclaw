import { createHash } from "node:crypto";
import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { isDiagnosticFlagEnabled } from "openclaw/plugin-sdk/diagnostic-flags";
import type { PluginHookToolContext } from "openclaw/plugin-sdk/types";
import { adminActionSessions } from "./admin-action.js";
import {
  configFromRuntime,
  FI_ADMIN_DELEGATION_AGENT_ID,
  lookupDelegation,
  matrixConnection,
  type ResolvedPluginConfig,
} from "./fi-delegation.js";
import type { MatrixEntitlements } from "./matrix-entitlements.js";
import {
  mailWakeRequester,
  ON_BEHALF_OF_TOOLS,
  onBehalfOfRequester,
  pinInstalledFiCliCommand,
  talkConsultSender,
  type CommandDelegation,
  type TalkChannelContext,
} from "./on-behalf-of.js";

/**
 * The host gives every before_tool_call handler 15 s in all, and the Matrix
 * grant check that runs first may take 12 s of it. Fi is asked only with what
 * is left of 13 s, never for more than 8 s, and not at all with under half a
 * second. A selected Matrix environment that differs from the sandbox default
 * cannot fall back to that default when its token cannot be issued.
 */
const HOOK_BUDGET_MS = 13_000;
const MAX_MINT_MS = 8_000;
const MIN_MINT_MS = 500;
/** A token this close to expiry is not handed to a command. */
const MIN_REMAINING_SECONDS = 60;
/** Sessions, runs and sandboxes remembered at once; the oldest is dropped. */
const MAX_TRACKED = 5_000;
/**
 * How long what arrived for a session waits for a message run to take it up.
 * Far longer than any run a queued message waits behind; a Matrix run must
 * also match one of the remembered events, so forgetting only refuses.
 */
const ARRIVAL_TTL_MS = 6 * 60 * 60 * 1000;
/** Fi's source-reply check runs as the Matrix event is received, just before it is dispatched. */
const SOURCE_REPLY_TTL_MS = 5 * 60 * 1000;
/**
 * Fi's tokens live ten minutes. One that claims more than this is refused, and
 * no sandbox is held for longer on any answer's say-so.
 */
const MAX_HOLD_MS = 15 * 60 * 1000;
/** Shown to whoever reaches a sandbox that still holds another person's token. */
const HELD =
  "This sandbox still holds another requester's command state. Retry after its requester token expires.";
const UNPROVEN_HOLD =
  "This run has no verified requester proof for the sandbox's retained command state. A fresh authenticated message is required; this does not indicate another command is running.";
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
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const UNPROVEN = "unproven";
type DelegationDiagnosticReason =
  | "turn-context-incomplete"
  | "turn-already-observed"
  | "turn-not-user"
  | "turn-admitted"
  | "turn-unproven"
  | "mint-ineligible"
  | "mint-run-unproven"
  | "mint-unsupported-requester"
  | "mint-connection-unavailable"
  | "mint-budget-exhausted"
  | "mint-reply-invalid"
  | "mint-held"
  | "mint-issued"
  | "mint-request-failed";
/** The parameters OpenClaw's own exec tool takes; a native harness shell names others. */
const EXEC_PARAMS = new Set([
  "title",
  "command",
  "workdir",
  "env",
  "yieldMs",
  "awaitResults",
  "background",
  "closeProcessTree",
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
  /** The projection room each proven Matrix reply to a source session came from. */
  sourceRooms: Map<string, string>;
  /** When the last of them was observed. */
  at: number;
};
type Proof = { sender: string; eventId?: string; sourceRoomId?: string };
/** Who a sandbox last ran a token-bearing command for, and until when that token lives. */
type Custody = {
  sender: string;
  expiresAt: number;
  /** Missing/duplicate call identities retain the conservative expiry fallback. */
  untrackedUntil: number;
  calls: Map<string, { sessionKey: string; agentId: string; expiresAt: number }>;
};
type Held = { block: true; blockReason: string };

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
type Run = {
  agentId: string;
  sessionKey: string;
  sender?: string;
  voice?: ReturnType<MatrixEntitlements["admittedVoiceTurn"]>;
};
type Inbound = {
  channel?: string;
  senderId?: string;
  senderAuthentication?: "verified" | "asserted";
  /** False only when the channel itself classified the conversation as one person's. */
  isGroup?: boolean;
  /** The channel's own id of the dispatched message: for Matrix, the room event. */
  messageId?: string;
  sessionKey?: string;
  /**
   * Host-owned channel identity. A Matrix Talk consult the Gateway dispatches
   * names its attested speaker and thread here; chat.send input cannot set it.
   */
  channelContext?: TalkChannelContext;
};

/**
 * Requester handoff applies to the configured admin and the existing Cellect
 * Superadmin. This is not a grant: native sender proof, sandbox posture, the
 * tenant broker and Fi's current member permissions still decide each call.
 */
export function isAdminAgent(
  config: Pick<ResolvedPluginConfig, "adminAgentId">,
  agentId: string | undefined,
): boolean {
  const id = agentId?.toLowerCase();
  return id === config.adminAgentId.toLowerCase() || id === "cellect-main";
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
    (params.awaitResults === undefined || typeof params.awaitResults === "boolean") &&
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
 * nothing here keeps a token. Failure yields none for the existing same-Fi
 * operator path; an eligible turn selecting another Fi must instead block.
 *
 * A tool call names its requester but not what started its run, and the host
 * reuses a stored sender when it resumes a run. So a turn is admitted only by
 * what arrived for it: everything observed for the session since a message
 * run last took it up must come from one sender, the channel must have proven
 * that sender on a dispatched message, the run must be a user turn by that
 * same sender, and nobody else may write into the session while it runs.
 * Cron, heartbeat, webhook, sub-agent and inter-session runs bring no such
 * message; a batch from several people and a run another person steers are
 * refused. A shared-mail hook is the exception: its session is `hook:fi-mail:`
 * and its sender was attested by the authenticated hooks caller, so that
 * cron turn is the named member.
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
 * nothing is pinned. Credential-bearing commands require native process-tree
 * cleanup. The sandbox is reserved until each exact command's cleanup is proven,
 * with token expiry as the fallback for missing or failed proof. This relies on
 * the installed CLI's no-credential-persistence contract; process extinction is
 * not a claim that arbitrary shell writes to shared files have been erased.
 *
 * Matrix-bound voice consults use the Matrix entitlement owner's admitted
 * speaker/run identity, not synthetic message arrivals or a session-wide flag.
 * Accepted consults may outlive their audio relay; the host retains their run
 * authority and checks it again at tool execution, including after awaited hooks.
 */
export function registerAdminDelegation(
  api: OpenClawPluginApi,
  admittedVoiceTurn: MatrixEntitlements["admittedVoiceTurn"] = () => undefined,
) {
  // Existing diagnostic flags/logging own activation and retention. Only an
  // opaque host run id, a closed reason, and booleans cross this boundary.
  const diagnose = (
    context: { runId?: string; sessionKey?: string },
    reason: DelegationDiagnosticReason,
    facts: () => Record<string, boolean> = () => ({}),
  ): void => {
    const { runId, sessionKey } = context;
    if (!runId || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(runId)) {
      return;
    }
    try {
      const cfg = api.runtime.config?.current?.() ?? api.config;
      const runFlag = `fi-user.admin-delegation.${runId.toLowerCase()}`;
      const sessionFlag = sessionKey
        ? `fi-user.admin-delegation.session.${createHash("sha256").update(sessionKey.toLowerCase()).digest("hex")}`
        : undefined;
      // Broad existing diagnostics must not opt a new run into collection.
      const flag = cfg.diagnostics?.flags?.find(
        (value) => value === runFlag || value === sessionFlag,
      );
      if (
        !flag ||
        !isDiagnosticFlagEnabled(flag, {
          diagnostics: { flags: [...(cfg.diagnostics?.flags ?? [])] },
        })
      ) {
        return;
      }
      // The existing SDK run owner bounds delivery and clears its two bits on
      // settlement. No diagnostic map, timer, writer, or token state is added.
      const namespace = "admin-delegation-diagnostics";
      const previous = api.runContext.getRunContext({ runId, namespace });
      const delivered = typeof previous === "number" ? previous : 0;
      const bit = reason.startsWith("turn-") ? 1 : 2;
      if (
        (delivered & bit) !== 0 ||
        !api.runContext.setRunContext({ runId, namespace, value: delivered | bit })
      ) {
        return;
      }
      api.logger.info(
        JSON.stringify({ event: "fi-user.admin-delegation", runId, reason, ...facts() }),
      );
    } catch {
      // A diagnostic failure cannot change whether a requester token is issued.
    }
  };
  const arrivals = new Map<string, Arrivals>();
  const runs = new Map<string, Run>();
  /** Fi's latest allowance for one Matrix person to continue one source session, by room. */
  const sourceReplies = new Map<string, { roomId: string; at: number }>();
  const custody = new Map<string, Custody>();
  const reset = () => {
    arrivals.clear();
    runs.clear();
    sourceReplies.clear();
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
    const scope = agent?.sandbox?.scope ?? defaults?.scope ?? "agent";
    const binds = [...(defaults?.docker?.binds ?? []), ...(agent?.sandbox?.docker?.binds ?? [])];
    const readonlyCli = ["/usr/local/bin/cellect", "/repos/fi-runtime"].every((target) => {
      const matches = binds.map((bind) => bind.split(":")).filter((parts) => parts[1] === target);
      return matches.length === 1 && matches[0]?.length === 3 && matches[0][2] === "ro";
    });
    return {
      /** Naming the sandbox and no elevation is what every command already gets. */
      pinIsHarmless:
        (agent?.sandbox?.mode ?? defaults?.mode ?? "off") === "all" &&
        // A sandbox shared with other agents cannot be held for one person.
        scope !== "shared" &&
        (execHost === "auto" || execHost === "sandbox") &&
        (cfg.tools?.elevated?.enabled === false || agent?.tools?.elevated?.enabled === false) &&
        // Talk steers a session without these hooks; its own agent must not be this one.
        cfg.talk?.agentId?.trim().toLowerCase() !== adminAgentId.toLowerCase(),
      scope,
      readonlyCli,
    };
  };
  /** One sandbox per session only under that scope; otherwise the agent's sessions share it. */
  const sandboxKey = (adminAgentId: string, sessionKey: string): string =>
    posture(adminAgentId).scope === "session" ? sessionKey : `agent:${adminAgentId.toLowerCase()}`;
  /**
   * The sender a verified dispatched message proves for the admin agent's
   * session, by the session key the host routed (compared in lower case):
   * - Slack DMs bind the peer. Channels/threads additionally bind the native
   *   message timestamp and the run's host-owned channel context below.
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
      if (rest === `slack:direct:${requester.requester_slack_user_id.toLowerCase()}`) {
        return { sender };
      }
      return message.isGroup === true &&
        /^slack:(?:channel|group):[cg][a-z0-9]+(?::thread:\d+\.\d+)?$/.test(rest) &&
        typeof message.messageId === "string" &&
        /^\d+\.\d+$/.test(message.messageId)
        ? { sender, eventId: message.messageId }
        : undefined;
    }
    if (!("requester_matrix_user_id" in requester)) {
      return undefined;
    }
    if (/^slack:(?:channel|group):/.test(rest)) {
      // A reply in a Slack thread's Matrix projection. The Matrix channel
      // admits it only after Fi's source guard allows this person to continue
      // this session from that room; that answer is the proof. A Slack DM's
      // projection has no local peer check here, so it proves nothing.
      const allowed = sourceReplies.get(
        JSON.stringify([sessionKey, requester.requester_matrix_user_id]),
      );
      return allowed &&
        allowed.at > Date.now() - SOURCE_REPLY_TTL_MS &&
        typeof message.isGroup === "boolean" &&
        message.messageId?.startsWith("$")
        ? { sender, eventId: message.messageId, sourceRoomId: allowed.roomId }
        : undefined;
    }
    if (!rest.startsWith("matrix:")) {
      return undefined;
    }
    return typeof message.isGroup === "boolean" && message.messageId?.startsWith("$")
      ? { sender, eventId: message.messageId }
      : undefined;
  };
  api.agent.events.registerAgentEventSubscription({
    id: "admin-delegation-turn-retirement",
    streams: ["lifecycle", "sandbox_process"],
    handle(event) {
      if (event.stream === "sandbox_process" && event.data.phase === "cleanup-complete") {
        const callId = event.data.toolCallId;
        if (typeof callId !== "string") {
          return;
        }
        const key = JSON.stringify([event.runId, callId]);
        for (const [sandbox, holder] of custody) {
          const call = holder.calls.get(key);
          if (
            !call ||
            event.data.sessionKey !== call.sessionKey ||
            event.data.agentId !== call.agentId
          ) {
            continue;
          }
          holder.calls.delete(key);
          holder.expiresAt = Math.max(
            holder.untrackedUntil,
            ...[...holder.calls.values()].map((pending) => pending.expiresAt),
          );
          if (holder.expiresAt <= Date.now()) {
            custody.delete(sandbox);
          }
        }
        return;
      }
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
        for (const reply of sourceReplies.keys()) {
          if (JSON.parse(reply)[0] === key) {
            sourceReplies.delete(reply);
          }
        }
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
      const agentId = context.agentId?.toLowerCase();
      if (!agentId || !isAdminAgent(config, agentId)) {
        return undefined;
      }
      if (!sessionKey || !sessionKey.startsWith(`agent:${agentId}:`) || !runId || runs.has(runId)) {
        diagnose(
          { runId, sessionKey },
          runs.has(runId ?? "") ? "turn-already-observed" : "turn-context-incomplete",
          () => ({
            sessionPresent: Boolean(sessionKey),
          }),
        );
        return undefined;
      }
      // Remembered whether admitted or not, so a second attempt of the same
      // run does not take up what arrived for the next one.
      const run: Run = { agentId, sessionKey };
      remember(runs, runId, run);
      // A shared-mail hook is a cron turn whose sender the hooks caller
      // attested. It does not consume a channel arrival.
      if (context.trigger === "cron") {
        const mail = mailWakeRequester(sessionKey, context.senderId);
        if (mail) {
          run.sender = JSON.stringify(mail);
        }
        return undefined;
      }
      // Only a run that carries a message takes up what arrived; a heartbeat
      // or inter-session run in between must not clear a queued message.
      if (context.trigger !== "user" || !context.senderId) {
        diagnose({ runId, sessionKey }, "turn-not-user", () => ({
          userTriggered: context.trigger === "user",
          senderPresent: Boolean(context.senderId),
        }));
        return undefined;
      }
      if (context.channelContext?.chat?.talkThreadRootEventId !== undefined) {
        const voice = admittedVoiceTurn({
          agentId: context.agentId,
          runId,
          sessionKey: context.sessionKey,
          requester: {
            channel: context.channel,
            senderId: context.senderId,
            accountId: context.accountId,
          },
        });
        if (voice && context.channelContext.sender?.isBot !== true) {
          const requester = onBehalfOfRequester({ channel: "matrix", senderId: voice.senderId });
          const sender = requester && JSON.stringify(requester);
          if (sender) {
            // A new speaker invalidates other people's in-flight command proof.
            // Do not consume queued text arrivals: their event proves their own run.
            for (const active of runs.values()) {
              if (active.sessionKey === sessionKey && active.sender !== sender) {
                delete active.sender;
              }
            }
            run.sender = sender;
            run.voice = voice;
          }
        }
        diagnose({ runId, sessionKey }, run.sender ? "turn-admitted" : "turn-unproven", () => ({
          voiceTurn: true,
          ownerAdmitted: Boolean(voice),
          senderIsBot: context.channelContext?.sender?.isBot === true,
          requesterPresent: Boolean(run.sender),
        }));
        return undefined;
      }
      const arrived = arrivals.get(sessionKey);
      arrivals.delete(sessionKey);
      const requester = onBehalfOfRequester({
        channel: context.channel,
        senderId: context.senderId,
      });
      const sender = requester && JSON.stringify(requester);
      // Shared conversations admit only the run of the dispatched native event,
      // by that same sender. Never reuse the stored sender on a synthetic wake.
      const origin = context.channelContext;
      const rest = sessionKey.slice(`agent:${agentId}:`.length);
      const slackChannel = /^slack:(?:channel|group):([cg][a-z0-9]+)(?::thread:\d+\.\d+)?$/.exec(
        rest,
      );
      const sourceReply = Boolean(
        requester && "requester_matrix_user_id" in requester && rest.startsWith("slack:"),
      );
      const requiresEvent = requester && ("requester_matrix_user_id" in requester || slackChannel);
      const nativeSender =
        requester &&
        ("requester_matrix_user_id" in requester
          ? requester.requester_matrix_user_id
          : "requester_slack_user_id" in requester
            ? requester.requester_slack_user_id
            : undefined);
      const startedByArrival =
        !requiresEvent ||
        (typeof nativeSender === "string" &&
          origin?.sender?.id === nativeSender &&
          typeof origin?.chat?.eventId === "string" &&
          (sourceReply
            ? arrived?.sourceRooms.get(origin.chat.eventId) === origin.chat.id
            : !slackChannel || origin?.chat?.id?.toLowerCase() === slackChannel[1]) &&
          arrived?.events.has(origin.chat.eventId) === true);
      if (
        sender &&
        arrived?.proven &&
        arrived.at > Date.now() - ARRIVAL_TTL_MS &&
        arrived.senders.size === 1 &&
        arrived.senders.has(sender) &&
        startedByArrival &&
        // Another agent's account is a proven sender but not a person.
        origin?.sender?.isBot !== true
      ) {
        run.sender = sender;
        // Dispatch can queue several native events before the first run starts.
        // Consume only this run's exact event; later runs need their own proof.
        if (requiresEvent && typeof origin?.chat?.eventId === "string") {
          arrived.events.delete(origin.chat.eventId);
          arrived.sourceRooms.delete(origin.chat.eventId);
          if (arrived.events.size > 0) {
            remember(arrivals, sessionKey, arrived);
          }
        }
      }
      diagnose({ runId, sessionKey }, run.sender ? "turn-admitted" : "turn-unproven", () => ({
        requesterPresent: Boolean(sender),
        arrivalPresent: Boolean(arrived),
        dispatchProven: arrived?.proven === true,
        arrivalFresh: Boolean(arrived && arrived.at > Date.now() - ARRIVAL_TTL_MS),
        singleSender: arrived?.senders.size === 1,
        senderMatchesArrival: Boolean(sender && arrived?.senders.has(sender)),
        originEventMatches: startedByArrival,
        senderIsBot: origin?.sender?.isBot === true,
      }));
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
      arrived = {
        senders: new Set(),
        proven: false,
        events: new Set(),
        sourceRooms: new Map(),
        at: now,
      };
    }
    arrived.senders.add(sender);
    arrived.proven ||= proof !== undefined;
    arrived.at = now;
    if (proof?.eventId) {
      arrived.events.add(proof.eventId);
      if (proof.sourceRoomId) {
        arrived.sourceRooms.set(proof.eventId, proof.sourceRoomId);
      }
    }
    remember(arrivals, sessionKey, arrived);
    for (const run of runs.values()) {
      if (run.sessionKey === sessionKey && run.sender !== sender) {
        delete run.sender;
      }
    }
  };
  const adminSession = (message: Inbound) => {
    const config = configFromRuntime(api);
    const sessionKey = message.sessionKey?.toLowerCase();
    const adminAgentId = /^agent:([^:]+):/.exec(sessionKey ?? "")?.[1];
    return sessionKey && adminAgentId && isAdminAgent(config, adminAgentId)
      ? { adminAgentId, sessionKey }
      : undefined;
  };

  /**
   * A message the host is about to dispatch to the agent. Only here does the
   * channel say whether it proved the sender itself (Slack for its own events,
   * Matrix for the homeserver's), whether the conversation is one person's and
   * which event it is. A Talk consult counts as its attested speaker, unproven;
   * anything else counts as someone unknown.
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
    observe(
      session.sessionKey,
      proof?.sender ??
        talkConsultSender(session.adminAgentId, session.sessionKey, message) ??
        UNPROVEN,
      proof,
    );
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
    observe(
      session.sessionKey,
      talkConsultSender(session.adminAgentId, session.sessionKey, message) ??
        (requester ? JSON.stringify(requester) : UNPROVEN),
    );
  };

  /**
   * Why this tool call may not reach the sandbox now, or nothing. While a
   * token issued into a sandbox has unclosed execution custody, only runs proven to be its owner's
   * may use the tools that reach that sandbox: anyone else's run, and a run
   * nobody proved (cron, heartbeat, an approved action), waits it out.
   */
  const held = (
    config: ResolvedPluginConfig,
    toolName: string,
    ctx: PluginHookToolContext,
  ): Held | undefined => {
    if (custody.size === 0) {
      return undefined;
    }
    const agentId = ctx.agentId?.toLowerCase();
    if (
      !agentId ||
      !isAdminAgent(config, agentId) ||
      !SANDBOX_TOOLS.has(toolName) ||
      !ctx.sessionKey
    ) {
      return undefined;
    }
    const sessionKey = ctx.sessionKey.toLowerCase();
    const sandbox = sandboxKey(agentId, sessionKey);
    const holder = custody.get(sandbox);
    if (!holder) {
      return undefined;
    }
    if (holder.expiresAt <= Date.now()) {
      custody.delete(sandbox);
      return undefined;
    }
    const run = ctx.runId ? runs.get(ctx.runId) : undefined;
    return run?.agentId === agentId && run.sessionKey === sessionKey && run.sender === holder.sender
      ? undefined
      : { block: true, blockReason: run?.sender ? HELD : UNPROVEN_HOLD };
  };

  /**
   * The token for this tool call, the reason the call may not run, or nothing.
   * Synchronous refusals stay synchronous so a call that gets no token is not
   * delayed by asking Fi. A sandbox is held only for a token that is returned.
   */
  const mint = (
    config: ResolvedPluginConfig,
    event: { toolName: string; toolKind?: string; params: Record<string, unknown> },
    ctx: PluginHookToolContext,
    /** When the host entered this tool call's hook; its deadline runs from then. */
    enteredAt: number,
  ): Promise<CommandDelegation | Held | undefined> | undefined => {
    const agentId = ctx.agentId?.toLowerCase();
    if (
      !agentId ||
      !config.tenantOrgId ||
      !isAdminAgent(config, agentId) ||
      !ON_BEHALF_OF_TOOLS.has(event.toolName) ||
      event.toolKind ||
      ctx.toolKind ||
      !runsInSandbox(event.params) ||
      !ctx.sessionKey ||
      // An approved admin action keeps today's attribution; it is not this turn's requester.
      adminActionSessions.has(ctx.sessionKey) ||
      !posture(agentId).pinIsHarmless
    ) {
      if (isAdminAgent(config, ctx.agentId) && ON_BEHALF_OF_TOOLS.has(event.toolName)) {
        diagnose(ctx, "mint-ineligible", () => ({
          tenantConfigured: Boolean(config.tenantOrgId),
          toolKindPresent: Boolean(event.toolKind || ctx.toolKind),
          sandboxParameters: runsInSandbox(event.params),
          sessionPresent: Boolean(ctx.sessionKey),
          approvedActionSession: Boolean(ctx.sessionKey && adminActionSessions.has(ctx.sessionKey)),
          safePosture: posture(agentId ?? config.adminAgentId).pinIsHarmless,
        }));
      }
      return undefined;
    }
    const sessionKey = ctx.sessionKey.toLowerCase();
    const run = ctx.runId ? runs.get(ctx.runId) : undefined;
    const mail = mailWakeRequester(sessionKey, ctx.requester?.senderId);
    const requester = mail ?? onBehalfOfRequester(ctx.requester);
    const sender = requester && JSON.stringify(requester);
    if (
      !run ||
      !requester ||
      !sender ||
      run.agentId !== agentId ||
      run.sessionKey !== sessionKey ||
      !sessionKey.startsWith(`agent:${agentId}:`) ||
      run.sender !== sender ||
      (run.voice && admittedVoiceTurn(ctx) !== run.voice)
    ) {
      diagnose(ctx, "mint-run-unproven", () => ({
        runPresent: Boolean(run),
        requesterPresent: Boolean(requester),
        runAdmitted: Boolean(run?.sender),
        sameSession: run?.sessionKey === sessionKey,
        sameSender: Boolean(sender && run?.sender === sender),
        voiceProofCurrent: !run?.voice || admittedVoiceTurn(ctx) === run.voice,
      }));
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
    } else if (mail && "requester_email" in requester) {
      body = { requesterEmail: requester.requester_email };
      connection = config;
    } else {
      diagnose(ctx, "mint-unsupported-requester");
      return undefined;
    }
    connection = connection && { ...connection, baseUrl: connection.baseUrl.replace(/\/+$/, "") };
    const crossEnvironmentFailure: Held | undefined =
      connection && connection.baseUrl.replace(/\/+$/, "") !== config.baseUrl.replace(/\/+$/, "")
        ? {
            block: true,
            blockReason:
              "The requester could not be verified for this Matrix environment. Start a fresh command; this call cannot fall back to the sandbox default Fi.",
          }
        : undefined;
    // An explicit different origin cannot receive this Fi's token. A selected
    // environment must not fall through to the sandbox's ambient Fi either.
    if (!connection || namesAnotherFi(event.params, connection.baseUrl.replace(/\/+$/, ""))) {
      diagnose(ctx, "mint-connection-unavailable", () => ({
        connectionConfigured: Boolean(connection),
        sameFiOrigin: Boolean(
          connection && !namesAnotherFi(event.params, connection.baseUrl.replace(/\/+$/, "")),
        ),
      }));
      return crossEnvironmentFailure ? Promise.resolve(crossEnvironmentFailure) : undefined;
    }
    const budget = Math.min(MAX_MINT_MS, HOOK_BUDGET_MS - (Date.now() - enteredAt));
    if (budget < MIN_MINT_MS) {
      diagnose(ctx, "mint-budget-exhausted");
      return crossEnvironmentFailure ? Promise.resolve(crossEnvironmentFailure) : undefined;
    }
    const baseUrl = connection.baseUrl;
    const sandbox = sandboxKey(agentId, sessionKey);
    return lookupDelegation({ ...config, ...connection }, body, {
      agentId: FI_ADMIN_DELEGATION_AGENT_ID,
      signal: AbortSignal.timeout(budget),
    }).then(
      (delegation) => {
        const token: unknown = delegation?.fi?.token;
        const expiresAt: unknown = delegation?.fi?.expiresAt;
        const now = Date.now();
        if (
          typeof token !== "string" ||
          !JWT.test(token) ||
          typeof expiresAt !== "number" ||
          expiresAt * 1000 - now < MIN_REMAINING_SECONDS * 1000 ||
          expiresAt * 1000 - now > MAX_HOLD_MS ||
          ctx.abortSignal?.aborted ||
          runs.get(ctx.runId ?? "") !== run ||
          run.sender !== sender ||
          (run.voice && admittedVoiceTurn(ctx) !== run.voice)
        ) {
          diagnose(ctx, "mint-reply-invalid", () => ({
            tokenShapeValid: typeof token === "string" && JWT.test(token),
            expiryNumeric: typeof expiresAt === "number",
            lifetimeEnough:
              typeof expiresAt === "number" &&
              expiresAt * 1000 - now >= MIN_REMAINING_SECONDS * 1000,
            lifetimeBounded: typeof expiresAt === "number" && expiresAt * 1000 - now <= MAX_HOLD_MS,
            runAborted: ctx.abortSignal?.aborted === true,
            currentRun: runs.get(ctx.runId ?? "") === run,
            sameSender: run.sender === sender,
            voiceProofCurrent: !run.voice || admittedVoiceTurn(ctx) === run.voice,
          }));
          return crossEnvironmentFailure;
        }
        // Someone else's token may have reached this sandbox while Fi answered:
        // the call must then wait like any other, not run without a token.
        const blocked = held(config, event.toolName, ctx);
        if (blocked) {
          diagnose(ctx, "mint-held");
          return blocked;
        }
        // Expiry is a fallback, not a minimum hold: native descendant cleanup
        // releases only this exact call, never another still-running command.
        const holder = custody.get(sandbox) ?? {
          sender,
          expiresAt: 0,
          untrackedUntil: 0,
          calls: new Map(),
        };
        const expiry = Math.min(expiresAt * 1000, now + MAX_HOLD_MS);
        const key = ctx.runId && ctx.toolCallId && JSON.stringify([ctx.runId, ctx.toolCallId]);
        const pinnedCommand = posture(agentId).readonlyCli
          ? pinInstalledFiCliCommand(event.params)
          : undefined;
        if (
          key &&
          pinnedCommand !== undefined &&
          !holder.calls.has(key) &&
          holder.calls.size < MAX_TRACKED
        ) {
          holder.calls.set(key, { agentId, sessionKey: ctx.sessionKey!, expiresAt: expiry });
        } else {
          holder.untrackedUntil = Math.max(holder.untrackedUntil, expiry);
        }
        holder.expiresAt = Math.max(holder.expiresAt, expiry);
        remember(custody, sandbox, holder);
        diagnose(ctx, "mint-issued");
        return {
          token,
          baseUrl,
          ...(pinnedCommand !== undefined ? { command: pinnedCommand } : {}),
        };
      },
      (error: unknown) => {
        // Status only: the failure may quote the request, which carries the credential.
        const status = /\((\d{3})\)$/.exec(error instanceof Error ? error.message : "")?.[1];
        diagnose(ctx, "mint-request-failed", () => ({
          httpStatusPresent: Boolean(status),
          httpUnauthorized: status === "401",
          httpForbidden: status === "403",
        }));
        api.logger.warn(
          `fi-user: admin delegation not issued (${status ? `status ${status}` : "unavailable"})`,
        );
        return crossEnvironmentFailure;
      },
    );
  };

  /** Fi's latest answer on this Matrix person continuing this source session from this room. */
  const sourceReplyDecided = (decision: {
    sessionKey: string;
    roomId: string;
    senderId: string;
    allowed: boolean;
  }): void => {
    const key = JSON.stringify([decision.sessionKey.toLowerCase(), decision.senderId]);
    if (decision.allowed) {
      remember(sourceReplies, key, { roomId: decision.roomId, at: Date.now() });
    } else {
      sourceReplies.delete(key);
    }
  };

  /**
   * The person this Fi-admin tool call's run was proven to act for, and the Fi
   * that answers for them: the same proof a sandbox command needs for its
   * token, for a Fi call the plugin makes itself. Nothing when unproven.
   */
  const provenToolRequester = (
    ctx: Pick<
      OpenClawPluginToolContext,
      "runId" | "agentId" | "sessionKey" | "messageChannel" | "requesterSenderId" | "agentAccountId"
    >,
  ):
    | {
        connection: ResolvedPluginConfig;
        body: { requesterSenderId: string } | { requesterMatrixUserId: string };
      }
    | undefined => {
    const config = configFromRuntime(api);
    const agentId = ctx.agentId?.toLowerCase();
    const sessionKey = ctx.sessionKey?.toLowerCase();
    const run = ctx.runId ? runs.get(ctx.runId) : undefined;
    const channel = { channel: ctx.messageChannel, senderId: ctx.requesterSenderId };
    const requester = onBehalfOfRequester(channel);
    if (
      !config.tenantOrgId ||
      !agentId ||
      agentId !== config.adminAgentId.toLowerCase() ||
      !sessionKey ||
      adminActionSessions.has(ctx.sessionKey!) ||
      !run ||
      !requester ||
      run.agentId !== agentId ||
      run.sessionKey !== sessionKey ||
      run.sender !== JSON.stringify(requester) ||
      (run.voice &&
        admittedVoiceTurn({
          runId: ctx.runId,
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
          requester: { ...channel, accountId: ctx.agentAccountId },
        }) !== run.voice)
    ) {
      return undefined;
    }
    if ("requester_slack_user_id" in requester) {
      return { connection: config, body: { requesterSenderId: requester.requester_slack_user_id } };
    }
    if (!("requester_matrix_user_id" in requester)) {
      return undefined;
    }
    const matrix = matrixConnection(config, ctx.agentAccountId);
    return matrix
      ? {
          connection: { ...config, ...matrix, baseUrl: matrix.baseUrl.replace(/\/+$/, "") },
          body: { requesterMatrixUserId: requester.requester_matrix_user_id },
        }
      : undefined;
  };

  return { dispatched, received, held, mint, sourceReplyDecided, provenToolRequester };
}
