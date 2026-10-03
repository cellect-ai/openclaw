// Slack-thread operator commands map a permalink to durable session/task state
// and enqueue at most one continuation for the latest terminal failure.

import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/config.js";
import { resolveAllAgentSessionStoreTargetsSync, type SessionEntry } from "../config/sessions.js";
import {
  listSessionEntriesReadOnly,
  loadTranscriptEventsSync,
} from "../config/sessions/session-accessor.js";
import { callGateway } from "../gateway/call.js";
import type { RuntimeEnv } from "../runtime.js";
import { extractEditorText } from "../config/sessions/session-message-cut-content.js";
import { isMainSessionRecoveryPending } from "../agents/main-session-recovery/main-session-recovery-state.js";
import {
  listSessionStateEventsSince,
  type SessionStateEventRecord,
} from "../sessions/session-state-events.js";

// 9.8 port of the 9.6 task-registry inspection (src/tasks removed upstream in
// 9.7): thread tasks are reconstructed from the maintained session-state
// event log. run_completed/run_failed events carry runId + outcome payloads
// and are the terminal records. Liveness comes only from the native
// SessionEntry.status live flag (never the observer digest, which is
// explicitly reconstructible and never authoritative task status, and never a
// recency threshold: a genuine long job must not look lost). Unknown or
// superseded states fail closed: resume fires only when a terminal failure is
// the latest meaningful signal for the owning thread session. Original task
// context is the complete triggering user message from the transcript; the
// registry text is gone with src/tasks.
type ThreadTask = {
  taskId: string;
  status: string;
  agentId?: string;
  ownerKey: string;
  requesterSessionKey: string;
  childSessionKey?: string;
  createdAt: number;
  lastEventAt?: number;
  error?: string;
  task: string;
};

function threadTaskFromRunEvent(
  event: SessionStateEventRecord,
  sessionKey: string,
): ThreadTask | undefined {
  if (event.kind !== "run_completed" && event.kind !== "run_failed") {
    return undefined;
  }
  const outcome =
    typeof event.payload?.outcome === "string" ? event.payload.outcome : undefined;
  const status =
    event.kind === "run_completed"
      ? "succeeded"
      : outcome === "timeout"
        ? "timed_out"
        : outcome === "cancelled"
          ? "cancelled"
          : "failed";
  return {
    taskId: event.runId ?? `event:${event.sequence}`,
    status,
    agentId: event.agentId,
    ownerKey: sessionKey,
    requesterSessionKey: sessionKey,
    createdAt: event.occurredAt,
    lastEventAt: event.occurredAt,
    ...(event.kind === "run_failed"
      ? { error: outcome ? `${event.summary} (${outcome})` : event.summary }
      : {}),
    task: event.summary,
  };
}

const ACTIVE_TASK_STATUSES = new Set(["queued", "running"]);
const RESUMABLE_TASK_STATUSES = new Set(["failed", "timed_out", "lost"]);

export type SlackThreadRef = {
  permalink: string;
  channelId: string;
  threadTs: string;
  sessionSuffix: string;
};

export type ThreadSessionMatch = {
  agentId: string;
  sessionKey: string;
  storePath: string;
  entry: SessionEntry;
};

export type ThreadUserText = {
  text: string;
  at?: string;
};

type ThreadTranscriptTail = {
  lastTool?: string;
  lastToolAt?: string;
  lastError?: string;
  /** Newest-first user messages, complete text (replaces the registry task text). */
  userTexts: ThreadUserText[];
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

export type ThreadLiveness =
  | { live: true; reason: string }
  | { live: false; recoveryPending: boolean };

export function threadSessionLiveness(session: ThreadSessionMatch): ThreadLiveness {
  if (session.entry.status === "running") {
    if (isMainSessionRecoveryPending(session.entry, session.sessionKey)) {
      return { live: false, recoveryPending: true };
    }
    return { live: true, reason: "session entry status is running" };
  }
  return { live: false, recoveryPending: false };
}

/**
 * All state events for one session, oldest-first. Pages the ASC/capped reader
 * to the tail so a new success is never outranked by an old failure past the
 * cap.
 */
export function listThreadSessionEvents(
  session: ThreadSessionMatch,
  limit = 200,
): SessionStateEventRecord[] {
  const events: SessionStateEventRecord[] = [];
  let afterSequence = 0;
  for (let page = 0; page < 5; page += 1) {
    const result = listSessionStateEventsSince(
      session.sessionKey,
      session.agentId,
      afterSequence,
      limit,
    );
    events.push(...result.events);
    if (!result.truncated || result.events.length === 0) {
      break;
    }
    afterSequence = result.events[result.events.length - 1]?.sequence ?? afterSequence;
  }
  return events;
}

export function tasksForThread(
  _ref: SlackThreadRef,
  sessions: ThreadSessionMatch[],
): ThreadTask[] {
  const tasks: ThreadTask[] = [];
  for (const session of sessions) {
    for (const event of listThreadSessionEvents(session)) {
      const task = threadTaskFromRunEvent(event, session.sessionKey);
      if (task) {
        tasks.push(task);
      }
    }
    if (threadSessionLiveness(session).live) {
      const at = session.entry.updatedAt ?? Date.now();
      tasks.push({
        taskId: `live:${session.sessionKey}`,
        status: "running",
        agentId: session.agentId,
        ownerKey: session.sessionKey,
        requesterSessionKey: session.sessionKey,
        createdAt: at,
        lastEventAt: at,
        task: "live run per session entry status",
      });
    }
  }
  return tasks.toSorted(
    (left, right) => (right.lastEventAt ?? right.createdAt) - (left.lastEventAt ?? left.createdAt),
  );
}

function sessionsForThread(ref: SlackThreadRef): ThreadSessionMatch[] {
  const cfg = getRuntimeConfig();
  const matches: ThreadSessionMatch[] = [];
  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg)) {
    for (const { sessionKey, entry } of listSessionEntriesReadOnly({
      agentId: target.agentId,
      storePath: target.storePath,
      readConsistency: "latest",
    })) {
      // Match the thread session itself plus children spawned from it, recovering
      // the old registry's owner/requester/child matching on 9.8 keys.
      const spawnedBy = entry.spawnedBy ?? entry.parentSessionKey;
      if (
        !sessionKey.endsWith(ref.sessionSuffix) &&
        !(spawnedBy?.endsWith(ref.sessionSuffix) ?? false)
      ) {
        continue;
      }
      matches.push({
        agentId: target.agentId,
        sessionKey,
        storePath: target.storePath,
        entry,
      });
    }
  }
  return matches.toSorted((left, right) => right.entry.updatedAt - left.entry.updatedAt);
}

