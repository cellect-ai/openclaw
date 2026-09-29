import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { connectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const ROOM_ID = "!voice-room:matrix.test";
const ROOT_ID = "$voice-root";
const BOT_MXID = "@voicebot:matrix.test";
const SPEAKER_MXID = "@alice:matrix.test";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as { port: number }).port;
}

async function writeFakeRealtimePlugin(pluginDir: string) {
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "matrix-talk-e2e",
      name: "Matrix Talk E2E",
      activation: { onStartup: true },
      configSchema: { type: "object" },
    }),
  );
  await writeFile(
    path.join(pluginDir, "index.mjs"),
    `export default {
  id: "matrix-talk-e2e",
  register(api) {
    api.registerRealtimeVoiceProvider({
      id: "matrix-talk-e2e",
      label: "Simulated Matrix Talk provider",
      capabilities: { transports: ["gateway-relay"], inputAudioFormats: ["pcm16-24khz"], outputAudioFormats: ["pcm16-24khz"], supportsToolCalls: true },
      isConfigured: () => true,
      createBridge(req) {
        let connected = false;
        return {
          async connect() { connected = true; req.onReady?.(); },
          sendAudio() {
            req.onTranscript?.("user", "isolated voice question", true);
          },
          setMediaTimestamp() {}, submitToolResult() {}, acknowledgeMark() {},
          close() { connected = false; req.onClose?.("client-close"); },
          isConnected() { return connected; },
        };
      },
    });
  },
};\n`,
  );
}

