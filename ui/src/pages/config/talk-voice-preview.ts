import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { RealtimeTalkPcmOutputQueue } from "../chat/talk/audio.ts";

export type TalkVoicePreviewTarget = { provider: string; model?: string; voice: string | null };
export type TalkVoicePreviewState = "idle" | "loading" | "playing" | "error";

/** Owns preview playback, never microphone capture or a conversation. */
export class TalkVoicePreview {
  state: TalkVoicePreviewState = "idle";
  private context: AudioContext | null = null;
  private readonly output = new RealtimeTalkPcmOutputQueue();
  private generation = 0;
  private pending: {
    client: GatewayBrowserClient;
    target: TalkVoicePreviewTarget;
    generation: number;
    resumed: Promise<void>;
  } | null = null;
  private requesting = false;
  private finishedTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly notify: () => void) {}

  play(client: GatewayBrowserClient, target: TalkVoicePreviewTarget) {
    const generation = ++this.generation;
    this.output.stop(this.context);
    clearTimeout(this.finishedTimer);
    try {
      // Resume during the select/button gesture, before any network await.
      this.context ??= new AudioContext();
      const resumed = this.context.resume();
      void resumed.catch(() => {});
      this.pending = { client, target, generation, resumed };
      this.update("loading");
      void this.drain();
    } catch {
      this.pending = null;
      this.update("error");
    }
  }

  stop() {
    ++this.generation;
    this.pending = null;
    clearTimeout(this.finishedTimer);
    this.output.stop(this.context);
    void this.context?.close().catch(() => {});
    this.context = null;
    this.update("idle");
  }

  private update(state: TalkVoicePreviewState) {
    this.state = state;
    this.notify();
  }

  private async drain() {
    if (this.requesting) {
      return;
    }
    this.requesting = true;
    // Coalesce rapid picks: at most one provider preview runs per page at once.
    while (this.pending) {
      const pick = this.pending;
      this.pending = null;
      try {
        await pick.resumed;
        if (pick.generation !== this.generation) {
          continue;
        }
        const clip = await pick.client.request<{ audioBase64: string; sampleRateHz: number }>(
          "talk.voice.preview",
          pick.target,
          { timeoutMs: 25_000 },
        );
        // Navigation, reconnect, and replacement revoke the old clip's owner.
        if (pick.generation !== this.generation) {
          continue;
        }
        if (this.output.play(clip.audioBase64, this.context, clip.sampleRateHz) !== "queued") {
          throw new Error("Preview audio is unavailable");
        }
        this.update("playing");
        const durationMs =
          Math.max(0, this.output.queuedUntil - (this.context?.currentTime ?? 0)) * 1000;
        this.finishedTimer = setTimeout(() => {
          if (pick.generation === this.generation) {
            this.update("idle");
          }
        }, durationMs);
      } catch {
        if (pick.generation === this.generation) {
          this.update("error");
        }
      }
    }
    this.requesting = false;
  }
}
