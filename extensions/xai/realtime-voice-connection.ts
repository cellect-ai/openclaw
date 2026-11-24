import {
  XAI_REALTIME_DEFAULT_MODEL,
  readXaiRealtimeErrorDetail,
  toXaiRealtimeWsUrl,
  type XaiRealtimeEvent,
  type XaiRealtimeVoiceBridgeConfig,
} from "./realtime-voice-config.js";
import { xaiUserAgentHeaderFor } from "./src/xai-user-agent.js";

export async function resolveXaiRealtimeConnection(
  config: XaiRealtimeVoiceBridgeConfig,
  getConversationId: () => string | null,
): Promise<{ url: string; headers: Record<string, string> }> {
  const apiKey = await config.resolveApiKey();
  const model = config.model ?? XAI_REALTIME_DEFAULT_MODEL;
  const url = toXaiRealtimeWsUrl(
    config.baseUrl,
    model,
    config.sessionResumption === true ? (getConversationId() ?? undefined) : undefined,
  );
  return {
    url,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...xaiUserAgentHeaderFor(config.baseUrl),
    },
  };
}
export function describeXaiRealtimeServerEvent(
  event: XaiRealtimeEvent,
  providerLabel?: string,
): string | undefined {
  if (
    event.type === "error" ||
    event.type === "conversation.item.input_audio_transcription.failed"
  ) {
    return readXaiRealtimeErrorDetail(event.error, providerLabel ?? "xAI realtime voice");
  }
  if (event.type !== "response.done") {
    return undefined;
  }
  const status = event.response?.status;
  const details =
    event.response?.status_details === undefined
      ? undefined
      : JSON.stringify(event.response.status_details);
  return [status ? `status=${status}` : undefined, details].filter(Boolean).join(" ") || undefined;
}