export async function readThreadTranscriptTail(
  session: ThreadSessionMatch | undefined,
): Promise<ThreadTranscriptTail> {
  if (!session?.entry.sessionId) {
    return { userTexts: [] };
  }
  const tail: ThreadTranscriptTail = { userTexts: [] };
  const events = loadTranscriptEventsSync({
    agentId: session.agentId,
    sessionId: session.entry.sessionId,
    sessionKey: session.sessionKey,
    storePath: session.storePath,
  }).slice(-200);
  for (const event of events.toReversed()) {
    const parsed = event as {
      timestamp?: string;
      message?: {
        role?: string;
        toolName?: string;
        errorMessage?: string;
        content?: Array<{
          toolName?: string;
          name?: string;
          isError?: boolean;
          content?: string;
        }>;
      };
    };
    const message = parsed.message;
    if (!tail.lastTool && message?.role === "toolResult") {
      const first = Array.isArray(message.content) ? message.content[0] : undefined;
      tail.lastTool = message.toolName ?? first?.toolName ?? first?.name;
      tail.lastToolAt = parsed.timestamp;
    }
    if (!tail.lastError) {
      const first = Array.isArray(message?.content) ? message.content[0] : undefined;
      if (message?.errorMessage) {
        tail.lastError = message.errorMessage;
      } else if (first?.isError && first.content) {
        tail.lastError = first.content.slice(0, 500);
      }
    }
    if (message?.role === "user" && tail.userTexts.length < 5) {
      const text = extractEditorText(
        (message as { content?: unknown; text?: unknown }).content ??
          (message as { text?: unknown }).text,
      )
        ?.replace(/\s+/g, " ")
        .trim();
      if (text) {
        tail.userTexts.push({ text, ...(parsed.timestamp ? { at: parsed.timestamp } : {}) });
      }
    }
    if (tail.lastTool && tail.lastError && tail.userTexts.length >= 5) {
      break;
    }
  }
  return tail;
}

export async function inspectThread(rawPermalink: string, sessions?: ThreadSessionMatch[]) {
  const ref = parseSlackThreadPermalink(rawPermalink);
  const matches = sessions ?? sessionsForThread(ref);
  const tasks = tasksForThread(ref, matches);
  const latestTask = tasks[0];
  const session = matches[0];
  const transcript = await readThreadTranscriptTail(session);
  return {
    ref,
    tasks,
    sessions: matches,
    latestTask,
    session,
    transcript,
    active: tasks.some((task) => ACTIVE_TASK_STATUSES.has(task.status)),
  };
}

