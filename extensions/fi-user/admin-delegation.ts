import { createHash } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { isDiagnosticFlagEnabled } from "openclaw/plugin-sdk/diagnostic-flags";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { PluginHookToolContext } from "openclaw/plugin-sdk/types";
import { adminActionSessions } from "./admin-action.js";
import { adminCommandPosture, namesAnotherFi, runsInSandbox } from "./admin-command-sandbox.js";
import {
  configFromRuntime,
  isAdminAgent,
  FI_ADMIN_DELEGATION_AGENT_ID,
  FI_USER_AGENT_ID,
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
  type OnBehalfOfRequester,
  talkConsultSender,
  type CommandDelegation,
  type TalkChannelContext,
} from "./on-behalf-of.js";
import {
  operationCommandArgs,
  operationCommandFailure,
  requestOperationCommandReceipt,
} from "./operation-command.js";
import {
  forgetAllProjectedMatrixRuns,
  forgetProjectedMatrixRun,
  forgetProjectedMatrixSession,
  rememberProjectedMatrixRun,
} from "./projected-matrix-runs.js";
import type { RequesterProofReader } from "./requester-proof.js";
import { shadowWakeAttestation } from "./shadow-requester.js";

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
const MATRIX_USER_ID = /^@[^\s:]+:[^\s]+$/;
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

type Arrivals = {
  senders: Set<string>;
  proven: boolean;
  /** Event ids of the proven Matrix messages among them. */
  events: Set<string>;
  /** The projection room each proven Matrix reply to a source session came from. */
  sourceRooms: Map<string, string>;
  /**
   * The homeserver-verified sender and Matrix account of each proven reply to
   * a source session, by event. The run started for that event takes its
   * requester from here, whatever channel the host reports for the session.
   */
  sourceSenders: Map<string, { matrixUserId: string; accountId?: string }>;
  /** When the last of them was observed. */
  at: number;
};
type Proof = {
  sender: string;
  eventId?: string;
  sourceRoomId?: string;
  sourceMatrixUserId?: string;
  sourceAccountId?: string;
};
/** A run admitted for a verified Matrix reply in a Slack source session's projection. */
type MatrixOrigin = { matrixUserId: string; accountId?: string };
/** Who a sandbox last ran a token-bearing command for, and until when that token lives. */
type Custody = {
  sender: string;
  expiresAt: number;
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
  continuation?: PluginHookToolContext["requesterContinuation"];
  voice?: ReturnType<MatrixEntitlements["admittedVoiceTurn"]>;
  matrixOrigin?: MatrixOrigin;
  /** Fi's attestation of a `hook:fi-shadow:` run; Fi, not this plugin, names the member. */
  shadowAttestation?: string;
};
/** The one requester of a shadow run; the attestation stays on the run, never in a claim. */
const SHADOW_REQUESTER = { requester_shadow: true } as const;
type ShadowRequester = typeof SHADOW_REQUESTER;
/**
 * The Matrix requester of a run admitted from a verified source-session reply,
 * when the host names that run's sender but reports the session's own channel.
 * Only the exact admitted sender qualifies; a continuation keeps its own proof.
 */
