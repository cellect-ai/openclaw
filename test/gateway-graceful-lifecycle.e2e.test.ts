// Opt-in cross-repository proof: actual controller + CLI/RPC + native process.
// Docker/Infisical and encrypted Matrix transport remain separate release gates.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { runExec } from "../src/process/exec.js";
import { createGracefulLifecycleProvider } from "./helpers/graceful-lifecycle-provider.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

const controllerPath = process.env.OPENCLAW_LIFECYCLE_CONTROLLER_PATH;
const adapterPath = process.env.OPENCLAW_LIFECYCLE_PROCESS_ADAPTER_PATH;

it.skipIf(!controllerPath || !adapterPath)(
  "defers a real busy resident, resumes admission, then commits and restarts the exact native owner",
  { timeout: 600_000 },
  async () => {
    const cleanupSteps: Array<() => Promise<unknown>> = [];
    let primaryError: unknown;
    let failed = false;
    try {
      const sourceSha =
        process.env.GIT_COMMIT?.trim() ||
        execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const provider = await createGracefulLifecycleProvider();
      cleanupSteps.unshift(() => provider.cleanup());
      const instance = await createOpenClawTestInstance({
        name: "graceful-controller-native-process",
        stopTimeoutMs: 360_000,
        config: {
          ...provider.config,
          update: { checkOnStart: false, auto: { enabled: false } },
          gateway: {
            terminal: { enabled: true, shell: "/bin/sh", detachedSessionTimeoutSeconds: 0 },
          },
        },
        env: {
          // Use the production host lifecycle, not test's process-owner suppression.
          VITEST: undefined,
          VITEST_POOL_ID: undefined,
          VITEST_WORKER_ID: undefined,
          NODE_ENV: undefined,
          NODE_OPTIONS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_SUPERVISOR_MODE: undefined,
        },
      });
      cleanupSteps.unshift(() => instance.cleanup());
      const ownerId = `isolated-process-${randomUUID()}`;
      const observations: Array<{ method: string; result: Record<string, unknown> }> = [];
      const server = createServer((request, response) => {
        void (async () => {
          if (request.url === "/rpc-observed" && request.method === "POST") {
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
              chunks.push(Buffer.from(chunk));
            }
            observations.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            response.end("ok");
            return;
          }
          if (request.url === "/start" && request.method === "POST") {
            await instance.startGateway();
            response.end(JSON.stringify({ started: true }));
            return;
          }
          if (request.url !== "/inspect" || request.method !== "GET") {
            response.statusCode = 404;
            response.end();
            return;
          }
          const child = instance.child;
          const running =
            child !== undefined && child.exitCode === null && child.signalCode === null;
          let healthy = false;
          if (running) {
            try {
              const ready = await fetch(`http://127.0.0.1:${instance.port}/readyz`, {
                signal: AbortSignal.timeout(2_000),
              });
              await ready.arrayBuffer();
              healthy = ready.status === 200;
            } catch {
              /* Actual process shutdown can close readiness before process exit. */
            }
          }
          response.end(
            JSON.stringify({
              Id: ownerId,
              Image: "isolated-source-process",
              Config: { StopTimeout: 360 },
              HostConfig: { RestartPolicy: { Name: "no", MaximumRetryCount: 0 } },
              State: { Running: running, Health: { Status: healthy ? "healthy" : "starting" } },
            }),
          );
        })().catch(() => {
          response.statusCode = 500;
          response.end("fixture operation failed");
        });
      });
      cleanupSteps.unshift(async () => {
        if (server.listening) {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      });
      let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
      let relayClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
      const controllerTurns: Array<Promise<unknown>> = [];
      cleanupSteps.unshift(() => Promise.allSettled(controllerTurns));
      cleanupSteps.unshift(async () => {
        if (relayClient) await disconnectGatewayClient(relayClient);
      });
      cleanupSteps.unshift(async () => {
        if (client) await disconnectGatewayClient(client);
      });
      cleanupSteps.unshift(async () => {
        provider.releaseProviders();
        provider.releaseModels();
      });
      await instance.startGateway();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Fixture bind timed out")), 5_000);
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
        throw new Error("Fixture listener did not bind");
      }
      const fixtureUrl = `http://127.0.0.1:${address.port}`;
      const cli = [process.execPath, ...(await instance.entrypoint())];
      const rpc = async <T>(method: string, params: unknown): Promise<T> => {
        const result = await instance.cli([
          "gateway",
          "call",
          method,
          "--params",
          JSON.stringify(params),
          "--json",
          "--url",
          instance.url,
          "--token",
          instance.gatewayToken,
        ]);
        expect(result.code, result.stderr).toBe(0);
        return JSON.parse(result.stdout) as T;
      };
      const info = await rpc<{
        pid: number;
        processInstanceId: string;
        lifecycle: Record<string, unknown>;
      }>("system.info", {});
      expect(info.lifecycle).toMatchObject({
        idleRequiredHandoff: true,
        boundSuspension: true,
        voiceCallDrain: true,
      });
      const target = { pid: info.pid, processInstanceId: info.processInstanceId };
      const channels = await rpc<{ channelOrder: string[] }>("channels.status", { probe: false });
      expect(channels.channelOrder).not.toContain("matrix");
      expect(channels.channelOrder).not.toContain("slack");
      client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write", "operator.talk.secrets"],
      });
      const terminal = await client.request<{ sessionId: string }>("terminal.open", {
        cols: 80,
        rows: 24,
      });
      const prepared = await rpc<{ status: string; suspensionId: string }>(
        "gateway.suspend.prepare",
        { requestId: randomUUID(), target, drain: true, terminalPolicy: "preserve" },
      );
      expect(prepared.status).toBe("draining");
      expect(
        await rpc("gateway.suspend.status", {
          suspensionId: prepared.suspensionId,
          includeLifecycle: true,
        }),
      ).toMatchObject({ ...target, status: "draining" });
      expect(
        await rpc("gateway.suspend.resume", { suspensionId: prepared.suspensionId }),
      ).toMatchObject({ status: "running" });
      const runController = async (drainTimeout: number) => {
        const execution = runExec(
          "python3",
          [
            adapterPath!,
            "--controller",
            controllerPath!,
            "--fixture-url",
            fixtureUrl,
            "--source-sha",
            sourceSha,
            "--drain-timeout",
            String(drainTimeout),
          ],
          {
            timeoutMs: 180_000,
            baseEnv: instance.env,
            env: {
              OPENCLAW_GATEWAY_TOKEN: instance.gatewayToken,
              OPENCLAW_PROCESS_E2E_CLI: JSON.stringify(cli),
              OPENCLAW_PROCESS_E2E_GATEWAY_URL: instance.url,
            },
          },
        );
        controllerTurns.push(execution);
        const result = await execution;
        return JSON.parse(result.stdout) as {
          code: number;
          receipt: {
            outcome: string;
            predecessorProcessInstanceId: string;
            successorProcessInstanceId: string;
          };
        };
      };
      const deferred = await runController(1);
      expect(deferred).toMatchObject({
        code: 75,
        receipt: { outcome: "deferred", predecessorProcessInstanceId: target.processInstanceId },
      });
      // The existing physical shell remains usable after controller deferral.
      expect(
        await client.request("terminal.input", {
          sessionId: terminal.sessionId,
          data: "printf 'native-owner-survived\\n'\n",
        }),
      ).toMatchObject({ ok: true });
      await client.request("terminal.close", { sessionId: terminal.sessionId });
      const browserKey = "agent:main:lifecycle-browser";
      const relayKey = "agent:main:lifecycle-relay";
      const browser = await client.request<{ voiceSessionId: string }>("talk.client.create", {
        sessionKey: browserKey,
        provider: provider.id,
        capabilities: ["gateway-control-v1"],
      });
      relayClient = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write", "operator.talk.secrets"],
        requestTimeoutMs: 150_000,
      });
      const relay = await relayClient.request<{ sessionId: string }>("talk.session.create", {
        sessionKey: relayKey,
        mode: "realtime",
        provider: provider.id,
        transport: "gateway-relay",
        brain: "agent-consult",
      });
      const waitOptions = { timeout: 60_000, interval: 50 };
      const waitForControllerLease = async (after: number) => {
        await vi.waitFor(() => {
          expect(
            observations
              .slice(after)
              .some(
                (entry) =>
                  entry.method === "gateway.suspend.prepare" && entry.result.status === "draining",
              ),
          ).toBe(true);
        }, waitOptions);
        const prepared = observations
          .slice(after)
          .find(
            (entry) =>
              entry.method === "gateway.suspend.prepare" && entry.result.status === "draining",
          )!;
        return String(prepared.result.suspensionId);
      };
      // Keep both actual provider-owned calls open across a complete Controller deferral.
      // No terminal remains to mask a missing native voice owner.
      const voiceObservation = observations.length;
      const voiceDeferredPromise = runController(20);
      void voiceDeferredPromise.catch(() => undefined);
      const firstVoiceLease = await waitForControllerLease(voiceObservation);
      await expect(
        client.request("talk.client.create", {
          sessionKey: "agent:main:unrelated-new-call",
          provider: provider.id,
        }),
      ).rejects.toThrow("talk.client.create unavailable during gateway suspension");
      await expect(
        relayClient.request("talk.session.appendAudio", {
          sessionId: relay.sessionId,
          audioBase64: Buffer.from([0, 0, 0, 0]).toString("base64"),
        }),
      ).resolves.toMatchObject({ ok: true });
      const browserConsult = await client.request<{ runId: string }>("talk.client.toolCall", {
        sessionKey: browserKey,
        voiceSessionId: browser.voiceSessionId,
        callId: randomUUID(),
        name: "openclaw_agent_consult",
        args: { question: "Complete the isolated browser consult during drain" },
      });
      expect(browserConsult.runId).toBeTruthy();
      // Prove these requests were admitted before this exact lease resumed/expired,
      // not merely accepted after the controller's bounded wait completed.
      expect(
        await client.request("gateway.suspend.status", {
          suspensionId: firstVoiceLease,
          includeLifecycle: true,
        }),
      ).toMatchObject({ status: "draining", ...target });
      await vi.waitFor(() => expect(provider.events).toContain("consult-completed"), waitOptions);
      const voiceDeferred = await voiceDeferredPromise;
      expect(voiceDeferred).toMatchObject({
        code: 75,
        receipt: { outcome: "deferred", predecessorProcessInstanceId: target.processInstanceId },
      });
      expect(await rpc("system.info", {})).toMatchObject(target);
      const audioBefore = provider.events.filter((event) => event === "audio").length;
      const consultsBefore = provider.events.filter(
        (event) => event === "consult-completed",
      ).length;
      await relayClient.request("talk.session.appendAudio", {
        sessionId: relay.sessionId,
        audioBase64: Buffer.from([0, 0, 0, 0]).toString("base64"),
      });
      await vi.waitFor(
        () =>
          expect(provider.events.filter((event) => event === "audio").length).toBeGreaterThan(
            audioBefore,
          ),
        waitOptions,
      );
      await vi.waitFor(() => {
        expect(
          provider.events.filter((event) => event === "consult-completed").length,
        ).toBeGreaterThan(consultsBefore);
      }, waitOptions);
      await vi.waitFor(async () => {
        const history = await client!.request("chat.history", {
          sessionKey: browserKey,
          limit: 10,
        });
        expect(JSON.stringify(history)).toContain("LIFECYCLE_CONSULT_COMPLETED");
      }, waitOptions);

      // A real accepted provider consult remains native work after audio disconnect.
      provider.hold();
      const modelBefore = provider.events.filter((event) => event === "model-start").length;
      await relayClient.request("talk.session.appendAudio", {
        sessionId: relay.sessionId,
        audioBase64: Buffer.from([0, 0, 0, 0]).toString("base64"),
      });
      await vi.waitFor(
        () =>
          expect(provider.events.filter((event) => event === "model-start").length).toBeGreaterThan(
            modelBefore,
          ),
        waitOptions,
      );
      const completionBefore = provider.events.filter(
        (event) => event === "consult-completed",
      ).length;
      const finalObservation = observations.length;
      const completedPromise = runController(120);
      void completedPromise.catch(() => undefined);
      const finalLease = await waitForControllerLease(finalObservation);
      await disconnectGatewayClient(relayClient);
      relayClient = undefined;
      await disconnectGatewayClient(client);
      client = undefined;
      await vi.waitFor(
        () => expect(provider.events.filter((event) => event === "provider-close").length).toBe(2),
        waitOptions,
      );
      expect(
        await rpc("gateway.suspend.status", {
          suspensionId: finalLease,
          includeLifecycle: true,
        }),
      ).toMatchObject({
        status: "draining",
        ...target,
        writeCustody: expect.arrayContaining([
          expect.objectContaining({ phase: "talk-final-persistence" }),
        ]),
      });
      provider.releaseProviders();
      await vi.waitFor(
        () =>
          expect(provider.events.filter((event) => event === "provider-finalized").length).toBe(2),
        waitOptions,
      );
      expect(
        await rpc("gateway.suspend.status", {
          suspensionId: finalLease,
          includeLifecycle: true,
        }),
      ).toMatchObject({ status: "draining", ...target });
      await vi.waitFor(async () => {
        const status = await rpc<{ status: string; activeCount: number; writeCustody?: unknown[] }>(
          "gateway.suspend.status",
          { suspensionId: finalLease, includeLifecycle: true },
        );
        expect(status.status).toBe("draining");
        expect(status.activeCount).toBeGreaterThan(0);
        expect(status.writeCustody ?? []).toEqual([]);
      }, waitOptions);
      provider.releaseModels();
      await vi.waitFor(
        () =>
          expect(
            provider.events.filter((event) => event === "consult-completed").length,
          ).toBeGreaterThan(completionBefore),
        waitOptions,
      );
      expect(provider.events).not.toContain("consult-failed");
      const completed = await completedPromise;
      expect(completed).toMatchObject({
        code: 0,
        receipt: { outcome: "success", predecessorProcessInstanceId: target.processInstanceId },
      });
      expect(completed.receipt.successorProcessInstanceId).not.toBe(target.processInstanceId);
      expect(await rpc("system.info", {})).toMatchObject({
        processInstanceId: completed.receipt.successorProcessInstanceId,
      });
      expect(
        JSON.stringify(await rpc("chat.history", { sessionKey: relayKey, limit: 30 })),
      ).toContain("ISOLATED_FINAL_PROVIDER_TRANSCRIPT");
    } catch (error) {
      failed = true;
      primaryError = error;
    } finally {
      const cleanupErrors: unknown[] = [];
      for (const cleanup of cleanupSteps) {
        try {
          await cleanup();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length) {
        throw new AggregateError(
          failed ? [primaryError, ...cleanupErrors] : cleanupErrors,
          "Native lifecycle fixture cleanup failed",
          failed ? { cause: primaryError } : undefined,
        );
      }
      if (failed) throw primaryError;
    }
  },
);
