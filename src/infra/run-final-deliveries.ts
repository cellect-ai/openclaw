// Process-local record of agent runs that delivered a final reply, so an async
// completion started by a run can tell whether the user already has an answer.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getAgentRunLifecycleGeneration } from "./agent-run-registry.js";

type RunFinalDelivery = { runId: string; at: number; generation: string };

const MAX_SESSIONS = 2_000;
const MAX_RUNS_PER_SESSION = 16;

const RUN_FINAL_DELIVERIES_KEY = Symbol.for("openclaw.runFinalDeliveries");
const deliveriesBySession = resolveGlobalSingleton(
  RUN_FINAL_DELIVERIES_KEY,
  () => new Map<string, RunFinalDelivery[]>(),
);

/** Records that `runId` delivered its final reply in `sessionKey`. */
export function recordRunFinalDelivered(params: {
  sessionKey: string;
  runId: string;
  at?: number;
  generation?: string;
}): void {
  const sessionKey = params.sessionKey.trim();
  const runId = params.runId.trim();
  if (!sessionKey || !runId) {
    return;
  }
  const runs = (deliveriesBySession.get(sessionKey) ?? []).filter((run) => run.runId !== runId);
  runs.push({
    runId,
    at: params.at ?? Date.now(),
    generation: params.generation ?? getAgentRunLifecycleGeneration(),
  });
  deliveriesBySession.delete(sessionKey);
  deliveriesBySession.set(sessionKey, runs.slice(-MAX_RUNS_PER_SESSION));
  if (deliveriesBySession.size > MAX_SESSIONS) {
    const oldest = deliveriesBySession.keys().next().value;
    if (oldest !== undefined) {
      deliveriesBySession.delete(oldest);
    }
  }
}

/**
 * - `fresh`: the originating run has not delivered a final reply yet.
 * - `answered`: the originating run already delivered its final reply.
 * - `superseded`: a later run in the same session has since delivered its own final reply.
 */
export type AsyncCompletionFreshness = "fresh" | "answered" | "superseded";

export function classifyAsyncCompletion(origin: {
  sessionKey: string;
  runId: string;
  generation?: string;
}): AsyncCompletionFreshness {
  const generation = origin.generation ?? getAgentRunLifecycleGeneration();
  const runs = (deliveriesBySession.get(origin.sessionKey.trim()) ?? []).filter(
    (run) => run.generation === generation,
  );
  const originFinal = runs.find((run) => run.runId === origin.runId);
  if (!originFinal) {
    return "fresh";
  }
  return runs.some((run) => run.runId !== origin.runId && run.at > originFinal.at)
    ? "superseded"
    : "answered";
}

export function clearRunFinalDeliveriesForTest(): void {
  deliveriesBySession.clear();
}
