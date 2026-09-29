// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { TalkVoicePreview } from "./talk-voice-preview.ts";

class PreviewAudioContext {
  static instances: PreviewAudioContext[] = [];
  currentTime = 0;
  destination = {};
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  sources: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];
  constructor() {
    PreviewAudioContext.instances.push(this);
  }
  createBuffer(_channels: number, length: number) {
    return { getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    const source = {
      start: vi.fn(),
      stop: vi.fn(),
      connect: vi.fn(),
      addEventListener: vi.fn(),
      buffer: null,
    };
    this.sources.push(source);
    return source;
  }
}

const clip = { audioBase64: btoa("\0".repeat(48_000)), sampleRateHz: 24_000 };
const target = { provider: "voice-provider", model: "voice-model", voice: "voice-one" };
const owners: TalkVoicePreview[] = [];

function setup() {
  PreviewAudioContext.instances = [];
  vi.stubGlobal("AudioContext", PreviewAudioContext);
  const preview = new TalkVoicePreview(vi.fn());
  owners.push(preview);
  return preview;
}

afterEach(() => {
  owners.splice(0).forEach((owner) => owner.stop());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Talk voice preview lifecycle", () => {
  it("unlocks audio in the gesture and coalesces changed voices without playing stale clips", async () => {
    const preview = setup();
    const first = createDeferred<typeof clip>();
    const latest = createDeferred<typeof clip>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    preview.play(client, target);
    expect(PreviewAudioContext.instances[0]?.resume).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    preview.play(client, { ...target, voice: "voice-two" });
    preview.play(client, { ...target, voice: "voice-three" });
    expect(request).toHaveBeenCalledOnce();
    first.resolve(clip);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenLastCalledWith(
      "talk.voice.preview",
      { ...target, voice: "voice-three" },
      { timeoutMs: 25_000 },
    );
    expect(PreviewAudioContext.instances[0]?.sources).toHaveLength(0);
    latest.resolve(clip);
    await vi.waitFor(() => expect(preview.state).toBe("playing"));
    expect(PreviewAudioContext.instances[0]?.sources[0]?.start).toHaveBeenCalledOnce();
    preview.stop();
    expect(PreviewAudioContext.instances[0]?.sources[0]?.stop).toHaveBeenCalledOnce();
    expect(PreviewAudioContext.instances[0]?.close).toHaveBeenCalledOnce();
  });

  it("revokes a pending result on navigation without playing or retaining audio", async () => {
    const preview = setup();
    const result = createDeferred<typeof clip>();
    const request = vi.fn().mockReturnValue(result.promise);
    preview.play({ request } as unknown as GatewayBrowserClient, target);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    preview.stop();
    result.resolve(clip);
    await Promise.resolve();
    await Promise.resolve();
    expect(preview.state).toBe("idle");
    expect(PreviewAudioContext.instances[0]?.sources).toHaveLength(0);
    expect(PreviewAudioContext.instances[0]?.close).toHaveBeenCalledOnce();
  });

  it.each(["provider", "playback"])(
    "reports %s failure and permits a fresh preview",
    async (failure) => {
      const preview = setup();
      const request = vi.fn().mockResolvedValue(clip);
      if (failure === "provider") {
        request.mockRejectedValueOnce(new Error("Provider unavailable"));
      } else {
        request.mockResolvedValueOnce({ ...clip, audioBase64: "" });
      }
      const client = { request } as unknown as GatewayBrowserClient;
      preview.play(client, { ...target, voice: null });
      await vi.waitFor(() => expect(preview.state).toBe("error"));
      preview.play(client, target);
      await vi.waitFor(() => expect(preview.state).toBe("playing"));
      expect(request).toHaveBeenCalledTimes(2);
    },
  );
});
