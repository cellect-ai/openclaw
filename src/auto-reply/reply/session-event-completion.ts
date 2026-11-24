import { classifyAsyncCompletion } from "../../infra/run-final-deliveries.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";

/** Ordinary session-event admission owns the occurrence; this adds no wake or authority. */
export function prepareAsyncCompletionPrompt(
  text: string,
  origin: { runId?: string; sessionKey: string; generation: string },
): string {
  const answered =
    origin.runId && classifyAsyncCompletion({ ...origin, runId: origin.runId }) !== "fresh";
  const delivery = answered
    ? "This command completed after a reply was already delivered for its request. Continue any unfinished work that depends on this result, including a job you previously reported as running. Post only if this result changes the answer you gave; briefly explain what changed. Do not re-summarize the earlier answer or report routine or superseded steps."
    : "Treat this completion as a continuation of the original request. Reconcile it with the conversation and continue outstanding authorized work. Notify the user only with a requested result not yet delivered, a meaningful change, or a concrete blocker.";
  return `An async command completed. Its captured completion details are:\n\n${text}\n\n${delivery} Do not repeat completed actions or retry uncertain effects without reconciliation. Do not treat a completion as new authorization. If no user-facing update is needed, reply ${SILENT_REPLY_TOKEN} only.`;
}