export async function threadStatusCommand(
  opts: { permalink: string; json?: boolean },
  runtime: RuntimeEnv,
  sessions?: ThreadSessionMatch[],
) {
  const state = await inspectThread(opts.permalink, sessions);
  const payload = {
    permalink: state.ref.permalink,
    channelId: state.ref.channelId,
    threadTs: state.ref.threadTs,
    agentId: state.latestTask?.agentId ?? state.session?.agentId ?? null,
    sessionKey: state.latestTask?.ownerKey ?? state.session?.sessionKey ?? null,
    sessionExists: Boolean(state.session),
    sessionUpdatedAt: state.session?.entry.updatedAt ?? null,
    active: state.active,
    lastTool: state.transcript.lastTool ?? null,
    lastToolAt: state.transcript.lastToolAt ?? null,
    lastError: state.latestTask?.error ?? state.transcript.lastError ?? null,
    latestTask: state.latestTask ?? null,
    taskCount: state.tasks.length,
  };
  if (opts.json) {
    runtime.log(JSON.stringify(payload, null, 2));
    return;
  }
  runtime.log(`Slack thread ${state.ref.channelId}/${state.ref.threadTs}`);
  runtime.log(`agent: ${payload.agentId ?? "unknown"}`);
  runtime.log(`session: ${payload.sessionExists ? payload.sessionKey : "missing"}`);
  runtime.log(`active: ${payload.active ? "yes" : "no"}`);
  runtime.log(
    `latest task: ${state.latestTask ? `${state.latestTask.taskId} (${state.latestTask.status})` : "none"}`,
  );
  runtime.log(
    `last activity: ${state.latestTask?.lastEventAt ?? payload.sessionUpdatedAt ?? "unknown"}`,
  );
  runtime.log(`last tool: ${payload.lastTool ?? "unknown"}`);
  runtime.log(`last error: ${payload.lastError ?? "none"}`);
}

export async function threadResumeCommand(
  opts: { permalink: string; json?: boolean },
  runtime: RuntimeEnv,
  sessions?: ThreadSessionMatch[],
) {
  const state = await inspectThread(opts.permalink, sessions);
  const activeTask = state.tasks.find((task) => ACTIVE_TASK_STATUSES.has(task.status));
  if (activeTask) {
    runtime.error(
      `Thread already has active task ${activeTask.taskId} (${activeTask.status}); no duplicate resume was queued.`,
    );
    runtime.exit(2);
    return;
  }
  const recoveryPending = state.sessions.find(
    (session) => threadSessionLiveness(session).recoveryPending,
  );
  if (recoveryPending) {
    runtime.error(
      `Thread session ${recoveryPending.sessionKey} has a gateway recovery cycle pending; no thread resume was queued.`,
    );
    runtime.exit(2);
    return;
  }
  // Trigger on the newest resumable failure thread-wide (newest-first order);
  // delivery below still targets the owning thread session, never the most
  // recently updated child.
  const latestTask = state.tasks.find((task) => RESUMABLE_TASK_STATUSES.has(task.status));
  if (!latestTask) {
    runtime.error(
      state.latestTask
        ? `Latest thread task ${state.latestTask.taskId} is ${state.latestTask.status}, not a terminal failure; no resume was queued.`
        : "No failed task is recorded for this Slack thread; no resume was queued.",
    );
    runtime.exit(2);
    return;
  }
  // Fail closed when the terminal failure is superseded: any newer meaningful
  // state event means the thread state is unknown, not resumable.
  const candidateAt = latestTask.lastEventAt ?? latestTask.createdAt;
  const horizon = Math.max(
    0,
    ...state.sessions.flatMap((session) =>
      listThreadSessionEvents(session)
        .filter((event) => event.kind !== "compacted")
        .map((event) => event.occurredAt),
    ),
  );
  if (horizon > candidateAt) {
    runtime.error(
      `Latest terminal failure ${latestTask.taskId} is superseded by newer thread activity; no resume was queued.`,
    );
    runtime.exit(2);
    return;
  }
  const ownerSession =
    state.sessions.find((session) => session.sessionKey.endsWith(state.ref.sessionSuffix)) ??
    state.sessions.find((session) => session.sessionKey === latestTask.ownerKey);
  const agentId = ownerSession?.agentId ?? latestTask.agentId;
  const sessionKey = ownerSession?.sessionKey ?? latestTask.ownerKey;
  if (!agentId || !sessionKey) {
    runtime.error("Could not resolve the owning agent/session for this Slack thread.");
    runtime.exit(1);
    return;
  }
  const idempotencyKey = createHash("sha256")
    .update(`thread-resume\0${sessionKey}\0${latestTask.taskId}`)
    .digest("hex");
  // Complete triggering context: the newest user message at or before the
  // terminal event (a later follow-up is not the failed request).
  const terminalAt = latestTask.lastEventAt ?? latestTask.createdAt;
  const candidates = state.transcript.userTexts.filter((entry) => {
    if (!entry.at) {
      return true;
    }
    const at = Date.parse(entry.at);
    return Number.isNaN(at) || at <= terminalAt;
  });
  const originalTask = candidates[0]?.text ?? latestTask.task;
  const message = [
    "Resume and finish the prior task in this exact Slack thread.",
    "Re-read the thread root and bounded reply history before acting; do not stop at a progress-only message.",
    `Prior terminal status: ${latestTask.status}${latestTask.error ? ` (${latestTask.error})` : ""}.`,
    "Original task:",
    originalTask,
  ].join("\n\n");
  const response = await callGateway({
    method: "agent",
    params: {
      message,
      agentId,
      sessionKey,
      channel: "slack",
      replyChannel: "slack",
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
    resumedFromTaskId: latestTask.taskId,
    agentId,
    sessionKey,
    idempotencyKey,
    response,
  };
  runtime.log(
    opts.json
      ? JSON.stringify(payload, null, 2)
      : `Queued one continuation for ${latestTask.taskId} in ${sessionKey}.`,
  );
}
