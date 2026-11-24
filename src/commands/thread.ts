// Slack thread inspection uses native Gateway state. Continuation is conditional
// on a server-validated terminal snapshot and the exact native input commit.
import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { GATEWAY_CLIENT_MODES } from "../../packages/gateway-protocol/src/client-info.js";
import type {
  ThreadContinuationDescription,
  ThreadContinuationSnapshot,
} from "../../packages/gateway-protocol/src/schema/thread-continuation.js";
import { callGateway } from "../gateway/call.js";
import type { GatewaySessionRow, SessionsListResult } from "../gateway/session-utils.types.js";
import type { RuntimeEnv } from "../runtime.js";

export type SlackThreadRef = {
  permalink: string;
  channelId: string;
  threadTs: string;
  sessionSuffix: string;
};
function slackPathTimestamp(value: string): string {
  if (!/^\d{11,}$/u.test(value)) {
    throw new Error("Slack permalink message timestamp is invalid.");
  }
  return `${value.slice(0, -6)}.${value.slice(-6)}`;
}

export function parseSlackThreadPermalink(raw: string): SlackThreadRef {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Expected a full Slack permalink URL.");
  }
  const match = /^\/archives\/([^/]+)\/p(\d+)\/?$/u.exec(url.pathname);
  if (!match) {
    throw new Error("Expected a Slack permalink path like /archives/<channel>/p<timestamp>.");
  }
  const channelId = match[1]?.toUpperCase();
  const messageTimestamp = match[2];
  if (!channelId || !messageTimestamp) {
    throw new Error("Slack permalink is missing its channel or message timestamp.");
  }
  const threadTs =
    normalizeOptionalString(url.searchParams.get("thread_ts")) ??
    slackPathTimestamp(messageTimestamp);
  if (!/^\d+\.\d+$/u.test(threadTs)) {
    throw new Error("Slack permalink thread_ts is invalid.");
  }
  const sessionSuffix = `:slack:channel:${channelId.toLowerCase()}:thread:${threadTs}`;
  return { permalink: url.toString(), channelId, threadTs, sessionSuffix };
}

