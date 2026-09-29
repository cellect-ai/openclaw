// Slack-thread operator commands map a permalink to durable session/task state
// and enqueue at most one continuation for the latest terminal failure.

import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/config.js";
import { resolveAllAgentSessionStoreTargetsSync, type SessionEntry } from "../config/sessions.js";
import {
  listSessionEntriesReadOnly,
  loadTranscriptTailEventsSync,
} from "../config/sessions/session-accessor.js";
import { callGateway } from "../gateway/call.js";
import type { RuntimeEnv } from "../runtime.js";
import { reconcileInspectableTasks } from "../tasks/task-registry.reconcile.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";

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

type ThreadTranscriptTail = {
  lastTool?: string;
  lastToolAt?: string;
  lastError?: string;
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

function tasksForThread(ref: SlackThreadRef): TaskRecord[] {
  return reconcileInspectableTasks()
    .filter(
      (task) =>
        task.ownerKey.endsWith(ref.sessionSuffix) ||
        task.requesterSessionKey.endsWith(ref.sessionSuffix) ||
        task.childSessionKey?.endsWith(ref.sessionSuffix),
    )
    .toSorted(
      (left, right) =>
        (right.lastEventAt ?? right.createdAt) - (left.lastEventAt ?? left.createdAt),
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
      if (!sessionKey.endsWith(ref.sessionSuffix)) {
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
    return {};
  }
  const tail: ThreadTranscriptTail = {};
  const events = loadTranscriptTailEventsSync(
    {
      agentId: session.agentId,
      sessionId: session.entry.sessionId,
      sessionKey: session.sessionKey,
      storePath: session.storePath,
    },
    200,
  );
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
    if (tail.lastTool && tail.lastError) {
      break;
    }
  }
  return tail;
}

async function inspectThread(rawPermalink: string) {
  const ref = parseSlackThreadPermalink(rawPermalink);
  const tasks = tasksForThread(ref);
  const sessions = sessionsForThread(ref);
  const latestTask = tasks[0];
  const session = sessions[0];
  const transcript = await readThreadTranscriptTail(session);
  return {
    ref,
    tasks,
    sessions,
    latestTask,
    session,
    transcript,
    active: tasks.some((task) => ACTIVE_TASK_STATUSES.has(task.status)),
  };
}

export async function threadStatusCommand(
  opts: { permalink: string; json?: boolean },
  runtime: RuntimeEnv,
) {
  const state = await inspectThread(opts.permalink);
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
) {
  const state = await inspectThread(opts.permalink);
  const activeTask = state.tasks.find((task) => ACTIVE_TASK_STATUSES.has(task.status));
  if (activeTask) {
    runtime.error(
      `Thread already has active task ${activeTask.taskId} (${activeTask.status}); no duplicate resume was queued.`,
    );
    runtime.exit(2);
    return;
  }
  const latestTask = state.latestTask;
  if (!latestTask || !RESUMABLE_TASK_STATUSES.has(latestTask.status)) {
    runtime.error(
      latestTask
        ? `Latest thread task ${latestTask.taskId} is ${latestTask.status}, not a terminal failure; no resume was queued.`
        : "No failed task is recorded for this Slack thread; no resume was queued.",
    );
    runtime.exit(2);
    return;
  }
  const agentId = latestTask.agentId ?? state.session?.agentId;
  const sessionKey = latestTask.ownerKey || state.session?.sessionKey;
  if (!agentId || !sessionKey) {
    runtime.error("Could not resolve the owning agent/session for this Slack thread.");
    runtime.exit(1);
    return;
  }
  const idempotencyKey = createHash("sha256")
    .update(`thread-resume\0${sessionKey}\0${latestTask.taskId}`)
    .digest("hex");
  const message = [
    "Resume and finish the prior task in this exact Slack thread.",
    "Re-read the thread root and bounded reply history before acting; do not stop at a progress-only message.",
    `Prior terminal status: ${latestTask.status}${latestTask.error ? ` (${latestTask.error})` : ""}.`,
    "Original task:",
    latestTask.task,
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