function matrixOriginRequester(
  run: Run | undefined,
  senderId: string | undefined,
): OnBehalfOfRequester | undefined {
  const origin = run?.matrixOrigin;
  return origin && !run.continuation && senderId?.trim() === origin.matrixUserId
    ? { requester_matrix_user_id: origin.matrixUserId }
    : undefined;
}
/** Every use retains the exact host capability; copied identity fields prove nothing. */
function continuationCurrent(
  run: Run,
  ctx: Pick<
    PluginHookToolContext,
    "requesterContinuation" | "runId" | "sessionId" | "sessionKey" | "agentId" | "requester"
  >,
): boolean {
  const proof = run.continuation;
  if (!proof) {
    return true;
  }
  if (
    ctx.requesterContinuation !== proof ||
    ctx.runId !== proof.runId ||
    ctx.sessionId !== proof.sessionId ||
    ctx.sessionKey !== proof.sessionKey ||
    ctx.agentId !== proof.agentId ||
    (ctx.requester?.accountId !== undefined && ctx.requester.accountId !== proof.accountId) ||
    (ctx.requester?.channel !== undefined && ctx.requester.channel !== proof.channel)
  ) {
    return false;
  }
  try {
    proof.assertCurrent();
    return true;
  } catch {
    return false;
  }
}
type Inbound = {
  channel?: string;
  senderId?: string;
  senderAuthentication?: "verified" | "asserted";
  /** False only when the channel itself classified the conversation as one person's. */
  isGroup?: boolean;
  /** The channel's own id of the dispatched message: for Matrix, the room event. */
  messageId?: string;
  /** The channel account that received it, as the host routed it. */
  accountId?: string;
  sessionKey?: string;
  /**
   * Host-owned channel identity. A Matrix Talk consult the Gateway dispatches
   * names its attested speaker and thread here; chat.send input cannot set it.
   */
  channelContext?: TalkChannelContext;
};

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
 * cleanup. Only a direct immutable installed CLI call with a unique native call
 * identity receives a token; raw shell work never receives requester credentials.
 * The sandbox is reserved until each exact command's cleanup is proven,
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
  admittedOperatorCommand: MatrixEntitlements["admittedOperatorCommand"] = () => undefined,
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
  const custody = new Map<string, Custody>();
  /**
   * Verified Matrix replies dispatched into a Fi-user Slack session, by session
   * then event: the run started for that exact event, by that sender, takes it.
   */
  const fiUserReplies = new Map<
    string,
    Map<string, { matrixUserId: string; roomId: string; accountId?: string }>
  >();
  /**
   * Fi-user sessions someone else wrote into since a run last started there: a
   * run that may carry their queued words proves nobody, as on the admin side.
   */
  const fiUserTainted = new Set<string>();
  const reset = () => {
    fiUserTainted.clear();
    arrivals.clear();
    runs.clear();
    fiUserReplies.clear();
    forgetAllProjectedMatrixRuns();
  };
  /** Only Matrix's native, source-authorized ingress can supply this event tuple.
   * It grants no Fi permissions; verified dispatch and exact run/event matching
   * below still decide whether it can prove this turn. */
  const sourceReplyAdmission = (message: Inbound, sessionKey: string) => {
    const proof = message.channelContext?.chat?.sourceReplyAdmission;
    if (!isRecord(proof)) {
      return undefined;
    }
    const accountId = typeof proof.accountId === "string" ? proof.accountId : undefined;
    return proof.version === 1 &&
      typeof proof.sessionKey === "string" &&
      proof.sessionKey.toLowerCase() === sessionKey &&
      proof.senderId === message.senderId?.trim() &&
      proof.senderId === message.channelContext?.sender?.id &&
      proof.roomId === message.channelContext?.chat?.id &&
      proof.eventId === message.messageId &&
      proof.eventId === message.channelContext?.chat?.eventId &&
      typeof proof.eventId === "string" &&
      proof.eventId.startsWith("$") &&
      accountId !== undefined &&
      accountId === message.accountId &&
      matrixConnection(configFromRuntime(api), accountId) !== undefined &&
      typeof proof.authorizedAt === "number" &&
      Number.isSafeInteger(proof.authorizedAt) &&
      proof.authorizedAt <= Date.now() &&
      proof.authorizedAt > Date.now() - SOURCE_REPLY_TTL_MS &&
      typeof proof.roomId === "string" &&
      proof.roomId.startsWith("!")
      ? { roomId: proof.roomId, accountId }
      : undefined;
  };
  const FI_USER_SOURCE_SESSION = new RegExp(`^agent:${FI_USER_AGENT_ID}:slack:(?:channel|group):`);
  /**
   * A message for a Fi-user Slack session. Only a homeserver-verified reply that
   * Fi's source guard currently allows for this exact person and session is
   * remembered; anyone else's message voids what is pending and running there.
   */
  const fiUserInbound = (message: Inbound, dispatch: boolean): void => {
    const sessionKey = message.sessionKey?.toLowerCase();
    if (!sessionKey || !FI_USER_SOURCE_SESSION.test(sessionKey)) {
      return;
    }
    const sender = message.senderId?.trim() ?? "";
    const allowed = sourceReplyAdmission(message, sessionKey);
    const proven =
      (message.channel === "matrix" || message.channel === "slack") &&
      MATRIX_USER_ID.test(sender) &&
      allowed !== undefined;
    const pending = fiUserReplies.get(sessionKey);
    if (!proven || (dispatch && message.senderAuthentication !== "verified")) {
      fiUserReplies.delete(sessionKey);
      forgetProjectedMatrixSession(sessionKey);
      fiUserTainted.add(sessionKey);
      return;
    }
    for (const [eventId, reply] of pending ?? []) {
      if (reply.matrixUserId !== sender) {
        pending!.delete(eventId);
        fiUserTainted.add(sessionKey);
      }
    }
    forgetProjectedMatrixSession(sessionKey, sender);
    if (!dispatch || typeof message.isGroup !== "boolean" || !message.messageId?.startsWith("$")) {
      return;
    }
    const account = message.accountId?.trim();
    const replies = pending ?? new Map();
    replies.set(message.messageId, {
      matrixUserId: sender,
      roomId: allowed.roomId,
      ...(account && matrixConnection(configFromRuntime(api), account)
        ? { accountId: account }
        : {}),
    });
    remember(fiUserReplies, sessionKey, replies);
  };
  const posture = (adminAgentId: string) =>
    adminCommandPosture(api.runtime.config?.current?.() ?? api.config, adminAgentId);
  /** One sandbox per session only under that scope; otherwise the agent's sessions share it. */
  const sandboxKey = (adminAgentId: string, sessionKey: string): string =>
    posture(adminAgentId).scope === "session" ? sessionKey : `agent:${adminAgentId.toLowerCase()}`;
  /**
   * Who an inbound message for an admin session is from. A reply in a Slack
   * session's Matrix projection is a Matrix person even when the host labels
   * the message with the session's channel; only Fi's current source-guard
   * allowance for this exact person and session makes such a sender one.
   */
  const inboundRequester = (
    sessionKey: string,
    message: Inbound,
  ): OnBehalfOfRequester | undefined => {
    const direct = onBehalfOfRequester(message);
    if (direct) {
      return direct;
    }
    const sender = message.senderId?.trim() ?? "";
    const allowed = sourceReplyAdmission(message, sessionKey);
    return /^agent:[^:]+:slack:(?:channel|group):/.test(sessionKey) &&
      MATRIX_USER_ID.test(sender) &&
      allowed !== undefined
      ? { requester_matrix_user_id: sender }
      : undefined;
  };
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
    const prefix = `agent:${adminAgentId.toLowerCase()}:`;
    const requester = inboundRequester(sessionKey, message);
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
      const allowed = sourceReplyAdmission(message, sessionKey);
      return allowed && typeof message.isGroup === "boolean" && message.messageId?.startsWith("$")
        ? {
            sender,
            eventId: message.messageId,
            sourceRoomId: allowed.roomId,
            sourceMatrixUserId: requester.requester_matrix_user_id,
            // Only a configured Matrix account names the Fi environment; a Slack
            // account the host may report for the session never does.
            sourceAccountId: allowed.accountId,
          }
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
            0,
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
        forgetProjectedMatrixRun(event.runId);
      }
    },
  });
  api.lifecycle.registerRuntimeLifecycle({
    id: "admin-delegation-turns",
    dispose: reset,
    cleanup: ({ runId, sessionKey }) => {
      if (runId) {
        runs.delete(runId);
        forgetProjectedMatrixRun(runId);
      } else if (sessionKey) {
        const key = sessionKey.toLowerCase();
        arrivals.delete(key);
        fiUserReplies.delete(key);
        fiUserTainted.delete(key);
        forgetProjectedMatrixSession(key);
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
      if (agentId === FI_USER_AGENT_ID && sessionKey && runId) {
        // Only the run of the exact verified event, by that same person, in its room.
        const origin = context.channelContext;
        const eventId = typeof origin?.chat?.eventId === "string" ? origin.chat.eventId : undefined;
        const replies = fiUserReplies.get(sessionKey);
        const reply = eventId ? replies?.get(eventId) : undefined;
        // A run takes up everything queued for the session so far.
        const tainted = fiUserTainted.delete(sessionKey);
        if (eventId) {
          replies?.delete(eventId);
        }
        if (
          reply &&
          !tainted &&
          context.trigger === "user" &&
          context.senderId?.trim() === reply.matrixUserId &&
          origin?.sender?.id === reply.matrixUserId &&
          origin.sender.isBot !== true &&
          origin.chat?.id === reply.roomId
        ) {
          rememberProjectedMatrixRun(runId, {
            sessionKey,
            matrixUserId: reply.matrixUserId,
            ...(reply.accountId ? { accountId: reply.accountId } : {}),
          });
        }
        return undefined;
      }
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
      const continuation = context.requesterContinuation;
      if (continuation) {
        run.continuation = continuation;
        const requester = onBehalfOfRequester(continuation);
        if (requester && continuation.sourceTurnId && continuationCurrent(run, context)) {
          run.sender = JSON.stringify(requester);
        }
        diagnose({ runId, sessionKey }, run.sender ? "turn-admitted" : "turn-unproven");
        return undefined;
      }
      // A Fi shadow hook carries an attestation Fi minted for one member.
      if (context.trigger === "cron") {
        const shadow = shadowWakeAttestation(
          sessionKey,
          context.trigger,
          context.hookRequesterAttestation,
        );
        if (shadow) {
          run.shadowAttestation = shadow;
          run.sender = JSON.stringify(SHADOW_REQUESTER);
          diagnose({ runId, sessionKey }, "turn-admitted");
          return undefined;
        }
      }
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
      // Shared conversations admit only the run of the dispatched native event,
      // by that same sender. Never reuse the stored sender on a synthetic wake.
      const origin = context.channelContext;
      const rest = sessionKey.slice(`agent:${agentId}:`.length);
      const originEventId =
        typeof origin?.chat?.eventId === "string" ? origin.chat.eventId : undefined;
      // The host reports a Slack session's channel for a run its Matrix
      // projection started. The verified dispatch of that very event names the
      // Matrix person; the run's own sender must be that person.
      const sourceOrigin =
        originEventId && rest.startsWith("slack:")
          ? arrived?.sourceSenders.get(originEventId)
          : undefined;
      const requester =
        onBehalfOfRequester({ channel: context.channel, senderId: context.senderId }) ??
        (sourceOrigin && context.senderId?.trim() === sourceOrigin.matrixUserId
          ? { requester_matrix_user_id: sourceOrigin.matrixUserId }
          : undefined);
      const sender = requester && JSON.stringify(requester);
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
        if (sourceReply && sourceOrigin) {
          run.matrixOrigin = {
            matrixUserId: sourceOrigin.matrixUserId,
            ...(sourceOrigin.accountId ? { accountId: sourceOrigin.accountId } : {}),
          };
        }
        // Dispatch can queue several native events before the first run starts.
        // Consume only this run's exact event; later runs need their own proof.
        if (requiresEvent && typeof origin?.chat?.eventId === "string") {
          arrived.events.delete(origin.chat.eventId);
          arrived.sourceRooms.delete(origin.chat.eventId);
          arrived.sourceSenders.delete(origin.chat.eventId);
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
        sourceSenders: new Map(),
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
      if (proof.sourceMatrixUserId) {
        arrived.sourceSenders.set(proof.eventId, {
          matrixUserId: proof.sourceMatrixUserId,
          ...(proof.sourceAccountId ? { accountId: proof.sourceAccountId } : {}),
        });
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
    fiUserInbound(message, true);
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
    fiUserInbound(message, false);
    const session = adminSession(message);
    if (!session) {
      return;
    }
    // A retained task's authority does not cover additional injected instructions,
    // even when the injection repeats the original person's asserted sender id.
    for (const run of runs.values()) {
      if (run.continuation && run.sessionKey === session.sessionKey.toLowerCase()) {
        delete run.sender;
      }
    }
    // Only channel input can be the allowed Matrix person here; a sender id
    // another caller supplies (a hook, a client) still counts as someone else.
    const requester =
      message.channel === "matrix" || message.channel === "slack"
        ? inboundRequester(session.sessionKey, message)
        : onBehalfOfRequester(message);
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
    return run?.agentId === agentId &&
      run.sessionKey === sessionKey &&
      run.sender === holder.sender &&
      continuationCurrent(run, ctx)
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
    const operatorProof = admittedOperatorCommand(ctx);
    const operatorRequested =
      config.operatorAgentId === "cellect-main" &&
      !config.tenantOrgId &&
      ON_BEHALF_OF_TOOLS.has(event.toolName) &&
      typeof event.params.command === "string" &&
      operationCommandArgs(event.params.command) !== undefined;
    if (config.operatorAgentId === "cellect-main" && !operatorRequested) {
      return undefined;
    }
    if (
      !agentId ||
      (!config.tenantOrgId && !operatorProof) ||
      !isAdminAgent(config, agentId) ||
      !ON_BEHALF_OF_TOOLS.has(event.toolName) ||
      event.toolKind ||
      ctx.toolKind ||
      !runsInSandbox(event.params) ||
      !ctx.sessionKey ||
      // An approved admin action keeps today's attribution; it is not this turn's requester.
      adminActionSessions.has(ctx.sessionKey) ||
      !posture(agentId).pinIsHarmless ||
      // Talk never borrows a typed run's sender: only the native owner admits this exception.
      (posture(agentId).servesTalk && !operatorProof)
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
      return operatorRequested ? Promise.resolve(operationCommandFailure()) : undefined;
    }
    const sessionKey = ctx.sessionKey.toLowerCase();
    const run = ctx.runId ? runs.get(ctx.runId) : undefined;
    const mail = mailWakeRequester(sessionKey, ctx.requester?.senderId);
    const requester: OnBehalfOfRequester | ShadowRequester | undefined = run?.shadowAttestation
      ? SHADOW_REQUESTER
      : (mail ??
        onBehalfOfRequester(run?.continuation ?? ctx.requester) ??
        matrixOriginRequester(run, ctx.requester?.senderId));
    const suppliedRequester = onBehalfOfRequester(ctx.requester);
    const sender = requester && JSON.stringify(requester);
    if (
      !run ||
      !requester ||
      !sender ||
      run.agentId !== agentId ||
      run.sessionKey !== sessionKey ||
      !sessionKey.startsWith(`agent:${agentId}:`) ||
      run.sender !== sender ||
      !continuationCurrent(run, ctx) ||
      (run.continuation && suppliedRequester && JSON.stringify(suppliedRequester) !== sender) ||
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
      return operatorRequested ? Promise.resolve(operationCommandFailure()) : undefined;
    }
    let body: Record<string, string>;
    let connection: Pick<ResolvedPluginConfig, "baseUrl" | "brokerTokenEnv"> | undefined;
    if ("requester_slack_user_id" in requester) {
      body = { requesterSenderId: requester.requester_slack_user_id };
      connection = config;
    } else if ("requester_matrix_user_id" in requester) {
      body = { requesterMatrixUserId: requester.requester_matrix_user_id };
      // A source-session reply names its Matrix account at dispatch; the tool
      // context may carry the Slack session's account instead.
      const originAccount = run.matrixOrigin?.accountId;
      // A run admitted from a source-session reply uses that reply's own Matrix
      // account, or the tool's only when the host labels the call Matrix; a
      // Slack account reported for the session never selects the environment.
      const toolMatrixAccount =
        ctx.requester?.channel === "matrix" ? ctx.requester.accountId : undefined;
      connection = run.matrixOrigin
        ? originAccount && toolMatrixAccount !== undefined && toolMatrixAccount !== originAccount
          ? undefined
          : matrixConnection(config, originAccount ?? toolMatrixAccount)
        : matrixConnection(config, run.continuation?.accountId ?? ctx.requester?.accountId);
    } else if ("requester_shadow" in requester && run.shadowAttestation) {
      body = { shadowAttestation: run.shadowAttestation };
      connection = config;
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
      return operatorRequested
        ? Promise.resolve(operationCommandFailure())
        : crossEnvironmentFailure
          ? Promise.resolve(crossEnvironmentFailure)
          : undefined;
    }
    // Raw shell work can persist an environment credential in arbitrary files.
    // Do not issue it a token and then reserve the entire thread until expiry.
    // The maintained command's no-persistence contract and native cleanup identity
    // are both required before asking Fi to mint a command credential.
    const pinnedCommand = posture(agentId).readonlyCli
      ? pinInstalledFiCliCommand(event.params)
      : undefined;
    const runId = ctx.runId,
      toolCallId = ctx.toolCallId;
    const key = runId && toolCallId && JSON.stringify([runId, toolCallId]);
    if (pinnedCommand === undefined || !key || !runId || !toolCallId) {
      return operatorRequested
        ? Promise.resolve(operationCommandFailure())
        : crossEnvironmentFailure
          ? Promise.resolve(crossEnvironmentFailure)
          : undefined;
    }
    const canTrack = () => {
      const calls = custody.get(sandboxKey(agentId, sessionKey))?.calls;
      return !calls?.has(key) && (calls?.size ?? 0) < MAX_TRACKED;
    };
    if (!canTrack()) {
      return operatorRequested
        ? Promise.resolve(operationCommandFailure())
        : crossEnvironmentFailure
          ? Promise.resolve(crossEnvironmentFailure)
          : undefined;
    }
    const budget = Math.min(MAX_MINT_MS, HOOK_BUDGET_MS - (Date.now() - enteredAt));
    if (budget < MIN_MINT_MS) {
      diagnose(ctx, "mint-budget-exhausted");
      return operatorRequested
        ? Promise.resolve(operationCommandFailure())
        : crossEnvironmentFailure
          ? Promise.resolve(crossEnvironmentFailure)
          : undefined;
    }
    const baseUrl = connection.baseUrl;
    const sandbox = sandboxKey(agentId, sessionKey);
    const issued = operatorProof
      ? requestOperationCommandReceipt({
          turn: operatorProof,
          command: pinnedCommand,
          runId,
          toolCallId,
          connection,
          signal: AbortSignal.any([
            AbortSignal.timeout(budget),
            operatorProof.authorization.signal,
            ...(ctx.abortSignal ? [ctx.abortSignal] : []),
          ]),
          assertCurrent: () => {
            if (
              admittedOperatorCommand(ctx) !== operatorProof ||
              runs.get(ctx.runId ?? "") !== run ||
              run.sender !== sender
            ) {
              throw new Error("Native command requester changed");
            }
          },
        })
      : lookupDelegation({ ...config, ...connection }, body, {
          agentId: FI_ADMIN_DELEGATION_AGENT_ID,
          signal: AbortSignal.timeout(budget),
        }).then((delegation) =>
          delegation
            ? { token: delegation.fi?.token, expiresAt: delegation.fi?.expiresAt }
            : undefined,
        );
    return issued.then(
      (credential) => {
        // Other operator commands retain their existing execution path.
        if (operatorProof && !credential) {
          return undefined;
        }
        const token: unknown = credential?.token;
        const expiresAt: unknown = credential?.expiresAt;
        const now = Date.now();
        if (
          typeof token !== "string" ||
          !JWT.test(token) ||
          typeof expiresAt !== "number" ||
          expiresAt * 1000 - now < MIN_REMAINING_SECONDS * 1000 ||
          expiresAt * 1000 - now > (operatorProof ? 120_000 : MAX_HOLD_MS) ||
          ctx.abortSignal?.aborted ||
          runs.get(ctx.runId ?? "") !== run ||
          run.sender !== sender ||
          !posture(agentId).pinIsHarmless ||
          (operatorProof && admittedOperatorCommand(ctx) !== operatorProof) ||
          !continuationCurrent(run, ctx) ||
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
          return operatorProof ? operationCommandFailure() : crossEnvironmentFailure;
        }
        // Someone else's token may have reached this sandbox while Fi answered:
        // the call must then wait like any other, not run without a token.
        const blocked = held(config, event.toolName, ctx);
        if (blocked) {
          diagnose(ctx, "mint-held");
          return blocked;
        }
        if (!canTrack()) {
          return operatorProof ? operationCommandFailure() : crossEnvironmentFailure;
        }
        // Expiry is a fallback, not a minimum hold: native descendant cleanup
        // releases only this exact call, never another still-running command.
        const holder = custody.get(sandbox) ?? {
          sender,
          expiresAt: 0,
          calls: new Map(),
        };
        const expiry = Math.min(expiresAt * 1000, now + MAX_HOLD_MS);
        holder.calls.set(key, { agentId, sessionKey: ctx.sessionKey!, expiresAt: expiry });
        holder.expiresAt = Math.max(holder.expiresAt, expiry);
        remember(custody, sandbox, holder);
        diagnose(ctx, "mint-issued");
        return {
          token,
          baseUrl,
          command: pinnedCommand,
          ...(operatorProof ? { operationReceipt: true as const } : {}),
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
        return operatorProof ? operationCommandFailure() : crossEnvironmentFailure;
      },
    );
  };

  /**
   * The person this Fi-admin tool call's run was proven to act for, and the Fi
   * that answers for them: the same proof a sandbox command needs for its
   * token, for a Fi call the plugin makes itself. Nothing when unproven.
   */
  const provenToolRequester: RequesterProofReader = (ctx) => {
    const config = configFromRuntime(api);
    const agentId = ctx.agentId?.toLowerCase();
    const sessionKey = ctx.sessionKey?.toLowerCase();
    const run = ctx.runId ? runs.get(ctx.runId) : undefined;
    const channel = run?.continuation ?? {
      channel: ctx.messageChannel,
      senderId: ctx.requesterSenderId,
    };
    const requester =
      onBehalfOfRequester(channel) ?? matrixOriginRequester(run, ctx.requesterSenderId);
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
      (run.continuation &&
        !continuationCurrent(run, {
          runId: ctx.runId,
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
          sessionId: run.continuation.sessionId,
          requesterContinuation: run.continuation,
        })) ||
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
    const matrix = run.matrixOrigin
      ? matrixConnection(
          config,
          run.matrixOrigin.accountId ??
            (ctx.messageChannel === "matrix" ? ctx.agentAccountId : undefined),
        )
      : matrixConnection(config, run.continuation?.accountId ?? ctx.agentAccountId);
    return matrix
      ? {
          connection: { ...config, ...matrix, baseUrl: matrix.baseUrl.replace(/\/+$/, "") },
          body: { requesterMatrixUserId: requester.requester_matrix_user_id },
        }
      : undefined;
  };

  return { dispatched, received, held, mint, provenToolRequester };
}
