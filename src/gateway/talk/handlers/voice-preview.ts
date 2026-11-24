import { MessageChannel } from "node:worker_threads";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { validateTalkVoicePreviewParams } from "../../../../packages/gateway-protocol/src/index.js";
import { assertSecretOwnerAvailable } from "../../../secrets/runtime-degraded-state.js";
import { isRealtimeVoiceAudioAudible } from "../../../talk/audio-energy.js";
import type { RealtimeVoiceAudioOutputMessage } from "../../../talk/audio-output-port.js";
import { projectInternalRealtimeVoicePublicConfig } from "../../../talk/provider-internal.js";
import { resolveConfiguredRealtimeVoiceProvider } from "../../../talk/provider-resolver.js";
import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "../../../talk/provider-types.js";
import { respondUnavailable } from "../../server-methods/response.js";
import type { GatewayRequestHandlers } from "../../server-methods/types.js";
import { assertValidParams } from "../../server-methods/validation.js";
import { buildTalkRealtimeConfig } from "../session-config.js";

// Preview is a fixed, sessionless sample, never a user prompt or an agent turn.
const PREVIEW_PHRASE = "Hello! This is a preview of my voice.";
const PREVIEW_MAX_BYTES = 24_000 * 2 * 10;
const PREVIEW_TIMEOUT_MS = 18_000;

