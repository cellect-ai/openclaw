import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { registerChatAbortController } from "../chat-abort.js";
import type { DedupeEntry } from "../server-shared.js";
import type { ChatSendAdmissionParams } from "./chat-send-pre-admission.types.js";
import {
  createPendingChatSendReservationAccess,
  readChatSendDedupeResponse,
} from "./chat-send-reservation.js";

export function finishDisplacedChatSendAdmission({
  params,
  admittedRunAbort,
  reservation,
  releaseAdmissionOwners,
  reservationSuperseded,
  supersedingResult,
  lifecycleGeneration,
}: {
  params: ChatSendAdmissionParams;
  admittedRunAbort: ReturnType<typeof registerChatAbortController>;
  reservation: ReturnType<typeof createPendingChatSendReservationAccess>;
  releaseAdmissionOwners: () => void;
  reservationSuperseded: boolean;
  supersedingResult?: DedupeEntry;
  lifecycleGeneration: string;
}): boolean {
  const {
    context,
    respond,
    session: { clientRunId },
  } = params;
  const cachedMeta = { cached: true, runId: clientRunId };
  if (reservationSuperseded) {
    admittedRunAbort.cleanup();
    releaseAdmissionOwners();
    const supersedingCached =
      supersedingResult ?? readChatSendDedupeResponse(context.dedupe, clientRunId);
    if (supersedingCached) {
      respond(supersedingCached.ok, supersedingCached.payload, supersedingCached.error, cachedMeta);
      return true;
    }
    respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, cachedMeta);
    return true;
  }
  if (lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
    if (admittedRunAbort.entry) {
      admittedRunAbort.entry.adapter.abortStopReason = "restart";
    }
    admittedRunAbort.controller.abort();
    admittedRunAbort.cleanup();
    releaseAdmissionOwners();
    if (!readChatSendDedupeResponse(context.dedupe, clientRunId)) {
      reservation.abort(admittedRunAbort.entry?.adapter.abortStopReason ?? "restart");
    }
    const aborted = readChatSendDedupeResponse(context.dedupe, clientRunId);
    respond(aborted?.ok ?? true, aborted?.payload, aborted?.error, cachedMeta);
    return true;
  }
  if (!admittedRunAbort.registered) {
    releaseAdmissionOwners();
    respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, cachedMeta);
    return true;
  }
  return false;
}
