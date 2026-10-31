// A deferred or rejected manual response.create must keep the tool choice it was
// asked with: an announcement queued behind an active response stays tool-free.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const mocks = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: mocks.execFileSyncMock };
});
vi.mock("ws", () => ({ default: mocks.FakeWebSocket }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuardMock,
}));
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: mocks.isProviderAuthProfileConfiguredMock,
  resolveProviderAuthProfileApiKey: mocks.resolveProviderAuthProfileApiKeyMock,
}));
import { createOpenAIRealtimeTestSupport } from "./realtime-voice-test-support.js";

const {
  parseSent,
  createNativeBridge,
  emitServerEvent,
  connectReadyBridge,
  resetTestState,
  restoreTestEnvironment,
} = createOpenAIRealtimeTestSupport({ ...mocks, buildOpenAIRealtimeVoiceProvider });

const toolFree = {
  type: "response.create",
  event_id: expect.stringMatching(/^openclaw-response-create-/),
  response: { output_modalities: ["audio"], tool_choice: "none" },
};

describe("OpenAI realtime deferred response tool choice", () => {
  beforeEach(() => {
    resetTestState();
  });

  afterEach(() => {
    restoreTestEnvironment();
  });

  it("sends a deferred announcement without tools once the active response ends", async () => {
    const bridge = createNativeBridge();
    const socket = await connectReadyBridge(bridge);
    emitServerEvent(socket, { type: "response.created", response: { id: "resp_1" } });

    bridge.sendUserMessage?.("I have an answer.", { toolChoice: "none" });
    bridge.sendUserMessage?.("a plain request queued behind it");
    emitServerEvent(socket, { type: "response.done" });

    const creates = parseSent(socket).filter((event) => event.type === "response.create");
    expect(creates).toEqual([toolFree]);
  });

  it("retries a rejected announcement without tools", async () => {
    const bridge = createNativeBridge({ onError: vi.fn() });
    const socket = await connectReadyBridge(bridge);

    bridge.sendUserMessage?.("I have an answer.", { toolChoice: "none" });
    const first = parseSent(socket).findLast((event) => event.type === "response.create");
    emitServerEvent(socket, {
      type: "error",
      error: {
        event_id: first?.event_id,
        message: "Conversation already has an active response in progress: resp_1",
      },
    });
    emitServerEvent(socket, { type: "response.done" });

    const creates = parseSent(socket).filter((event) => event.type === "response.create");
    expect(creates).toEqual([toolFree, toolFree]);
  });
});
