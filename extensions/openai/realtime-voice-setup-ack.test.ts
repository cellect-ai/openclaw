import { afterEach, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const mocks = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
vi.mock("openclaw/plugin-sdk/websocket-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/websocket-runtime")>()),
  WebSocket: mocks.FakeWebSocket,
}));
// The configured synthetic key avoids all host credential discovery.
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: () => false,
  isProviderAuthProfileConfiguredAsync: async () => false,
  resolveProviderAuthProfileApiKey: () => undefined,
}));
afterEach(() => {
  mocks.FakeWebSocket.instances = [];
});

it("requires the native OpenAI session.updated acknowledgement after created and unrelated events", async () => {
  const onReady = vi.fn();
  const bridge = buildOpenAIRealtimeVoiceProvider().createBridge({
    providerConfig: { apiKey: "synthetic-key" },
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
    onReady,
  });
  const connecting = bridge.connect();
  let settled = false;
  void connecting.then(() => {
    settled = true;
  });
  try {
    await vi.waitFor(() => expect(mocks.FakeWebSocket.instances).toHaveLength(1));
    const socket = mocks.FakeWebSocket.instances[0];
    if (!socket) throw new Error("Native OpenAI socket required");
    socket.readyState = mocks.FakeWebSocket.OPEN;
    socket.emit("open");
    const emit = (type: string) => socket.emit("message", Buffer.from(JSON.stringify({ type })));
    for (const type of ["session.created", "synthetic.unrelated"]) {
      emit(type);
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(bridge.isConnected()).toBe(false);
      expect(onReady).not.toHaveBeenCalled();
    }
    emit("session.updated");
    await connecting;
    expect(bridge.isConnected()).toBe(true);
    expect(onReady).toHaveBeenCalledOnce();
  } finally {
    bridge.close();
  }
});
