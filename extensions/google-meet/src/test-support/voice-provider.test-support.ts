import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { vi } from "vitest";

type TestMeetVoiceBridgeRequest = Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0];

export function createTestMeetVoiceProvider(
  options: Pick<RealtimeVoiceProviderPlugin, "defaultModel"> &
    Pick<
      RealtimeVoiceBridge,
      "supportsToolResultContinuation" | "handleBargeIn" | "triggerGreeting"
    > = {},
) {
  let request: TestMeetVoiceBridgeRequest | undefined;
  const bridge = {
    connect: vi.fn(async () => {}),
    sendAudio: vi.fn(),
    sendUserMessage: vi.fn(),
    setMediaTimestamp: vi.fn(),
    submitToolResult: vi.fn(),
    acknowledgeMark: vi.fn(),
    close: vi.fn(),
    triggerGreeting: options.triggerGreeting ?? vi.fn(),
    handleBargeIn: options.handleBargeIn,
    supportsToolResultContinuation: options.supportsToolResultContinuation,
    isConnected: vi.fn(() => true),
  };
  const provider: RealtimeVoiceProviderPlugin = {
    id: "openai",
    label: "OpenAI",
    autoSelectOrder: 1,
    defaultModel: options.defaultModel,
    resolveConfig: ({ rawConfig }) => rawConfig,
    isConfigured: () => true,
    createBridge: (nextRequest) => {
      request = nextRequest;
      return bridge;
    },
  };
  return {
    provider,
    bridge,
    sendAudio: bridge.sendAudio,
    requireRequest: () => {
      if (!request) {
        throw new Error("Expected realtime bridge callbacks");
      }
      return request;
    },
  };
}
