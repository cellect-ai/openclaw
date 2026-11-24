import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { RealtimeTalkPcmOutputQueue } from "../chat/talk/audio.ts";

export type TalkVoicePreviewTarget = { provider: string; model?: string; voice: string | null };
export type TalkVoicePreviewState = "idle" | "loading" | "playing" | "error";

const PREVIEW_SAMPLE_RATE_HZ = 24_000;

function resumePreviewAudio(
  output: RealtimeTalkPcmOutputQueue,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const abort = () => finish(new Error("Preview was replaced"));
    // Browsers can leave resume pending indefinitely when audio is blocked.
    const timer = setTimeout(() => finish(new Error("Preview audio is blocked")), 2_000);
    signal.addEventListener("abort", abort, { once: true });
    // Keep the resume call inside the original select/button gesture.
    try {
      output.resume().then(() => finish(), finish);
    } catch (error) {
      finish(error);
    }
  });
}

/** Owns preview playback, never microphone capture or a conversation. */
export class TalkVoicePreview {
  state: TalkVoicePreviewState = "idle";
  private outputOpen = false;
  private readonly output = new RealtimeTalkPcmOutputQueue();
  private generation = 0;
  private pending: {
    client: GatewayBrowserClient;
    target: TalkVoicePreviewTarget;
    generation: number;
    resumed: Promise<void>;
  } | null = null;
  private requesting = false;
  private resumeOwner: AbortController | undefined;
  private finishedTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly notify: () => void) {}

  play(client: GatewayBrowserClient, target: TalkVoicePreviewTarget) {
    const generation = ++this.generation;
    this.resumeOwner?.abort();
    this.resumeOwner = new AbortController();
    this.output.stop();
    clearTimeout(this.finishedTimer);
    try {
      // Resume during the select/button gesture, before any network await.
      if (!this.outputOpen) {
        this.output.open(PREVIEW_SAMPLE_RATE_HZ);
        this.outputOpen = true;
      }
      const resumed = resumePreviewAudio(this.output, this.resumeOwner.signal);
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
    this.resumeOwner?.abort();
    this.resumeOwner = undefined;
    this.pending = null;
    clearTimeout(this.finishedTimer);
    this.output.close();
    this.outputOpen = false;
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
        if (
          clip.sampleRateHz !== PREVIEW_SAMPLE_RATE_HZ ||
          this.output.play(clip.audioBase64) !== "queued"
        ) {
          throw new Error("Preview audio is unavailable");
        }
        this.update("playing");
        const durationMs = this.output.playbackDelayMs;
        this.finishedTimer = setTimeout(() => {
          if (pick.generation === this.generation) {
            this.update("idle");
          }
        }, durationMs);
      } catch {
        if (pick.generation === this.generation) {
          // Retry gets a fresh audio context rather than the blocked instance.
          this.output.close();
          this.outputOpen = false;
          this.update("error");
        }
      }
    }
    this.requesting = false;
  }
}
