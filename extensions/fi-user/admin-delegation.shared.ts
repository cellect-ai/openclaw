import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { PluginHookToolContext } from "openclaw/plugin-sdk/types";
import type { MatrixEntitlements } from "./matrix-entitlements.js";
import { type OnBehalfOfRequester, type TalkChannelContext } from "./on-behalf-of.js";

/**
 * The host gives every before_tool_call handler 15 s in all, and the Matrix
 * grant check that runs first may take 12 s of it. Fi is asked only with what
 * is left of 13 s, never for more than 8 s, and not at all with under half a
 * second. A selected Matrix environment that differs from the sandbox default
 * cannot fall back to that default when its token cannot be issued.
 */
export const HOOK_BUDGET_MS = 13_000;

export const MAX_MINT_MS = 8_000;

export const MIN_MINT_MS = 500;

/** The requester-line lookup at prompt build: a turn never waits long for it. */
export const REQUESTER_LINE_MINT_MS = 3_000;

/** A token this close to expiry is not handed to a command. */
export const MIN_REMAINING_SECONDS = 60;

/** Sessions, runs and sandboxes remembered at once; the oldest is dropped. */
export const MAX_TRACKED = 5_000;

/**
 * How long what arrived for a session waits for a message run to take it up.
 * Far longer than any run a queued message waits behind; a Matrix run must
 * also match one of the remembered events, so forgetting only refuses.
 */
export const ARRIVAL_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * How long after an unproven run settles its "send it again" notice waits. A
 * message the host queued instead of steering into that run starts its own
 * run within this time, and then no notice is sent.
 */
export const NOTICE_GRACE_MS = 30_000;

/** Fi's source-reply check runs as the Matrix event is received, just before it is dispatched. */
export const SOURCE_REPLY_TTL_MS = 5 * 60 * 1000;

/**
 * Fi's tokens live ten minutes. One that claims more than this is refused, and
 * no sandbox is held for longer on any answer's say-so.
 */
export const MAX_HOLD_MS = 15 * 60 * 1000;

/**
 * Shown to whoever reaches a sandbox that still holds another person's token:
 * when it frees, never whose it is. "Retry later" with no time made agents
 * retry in a loop; a stated time lets them tell the person and stop.
 */
export function heldCopy(expiresAtMs: number): string {
  const until = new Date(Math.ceil(expiresAtMs / 60_000) * 60_000);
  const hhmm = `${String(until.getUTCHours()).padStart(2, "0")}:${String(until.getUTCMinutes()).padStart(2, "0")}`;
  return `This sandbox is held by another person's command until ~${hhmm} UTC (at most 15 minutes). Tell the person; do not retry before then.`;
}

export const UNPROVEN_HOLD =
  "This run has no verified requester proof for the sandbox's retained command state. A fresh authenticated message is required; this does not indicate another command is running.";

/**
 * The tools that reach the sandbox's processes or files: the host's sandbox
 * tool list (`DEFAULT_TOOL_ALLOW` in src/agents/sandbox/constants.ts) without
 * its session tools, and the Codex names for exec and process.
 */
