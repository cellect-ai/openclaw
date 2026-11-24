import type { TalkClientCreateParams } from "../../../../packages/gateway-protocol/src/index.js";
import { buildTalkRealtimeConfig, resolveTalkClientLaunchError } from "../session-config.js";
export function resolveTalkClientLaunch(
  params: TalkClientCreateParams,
  realtimeConfig: Awaited<ReturnType<typeof buildTalkRealtimeConfig>>,
) {
  const mode = params.mode ?? realtimeConfig.mode ?? "realtime";
  const brain = params.brain ?? realtimeConfig.brain ?? "agent-consult";
  const transport = params.transport ?? realtimeConfig.transport;
  const wantsCameraFrames = params.capabilities?.includes("camera-frame") === true;
  const wantsGatewayControl = params.capabilities?.includes("gateway-control-v1") === true;
  const clientControl = wantsGatewayControl ? { owner: "gateway" as const } : undefined;
  const transportError = resolveTalkClientLaunchError({
    mode,
    brain,
    transport,
    wantsGatewayControl,
    wantsCameraFrames,
  });

  return { transport, wantsCameraFrames, wantsGatewayControl, clientControl, transportError };
}
