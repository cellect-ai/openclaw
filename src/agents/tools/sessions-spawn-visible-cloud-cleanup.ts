import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { terminateAcceptedCollectorRun } from "../subagents/spawn/subagent-spawn-cleanup.js";
import {
  runWithGatewayToolCleanupContext,
  type InProcessGatewayCaller,
} from "./in-process-gateway.js";

export function createVisibleCloudRunTerminator(
  gatewayCall: InProcessGatewayCaller,
  cleanupGateway: Parameters<typeof runWithGatewayToolCleanupContext>[1],
) {
  return (key: string, runId: string) =>
    runWithGatewayToolCleanupContext(
      () =>
        terminateAcceptedCollectorRun({
          childSessionKey: key,
          gatewayRunId: runId,
          sessionCleanup: "preserve",
          callGateway: ({ method, params: request, timeoutMs }) => {
            if (!isRecord(request)) {
              throw new Error("Invalid cloud cleanup request");
            }
            return gatewayCall(method, request, {
              timeoutMs,
              resolveGatewayContext: cleanupGateway,
            });
          },
        }),
      cleanupGateway,
    );
}