export const SANDBOX_TOOLS = new Set([
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

export const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export const UNPROVEN = "unproven";

export const MATRIX_USER_ID = /^@[^\s:]+:[^\s]+$/;

export type DelegationDiagnosticReason =
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

export type Arrivals = {
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

export type Proof = {
  sender: string;
  eventId?: string;
  sourceRoomId?: string;
  sourceMatrixUserId?: string;
  sourceAccountId?: string;
};

/**
 * A run admitted for a verified Matrix reply in a Slack source session's projection.
 * `roomId` and `eventId` are the source guard's event. Fi requires that event on a
 * Matrix mint, and a Slack session never records an entitlement turn for it.
 */
export type MatrixOrigin = {
  matrixUserId: string;
  accountId?: string;
  roomId: string;
  eventId: string;
};

/** Who a sandbox last ran a token-bearing command for, and until when that token lives. */
export type Custody = {
  sender: string;
  expiresAt: number;
  calls: Map<string, { sessionKey: string; agentId: string; expiresAt: number }>;
  /**
   * The Fi-minted subject of the holder's tokens (crossChannelCustody only).
   * Absent, or once two of its mints disagree: no other channel identity matches it.
   */
  subject?: string;
};

export type Held = { block: true; blockReason: string };

export type NoticeRoute = {
  channel: string;
  to: string;
  threadId?: string | number;
  accountId?: string;
  /** The channel event the notice is about, so a message the host queued can retract it. */
  messageId?: string;
};

/** Told, at most once per run, to whoever wrote into a run that cannot act for them. */
export const INJECTED_NOTICE =
  "I couldn't act on that while another task was running. Please send it again.";

/**
 * Who Fi minted a token for: its subject and org, read from the token Fi just
 * returned, which is the same token the command then presents to Fi. Anything
 * unreadable is no subject.
 */
export function tokenSubject(token: string): string | undefined {
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    if (!isRecord(payload)) {
      return undefined;
    }
    const { sub, org_slug: org } = payload;
    return typeof sub === "string" && sub.trim() && typeof org === "string" && org
      ? JSON.stringify([sub.trim().toLowerCase(), org])
      : undefined;
  } catch {
    return undefined;
  }
}

/** Set `key` as the newest entry, dropping the oldest ones past the cap. */
export function remember<V>(tracked: Map<string, V>, key: string, value: V): void {
  tracked.delete(key);
  tracked.set(key, value);
  for (const oldest of tracked.keys()) {
    if (tracked.size <= MAX_TRACKED) {
      break;
    }
    tracked.delete(oldest);
  }
}

export type Run = {
  agentId: string;
  /**
   * Counts every input that tried to take this run's proof, even one that found it already gone,
   * so a proof taken for a message the host then queued is given back only if nothing else was
   * injected into the run since.
   */
  stripSeq?: number;
  sessionKey: string;
  sender?: string;
  continuation?: PluginHookToolContext["requesterContinuation"];
  voice?: ReturnType<MatrixEntitlements["admittedVoiceTurn"]>;
  matrixOrigin?: MatrixOrigin;
  /** Where to tell the first person whose input was written into this run. */
  notice?: NoticeRoute;
};

/**
 * The Matrix requester of a run admitted from a verified source-session reply,
 * when the host names that run's sender but reports the session's own channel.
 * Only the exact admitted sender qualifies; a continuation keeps its own proof.
 */
export function matrixOriginRequester(
  run: Run | undefined,
  senderId: string | undefined,
): OnBehalfOfRequester | undefined {
  const origin = run?.matrixOrigin;
  return origin && !run.continuation && senderId?.trim() === origin.matrixUserId
    ? { requester_matrix_user_id: origin.matrixUserId }
    : undefined;
}

const SOURCE_TURN_ROOM = /^![^\s:]+(?::\S+)?$/;
const SOURCE_TURN_EVENT = /^\$\S+$/;

/**
 * The admitted Matrix event of a source-session run, for a Fi mint.
 * Entitlement turns are skipped for these sessions, so without this Fi
 * answers `turn_required` and the command never runs. `markBrief` is a no-op:
 * Fi still binds a Desk brief to the event, and this session has no
 * entitlement turn to raise.
 */
export function matrixOriginTurn(
  run: Run | undefined,
): { roomId: string; eventId: string; senderId: string; markBrief(): void } | undefined {
  const origin = run?.matrixOrigin;
  if (
    !origin ||
    run.continuation ||
    !SOURCE_TURN_ROOM.test(origin.roomId) ||
    origin.roomId.length > 256 ||
    !SOURCE_TURN_EVENT.test(origin.eventId) ||
    origin.eventId.length > 256
  ) {
    return undefined;
  }
  return {
    roomId: origin.roomId,
    eventId: origin.eventId,
    senderId: origin.matrixUserId,
    markBrief() {},
  };
}

/** Every use retains the exact host capability; copied identity fields prove nothing. */
export function continuationCurrent(
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

export type Inbound = {
  channel?: string;
  senderId?: string;
  senderAuthentication?: "verified" | "asserted";
  /** False only when the channel itself classified the conversation as one person's. */
  isGroup?: boolean;
  /** The channel's own id of the dispatched message: for Matrix, the room event. */
  messageId?: string;
  /** The channel account that received it, as the host routed it. */
  accountId?: string;
  /** Where the host would reply to it, and in which thread. */
  conversationId?: string;
  threadId?: string | number;
  sessionKey?: string;
  /**
   * Host-owned channel identity. A Matrix Talk consult the Gateway dispatches
   * names its attested speaker and thread here; chat.send input cannot set it.
   */
  channelContext?: TalkChannelContext;
};
