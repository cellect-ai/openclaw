/**
 * Fi-user runs started by a verified Matrix reply in a Slack thread's Matrix
 * projection, by host run id. The admin delegation's dispatch and run hooks
 * record them (homeserver-verified sender, Fi's source-guard allowance for that
 * person and session, the run of that exact event); Fi-user tools read them,
 * because the host can report the Slack session's channel for such a run.
 */
export type ProjectedMatrixRun = { sessionKey: string; matrixUserId: string; accountId?: string };

const MAX_RUNS = 5_000;
const runs = new Map<string, ProjectedMatrixRun>();

export function rememberProjectedMatrixRun(runId: string, run: ProjectedMatrixRun): void {
  runs.delete(runId);
  runs.set(runId, { ...run, sessionKey: run.sessionKey.toLowerCase() });
  for (const oldest of runs.keys()) {
    if (runs.size <= MAX_RUNS) {
      break;
    }
    runs.delete(oldest);
  }
}

export function forgetProjectedMatrixRun(runId: string): void {
  runs.delete(runId);
}

/** Someone else wrote into the session, or it was reset: its runs prove nobody. */
export function forgetProjectedMatrixSession(sessionKey: string, keepMatrixUserId?: string): void {
  const key = sessionKey.toLowerCase();
  for (const [runId, run] of runs) {
    if (run.sessionKey === key && run.matrixUserId !== keepMatrixUserId) {
      runs.delete(runId);
    }
  }
}

export function forgetAllProjectedMatrixRuns(): void {
  runs.clear();
}

/** The recorded run, only for this exact session and sender. */
export function projectedMatrixRun(
  runId: string | undefined,
  sessionKey: string | undefined,
  senderId: string | undefined,
): ProjectedMatrixRun | undefined {
  const run = runId ? runs.get(runId) : undefined;
  return run &&
    run.sessionKey === sessionKey?.toLowerCase() &&
    run.matrixUserId === senderId?.trim()
    ? run
    : undefined;
}