export const talkVoicePreviewHandlers: GatewayRequestHandlers = {
  "talk.voice.preview": async (options) => {
    const { params, respond, client, context } = options;
    if (!assertValidParams(params, validateTalkVoicePreviewParams, "talk.voice.preview", respond)) {
      return;
    }
    try {
      const assertCurrent = () => {
        if (
          !client?.connId ||
          client.internal?.agentRuntimeIdentity ||
          client.invalidated ||
          client.connectionSignal?.aborted ||
          options.signal?.aborted ||
          options.hasCurrentClientAuthority?.() === false
        ) {
          throw new Error("Voice preview requires a current connected operator");
        }
      };
      assertCurrent();
      const cfg = context.getRuntimeConfig();
      assertSecretOwnerAvailable("capability", "talk:realtime");
      const config = buildTalkRealtimeConfig(cfg, params.provider, params.model);
      const resolution = resolveConfiguredRealtimeVoiceProvider({
        cfg,
        configuredProviderId: params.provider.trim(),
        providerConfigs: config.providers,
        defaultModel: config.model,
        surface: "gateway-relay",
        providerConfigOverrides: {
          ...(params.model ? { model: params.model.trim() } : {}),
          // Both spellings must be overwritten: providers prefer speakerVoice to voice.
          ...(params.voice !== undefined
            ? {
                voice: params.voice?.trim(),
                speakerVoice: params.voice?.trim(),
                speakerVoiceId: undefined,
              }
            : config.voice
              ? { voice: config.voice, speakerVoice: config.voice }
              : {}),
        },
      });
      const format = REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ;
      const selectedVoice = normalizeOptionalString(resolution.providerConfig.voice);
      const model =
        normalizeOptionalString(resolution.providerConfig.model) ??
        resolution.provider.defaultModel;
      const voices =
        (model ? resolution.capabilities?.voicesByModel?.[model] : undefined) ??
        resolution.capabilities?.voices ??
        resolution.provider.voices;
      const requestedVoice = params.voice?.trim().toLowerCase();
      // Validate before bridge-local defaults can silently replace an unsupported voice.
      if (
        requestedVoice &&
        (selectedVoice?.toLowerCase() !== requestedVoice ||
          (voices && !voices.some((voice) => voice.toLowerCase() === requestedVoice)))
      ) {
        throw new Error("Selected realtime provider did not accept the requested voice");
      }
      if (
        !resolution.capabilities?.outputAudioFormats.some(
          (entry) =>
            entry.encoding === format.encoding && entry.sampleRateHz === format.sampleRateHz,
        )
      ) {
        throw new Error("Selected realtime provider does not support PCM16/24kHz previews");
      }
      let settled = false;
      let started = false;
      let bytes = 0;
      let quietBytes = 0;
      const chunks: Buffer[] = [];
      let finish!: (error?: Error) => void;
      const completion = new Promise<void>((resolve, reject) => {
        finish = (error) => {
          if (settled) {
            return;
          }
          settled = true;
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        };
      });
      // Attach rejection handling before provider creation/connect can synchronously fail.
      void completion.catch(() => undefined);
      const acceptAudio = (audio: Buffer) => {
        if (settled || !started || audio.length === 0) {
          return;
        }
        try {
          assertCurrent();
          if (audio.length % 2 !== 0 || bytes + audio.length > PREVIEW_MAX_BYTES) {
            throw new Error("Voice preview exceeded its PCM audio limit");
          }
          const audible = isRealtimeVoiceAudioAudible(audio, format);
          if (bytes === 0 && !audible) {
            return;
          }
          bytes += audio.length;
          chunks.push(Buffer.from(audio));
          quietBytes = audible ? 0 : quietBytes + audio.length;
          // Continuous bridges have no response.done: end after speech plus 750ms silence.
          if (bridge.outputAudioMode === "continuous" && quietBytes >= 36_000) {
            finish();
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error("Voice preview audio failed"));
        }
      };
      const bridge = resolution.provider.createBridge({
        cfg,
        providerConfig: resolution.providerConfig,
        audioFormat: format,
        instructions: `Say exactly: ${PREVIEW_PHRASE} Do not add any other words or call tools.`,
        tools: [],
        // Presence selects the authenticated GPT-Live bridge; it grants no agent execution.
        runAgentConsult: async () => {
          const error = new Error("Agent delegation is disabled for voice previews");
          finish(error);
          throw error;
        },
        onAudio: acceptAudio,
        onClearAudio: () => finish(new Error("Voice preview audio was interrupted")),
        onToolCall: () => finish(new Error("Tools are disabled for voice previews")),
        onError: (error) => finish(error),
        onClose: () => finish(new Error("Voice preview provider closed before completion")),
        onResponseDone: (outcome) => {
          // Continuous PCM is asynchronous and has no response boundary to flush.
          if (outcome.status === "completed" && bridge.outputAudioMode === "continuous") {
            return;
          }
          if (outcome.status === "completed" && bytes > 0) {
            finish();
          } else {
            finish(new Error("Voice preview did not produce completed audio"));
          }
        },
      });
      const channel = new MessageChannel();
      const fence = new SharedArrayBuffer(4);
      channel.port1.on("message", (message: RealtimeVoiceAudioOutputMessage) => {
        if (message.type === "audio") {
          acceptAudio(Buffer.from(message.audio));
          if (!settled) {
            channel.port1.postMessage({ type: "ack" });
          }
        } else if (message.type === "clear") {
          finish(new Error("Voice preview audio was interrupted"));
        }
      });
      const timeout = setTimeout(
        () => finish(new Error("Voice preview timed out")),
        PREVIEW_TIMEOUT_MS,
      );
      const authorityCheck = setInterval(() => {
        try {
          assertCurrent();
        } catch {
          finish(new Error("Voice preview caller disconnected"));
        }
      }, 100);
      try {
        if (bridge.outputAudioMode === "continuous") {
          bridge.setAudioOutputPort?.({ port: channel.port2, state: fence });
        }
        await Promise.race([bridge.connect(), completion]);
        assertCurrent();
        if (!settled) {
          if (!bridge.sendUserMessage) {
            throw new Error("Selected provider cannot preview text");
          }
          started = true;
          bridge.sendUserMessage(PREVIEW_PHRASE);
        }
        await completion;
        assertCurrent();
        if (bytes === 0) {
          throw new Error("Voice preview returned empty audio");
        }
      } finally {
        settled = true;
        clearTimeout(timeout);
        clearInterval(authorityCheck);
        Atomics.store(new Int32Array(fence), 0, 1);
        channel.port1.close();
        channel.port2.close();
        // Close fences admission synchronously; do not let a broken provider hang the RPC.
        let closeTimeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve(bridge.close({ disposition: "abort" })),
            new Promise<void>((resolve) => {
              closeTimeout = setTimeout(resolve, 2_000);
            }),
          ]);
        } finally {
          clearTimeout(closeTimeout);
        }
      }
      assertCurrent();
      const publicConfig = projectInternalRealtimeVoicePublicConfig({
        ...resolution,
        config: resolution.providerConfig,
      });
      respond(
        true,
        {
          provider: resolution.provider.id,
          model: normalizeOptionalString(publicConfig.model),
          voice: selectedVoice,
          audioBase64: Buffer.concat(chunks).toString("base64"),
          sampleRateHz: 24000,
        },
        undefined,
      );
    } catch (error) {
      respondUnavailable(respond, error);
    }
  },
};
