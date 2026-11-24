import { isExecutionIdentityCollectionEnabled } from "../../../audit/audit-config.js";
import { runWithAgentToolSourceExecutionScope } from "../../agent-tool-source-execution-guard.js";
import { readParentExecutionIdentity } from "./execution-identity-spawn-context.js";
import type { SpawnSubagentContext } from "./subagent-spawn-contract.js";
import {
  buildSubagentExecutionSessionSpawnContext,
  withSubagentGatewayExecutionIdentity,
} from "./subagent-spawn-execution-identity.js";
import {
  callNativeSubagentGateway,
  captureSubagentSpawnGatewayContext,
} from "./subagent-spawn-gateway.js";
import { buildSubagentLaunchRequest } from "./subagent-spawn-launch-request.js";

export function dispatchPreparedSubagentChild(params: {
  launchContext: ReturnType<typeof buildSubagentLaunchRequest>;
  assertDispatchCurrent?: () => void;
  cfg: Parameters<typeof isExecutionIdentityCollectionEnabled>[0];
  ctx: SpawnSubagentContext;
  requesterAgentId: string;
  requesterInternalKey: string;
  controllerSessionKey: string;
  childDepth: number;
  maxSpawnDepth: number;
  targetAgentId: string;
  sandboxMode: "require" | "inherit";
  gatewayContextResolver: ReturnType<
    typeof captureSubagentSpawnGatewayContext
  >["gatewayContextResolver"];
  requester: ReturnType<typeof captureSubagentSpawnGatewayContext>["requester"];
}) {
  const {
    launchContext,
    assertDispatchCurrent,
    cfg,
    ctx,
    requesterAgentId,
    requesterInternalKey,
    childDepth,
    maxSpawnDepth,
    targetAgentId,
    sandboxMode,
    gatewayContextResolver,
    requester,
    controllerSessionKey,
  } = params;
  return runWithAgentToolSourceExecutionScope(assertDispatchCurrent, () =>
    callNativeSubagentGateway(
      withSubagentGatewayExecutionIdentity(
        {
          method: "agent",
          assertDispatchCurrent,
          params: launchContext.childLaunch.request,
          timeoutMs: launchContext.childLaunch.timeoutMs,
        },
        {
          sessionSpawnContext: buildSubagentExecutionSessionSpawnContext({
            enabled: isExecutionIdentityCollectionEnabled(cfg),
            backend: "subagent",
            parentAgentId: requesterAgentId,
            requesterRef: requesterInternalKey,
            controllerRef: controllerSessionKey,
            depth: childDepth,
            maxDepth: maxSpawnDepth,
            targetAgentId,
            sandbox: sandboxMode,
            inheritedToolAllowlist: ctx.inheritedToolAllowlist,
            inheritedToolDenylist: ctx.inheritedToolDenylist,
          }),
          parentExecutionIdentityToken: readParentExecutionIdentity(ctx),
        },
      ),
      {
        authorization: launchContext.childLaunch.authorization,
        gatewayContextResolver,
        requester,
        preparedLaunch: launchContext.preparedLaunch,
      },
    ),
  );
}