export async function inspectThread(rawPermalink: string) {
  const ref = parseSlackThreadPermalink(rawPermalink);
  const roster = await callGateway<SessionsListResult>({
    method: "sessions.list",
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    params: {
      search: ref.sessionSuffix,
      limit: 128,
      archived: "all",
      includeGlobal: false,
      includeUnknown: false,
    },
  });
  if (
    roster.hasMore ||
    (roster.totalCount ?? roster.sessions.length) > roster.sessions.length ||
    roster.nextOffset != null
  ) {
    throw new Error("Thread session discovery is incomplete; no continuation can be queued.");
  }
  const owners = roster.sessions.filter((row: GatewaySessionRow) =>
    row.key.endsWith(ref.sessionSuffix),
  );
  const observations: ThreadContinuationDescription[] = [];
  for (const owner of owners) {
    const response = await callGateway<{ threadContinuation: ThreadContinuationDescription }>({
      method: "sessions.describe",
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      params: { key: owner.key, agentId: owner.agentId, includeThreadContinuation: true },
    });
    if (!response.threadContinuation)
      throw new Error("Gateway did not return a native thread observation.");
    observations.push(response.threadContinuation);
  }
  const members = observations.flatMap((observation) => observation.members);
  const complete = observations.every((observation) => observation.complete);
  const statuses = observations.map((observation) => observation.status);
  const status = owners.length === 1 ? statuses[0] : undefined;
  const latestTask = status?.latestTask ?? null;
  const owner =
    owners.length === 1
      ? members.find(
          (member) => member.sessionKey === owners[0]?.key && member.agentId === owners[0]?.agentId,
        )
      : undefined;
  return {
    ref,
    permalink: ref.permalink,
    channelId: ref.channelId,
    threadTs: ref.threadTs,
    agentId: latestTask?.agentId ?? owner?.agentId ?? null,
    sessionKey: latestTask?.ownerKey ?? owner?.sessionKey ?? null,
    sessionExists: owners.length > 0,
    sessionUpdatedAt: owner?.updatedAt ?? null,
    lastTool: status?.lastTool ?? null,
    lastToolAt: status?.lastToolAt ?? null,
    lastError: status?.lastError ?? null,
    latestTask,
    taskCount: status?.taskCount ?? null,
    historyAvailable: status?.historyAvailable ?? false,
    historyComplete: status?.historyComplete ?? false,
    historyScope: "retained-terminal-observations" as const,
    currentTerminalCoverageComplete: status?.currentTerminalCoverageComplete ?? false,
    transcriptComplete: status?.transcriptComplete ?? false,
    members,
    complete,
    active: members.some((member) => member.status === "running" || member.status === "queued"),
    recoveryPending: members.some((member) => member.recoveryPending),
    continuation: owners.length === 1 && complete ? observations[0]?.continuation : undefined,
    originalTask: owners.length === 1 && complete ? observations[0]?.originalTask : undefined,
    reason:
      owners.length > 1
        ? "More than one agent owns this thread; continuation is ambiguous."
        : (observations[0]?.reason ??
          (owners.length === 0 ? "No native session is recorded for this thread." : undefined)),
  };
}
export async function threadStatusCommand(
  opts: { permalink: string; json?: boolean },
  runtime: RuntimeEnv,
) {
  const state = await inspectThread(opts.permalink);
  if (opts.json) {
    runtime.log(JSON.stringify(state, null, 2));
    return;
  }
  runtime.log(`Slack thread ${state.ref.channelId}/${state.ref.threadTs}`);
  runtime.log(`agent: ${state.agentId ?? "unknown"}`);
  runtime.log(`session: ${state.sessionExists ? (state.sessionKey ?? "ambiguous") : "missing"}`);
  runtime.log(`active: ${state.active ? "yes" : "no"}`);
  runtime.log(
    `latest task: ${state.latestTask ? `${state.latestTask.taskId} (${state.latestTask.status})` : state.historyAvailable && state.historyComplete ? "none" : "unknown"}`,
  );
  runtime.log(
    `last activity: ${state.latestTask?.lastEventAt ?? state.sessionUpdatedAt ?? "unknown"}`,
  );
  runtime.log(`last tool: ${state.lastTool ?? "unknown"}`);
  runtime.log(
    `last error: ${state.lastError ?? (state.historyComplete && state.transcriptComplete ? "none" : "unknown")}`,
  );
  if (!state.historyAvailable) runtime.log("task history: unavailable");
  else if (!state.historyComplete)
    runtime.log("task history: incomplete (retained current-session observations only)");
  runtime.log("task count and latest task describe retained terminal observations");
  if (!state.transcriptComplete)
    runtime.log("transcript history: incomplete (bounded current-session tail)");
  for (const member of state.members)
    runtime.log(
      `${member.agentId} ${member.sessionKey}: ${member.status}${member.recoveryPending ? " (recovery pending)" : ""}${member.terminalRunId ? ` [${member.terminalRunId}]` : ""}`,
    );
  if (state.reason) runtime.log(state.reason);
}
function resumeId(snapshot: ThreadContinuationSnapshot) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "thread-resume",
        snapshot.owner.agentId,
        snapshot.owner.sessionKey,
        snapshot.owner.sessionId,
        snapshot.owner.lifecycleRevision,
        snapshot.failedSessionKey,
        snapshot.failedRunId,
      ]),
    )
    .digest("hex");
}
export async function threadResumeCommand(
  opts: { permalink: string; json?: boolean },
  runtime: RuntimeEnv,
) {
  const state = await inspectThread(opts.permalink);
  const snapshot = state.continuation;
  if (
    !snapshot ||
    !state.originalTask ||
    state.active ||
    state.recoveryPending ||
    !state.complete
  ) {
    runtime.error(
      `${state.reason ?? "Thread has active, queued, recovery, or unknown work."} No continuation was queued.`,
    );
    runtime.exit(2);
    return;
  }
  const idempotencyKey = resumeId(snapshot);
  const response = await callGateway({
    method: "agent",
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    params: {
      message: [
        "Resume and finish the prior task in this exact Slack thread.",
        "Re-read the thread root and bounded reply history before acting; do not stop at a progress-only message.",
        `Prior failed native run: ${snapshot.failedRunId}.`,
        "Original triggering context:",
        state.originalTask,
      ].join("\n\n"),
      agentId: snapshot.owner.agentId,
      sessionKey: snapshot.owner.sessionKey,
      expectedExistingSessionId: snapshot.owner.sessionId,
      expectedExistingSessionLifecycleRevision: snapshot.owner.lifecycleRevision,
      expectedThreadContinuation: snapshot,
      channel: "slack",
      replyChannel: "slack",
      replyTo: state.ref.channelId,
      threadId: state.ref.threadTs,
      deliver: true,
      bestEffortDeliver: false,
      timeout: 3600,
      idempotencyKey,
    },
    expectFinal: false,
    timeoutMs: 15_000,
  });
  const payload = {
    ok: true,
    resumedFromTaskId: snapshot.failedRunId,
    agentId: snapshot.owner.agentId,
    sessionKey: snapshot.owner.sessionKey,
    idempotencyKey,
    response,
  };
  runtime.log(
    opts.json
      ? JSON.stringify(payload, null, 2)
      : `Queued one conditional continuation for ${snapshot.failedRunId} in ${snapshot.owner.sessionKey}.`,
  );
}
