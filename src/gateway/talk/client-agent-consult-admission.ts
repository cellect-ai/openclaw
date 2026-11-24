import {
  GatewayDrainingError,
  captureGatewayRootWorkAdmissionContinuationScope,
  isGatewayRestartDraining,
  runWithGatewayDetachedWorkContinuation,
  tryBeginGatewayIndependentRootWorkAdmission,
} from "../../process/gateway-work-admission.js";

/** The live call registry retains the creating root; a runner only borrows it. */
export function createTalkClientAgentConsultAdmission() {
  const callAdmission = captureGatewayRootWorkAdmissionContinuationScope();
  return {
    async run<T>(run: () => Promise<T>): Promise<T> {
      if (isGatewayRestartDraining()) {
        throw new GatewayDrainingError();
      }
      // Reenter only the original root. Never adopt a replacement call or let a
      // stale callback fall back to fresh admission after its call has closed.
      if (callAdmission) {
        return await callAdmission.run(() =>
          runWithGatewayDetachedWorkContinuation(run, "talk-agent-consult"),
        );
      }
      const admission = tryBeginGatewayIndependentRootWorkAdmission("talk-agent-consult", {
        detachedWork: true,
      });
      if (!admission) {
        throw new GatewayDrainingError();
      }
      try {
        return await admission.run(run);
      } finally {
        admission.release();
      }
    },
  };
}
