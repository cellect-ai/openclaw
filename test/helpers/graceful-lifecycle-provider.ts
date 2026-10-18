// Test-only native plugin and external-provider transport; never owns lifecycle state.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { buildMockOpenAiResponsesProvider } from "../../src/gateway/test-openai-responses-model.js";
import { writeOpenAiResponsesText } from "./openai-responses-sse.js";

export async function createGracefulLifecycleProvider() {
  const root = await mkdtemp(path.join(tmpdir(), "openclaw-lifecycle-provider-"));
  const pluginDir = path.join(root, "plugin");
  const events: string[] = [];
  const consultResults: string[] = [];
  let models = 0;
  let releaseModel = () => {};
  let releaseClose = () => {};
  let modelGate = Promise.resolve();
  let closeGate = Promise.resolve();
  const server = createServer((request, response) => {
    void (async () => {
      // Consume requests before replying so real HTTP clients can reuse sockets.
      for await (const _chunk of request) {
        /* Synthetic provider requests contain no real user data. */
      }
      if (request.url === "/v1/responses") {
        const index = ++models;
        events.push("model-start");
        await modelGate;
        writeOpenAiResponsesText(response, {
          text: `LIFECYCLE_CONSULT_COMPLETED_${index}`,
          messageId: `msg_lifecycle_${index}`,
          responseId: `resp_lifecycle_${index}`,
        });
        events.push("model-response");
        return;
      }
      let event = request.url?.slice(1) ?? "unknown";
      if (event.startsWith("consult-completed/")) {
        const marker = event.slice("consult-completed/".length);
        if (/^LIFECYCLE_CONSULT_COMPLETED_[1-9]\d*$/.test(marker)) {
          consultResults.push(marker);
          event = "consult-completed";
        } else {
          event = "consult-failed";
        }
      }
      events.push(event);
      if (event === "provider-close") {
        await closeGate;
      }
      response.end("ok");
    })().catch(() => {
      response.statusCode = 500;
      response.end("fixture provider failed");
    });
  });
  const cleanup = async () => {
    releaseModel();
    releaseClose();
    const failures: unknown[] = [];
    try {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, "Provider fixture cleanup failed");
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Provider loopback bind timed out")), 5_000);
      server.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      server.listen(0, "127.0.0.1", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Provider fixture did not bind loopback");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const id = "graceful-lifecycle-proof";
    await mkdir(pluginDir);
    await writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id,
        activation: { onStartup: true },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    );
    await writeFile(
      path.join(pluginDir, "index.mjs"),
      `const notify = async (event) => {
      const result = await fetch(${JSON.stringify(baseUrl)} + '/' + event, { signal: AbortSignal.timeout(120000) });
      if (!result.ok) throw new Error('fixture provider transport failed');
      await result.text();
    };
    function bridge(request) {
      let connected = true;
      return {
        connect: async () => { request.onReady?.(); },
        isConnected: () => connected,
        sendAudio: () => {
          void notify('audio').catch(() => {});
          if (!request.runAgentConsult) return;
          void request.runAgentConsult({ prompt: 'Complete the isolated lifecycle consult' }).then(
            (result) => {
              const text = typeof result?.text === 'string' ? result.text.trim() : '';
              return /^LIFECYCLE_CONSULT_COMPLETED_[1-9]\\d*$/.test(text)
                ? notify('consult-completed/' + text) : notify('consult-failed');
            }, () => notify('consult-failed')
          ).catch(() => {});
        },
        setMediaTimestamp() {}, submitToolResult() {}, acknowledgeMark() {},
        async close() {
          connected = false;
          await notify('provider-close');
          request.onTranscript?.('user', 'ISOLATED_FINAL_PROVIDER_TRANSCRIPT', true);
          await notify('provider-finalized');
        }
      };
    }
    const browserBridges = new WeakMap();
    export default { id: ${JSON.stringify(id)}, register(api) {
      const provider = {
        id: ${JSON.stringify(id)}, label: 'Isolated lifecycle proof', isConfigured: () => true,
        capabilities: {
          transports: ['webrtc', 'gateway-relay'], supportsBrowserSession: true,
          inputAudioFormats: [{encoding:'pcm16',sampleRateHz:24000,channels:1}],
          outputAudioFormats: [{encoding:'pcm16',sampleRateHz:24000,channels:1}],
          supportsToolCalls: true, supportsGatewayControl: true, handlesAgentConsult: true
        },
        async createBrowserSession(request) {
          const control = bridge(request.gatewayControl);
          browserBridges.set(request, control);
          request.gatewayControl?.bindBridge(control);
          request.gatewayControl?.onReady?.();
          return { provider: ${JSON.stringify(id)}, transport: 'provider-websocket',
            protocol: 'google-live-bidi', clientSecret: 'synthetic-loopback-proof',
            websocketUrl: 'ws://127.0.0.1/unused-browser-media',
            audio: { inputEncoding:'pcm16', inputSampleRateHz:24000,
              outputEncoding:'pcm16', outputSampleRateHz:24000 } };
        },
        createBridge: bridge
      };
      // Same process-private browser cancellation contract used by bundled providers.
      Object.defineProperty(provider, Symbol.for('openclaw.internal.realtime-voice-provider.v1'), {
        value: { isBrowserSessionConfigured: () => true,
          cancelBrowserSession: (request) => browserBridges.get(request)?.close() }
      });
      api.registerRealtimeVoiceProvider(provider);
    }};
    `,
    );
    const model = buildMockOpenAiResponsesProvider(`${baseUrl}/v1`, "lifecycle-proof");
    const config: OpenClawConfig = {
      plugins: {
        enabled: true,
        allow: [id],
        load: { paths: [pluginDir] },
        entries: { [id]: { enabled: true } },
        slots: { memory: "none" },
      },
      agents: {
        defaults: {
          workspace: path.join(root, "workspace"),
          model: { primary: model.modelRef },
          modelPolicy: { allow: [model.modelRef] },
          models: {
            [model.modelRef]: {
              agentRuntime: { id: "openclaw" },
              params: { transport: "sse", openaiWsWarmup: false },
            },
          },
          skills: [],
          skipBootstrap: true,
        },
        entries: { main: { model: { primary: model.modelRef }, skills: [] } },
      },
      models: {
        mode: "replace",
        providers: {
          [model.providerId]: { ...model.config, request: { allowPrivateNetwork: true } },
        },
      },
      tools: { profile: "minimal" },
      talk: { realtime: { provider: id, providers: { [id]: {} } } },
    };
    return {
      id,
      config,
      events,
      consultResults,
      hold() {
        modelGate = new Promise<void>((resolve) => {
          releaseModel = resolve;
        });
        closeGate = new Promise<void>((resolve) => {
          releaseClose = resolve;
        });
      },
      releaseModels: () => releaseModel(),
      releaseProviders: () => releaseClose(),
      cleanup,
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Provider fixture setup and cleanup failed", {
        cause: error,
      });
    }
    throw error;
  }
}