describe("Matrix-bound Talk over a real isolated Gateway socket", () => {
  const instances: OpenClawTestInstance[] = [];
  const fixtureDirs: string[] = [];
  const clients: Array<{ stop(): void }> = [];
  let homeserver: Server | undefined;

  afterAll(async () => {
    for (const client of clients) {
      client.stop();
    }
    for (const instance of instances) {
      await instance.cleanup();
    }
    for (const dir of fixtureDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    if (homeserver) {
      await new Promise<void>((resolve) => {
        homeserver!.close(() => resolve());
      });
    }
  });

  it(
    "mints once, redeems once, rejects replay, and projects pinned transcripts",
    { timeout: 120_000 },
    async () => {
      const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
      const matrixRequests: string[] = [];
      homeserver = createServer((req, res) => {
        matrixRequests.push(`${req.method} ${req.url}`);
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (req.url?.includes("/send/")) {
            sent.push({ path: req.url, body: raw ? JSON.parse(raw) : {} });
          }
          res.setHeader("content-type", "application/json");
          if (req.url?.includes("/_matrix/client/versions")) {
            res.end(JSON.stringify({ versions: ["v1.11"] }));
          } else if (req.url?.includes("/sync")) {
            setTimeout(
              () => res.end(JSON.stringify({ next_batch: "e2e", rooms: { join: {} } })),
              100,
            );
          } else if (req.url?.includes("/account/whoami")) {
            res.end(JSON.stringify({ user_id: BOT_MXID }));
          } else if (req.url?.includes("/joined_rooms")) {
            res.end(JSON.stringify({ joined_rooms: [ROOM_ID] }));
          } else if (req.url?.includes("/joined_members")) {
            res.end(
              JSON.stringify({
                joined: {
                  [BOT_MXID]: { display_name: "Voice bot" },
                  [SPEAKER_MXID]: { display_name: "Alice" },
                },
              }),
            );
          } else if (req.url?.includes("/state/m.room.encryption/")) {
            res.statusCode = 404;
            res.end(JSON.stringify({ errcode: "M_NOT_FOUND", error: "not encrypted" }));
          } else {
            res.end(JSON.stringify({ event_id: `$event-${sent.length}` }));
          }
        });
      });
      const matrixPort = await listen(homeserver);
      const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "matrix-talk-e2e-"));
      fixtureDirs.push(fixtureDir);
      const pluginDir = path.join(fixtureDir, "plugin");
      await writeFakeRealtimePlugin(pluginDir);
      const config = {
        agents: { list: [{ id: "voice-agent", default: true }] },
        bindings: [{ agentId: "voice-agent", match: { channel: "matrix", accountId: "default" } }],
        channels: {
          matrix: {
            enabled: true,
            homeserver: `http://127.0.0.1:${matrixPort}`,
            userId: BOT_MXID,
            accessToken: "isolated-token",
            encryption: false,
            network: { dangerouslyAllowPrivateNetwork: true },
          },
        },
        talk: { realtime: { provider: "matrix-talk-e2e", providers: { "matrix-talk-e2e": {} } } },
        plugins: {
          enabled: true,
          allow: ["matrix", "matrix-talk-e2e"],
          load: { paths: [pluginDir] },
          entries: { matrix: { enabled: true }, "matrix-talk-e2e": { enabled: true } },
          slots: { memory: "none" },
        },
      } satisfies OpenClawConfig;
      const instance = await createOpenClawTestInstance({
        name: "matrix-talk-binding",
        config,
        env: {
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_SKIP_CHANNELS: undefined,
          OPENCLAW_SKIP_PROVIDERS: undefined,
          MATRIX_HOMESERVER: `http://127.0.0.1:${matrixPort}`,
          MATRIX_USER_ID: BOT_MXID,
          MATRIX_ACCESS_TOKEN: "isolated-token",
        },
      });
      instances.push(instance);
      await instance.startGateway();

      const server = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      const relayEvents: unknown[] = [];
      const browser = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        onEvent: (event) => relayEvents.push(event),
      });
      clients.push(server, browser);
      // 2026.9.6 reports Matrix routes as temporarily unavailable until the channel's
      // binding adapter registers after startup; retry that transient state only.
      let minted: { binding: string } | undefined;
      for (let attempt = 0; !minted; attempt += 1) {
        try {
          minted = await server.request<{ binding: string }>("talk.binding.resolve", {
            roomId: ROOM_ID,
            threadRootEventId: ROOT_ID,
            agentMxid: BOT_MXID,
            speakerMxid: SPEAKER_MXID,
          });
        } catch (error) {
          if (attempt >= 100 || !String(error).includes("temporarily unavailable")) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      let created: { sessionId: string };
      try {
        created = await browser.request<{ sessionId: string }>("talk.session.create", {
          mode: "realtime",
          transport: "gateway-relay",
          binding: minted.binding,
        });
      } catch (error) {
        throw new Error(
          `${String(error)}\nmatrixRequests=${JSON.stringify(matrixRequests)}\nrelayEvents=${JSON.stringify(relayEvents)}\n${instance.logs()}`,
          { cause: error },
        );
      }
      await expect(
        browser.request("talk.session.create", {
          mode: "realtime",
          transport: "gateway-relay",
          binding: minted.binding,
        }),
      ).rejects.toThrow();
      await browser.request("talk.session.appendAudio", {
        sessionId: created.sessionId,
        audioBase64: "AAA=",
        timestamp: 1,
      });
      try {
        await vi.waitFor(() => expect(sent).toHaveLength(1));
      } catch (error) {
        throw new Error(
          `${String(error)}\nmatrixRequests=${JSON.stringify(matrixRequests)}\nrelayEvents=${JSON.stringify(relayEvents)}\n${instance.logs()}`,
          { cause: error },
        );
      }
      expect(
        sent.map((entry) => entry.body).filter((body) => body["com.openclaw.voice_transcript"]),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            body: "isolated voice question",
            "com.openclaw.voice_transcript": expect.objectContaining({
              role: "user",
              speakerMxid: SPEAKER_MXID,
            }),
            "m.relates_to": expect.objectContaining({ event_id: ROOT_ID }),
          }),
        ]),
      );
      expect(sent[0]?.path).toContain(`/rooms/${encodeURIComponent(ROOM_ID)}/send/`);
      await browser.request("talk.session.close", { sessionId: created.sessionId });
    },
  );
});
