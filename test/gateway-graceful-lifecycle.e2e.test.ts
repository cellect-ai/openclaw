// Opt-in cross-repository proof: actual controller + CLI/RPC + native process.
// Docker/Infisical and encrypted Matrix transport remain separate release gates.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { runExec } from "../src/process/exec.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

const controllerPath = process.env.OPENCLAW_LIFECYCLE_CONTROLLER_PATH;
const adapterPath = process.env.OPENCLAW_LIFECYCLE_PROCESS_ADAPTER_PATH;

it.skipIf(!controllerPath || !adapterPath)(
  "defers a real busy resident, resumes admission, then commits and restarts the exact native owner",
  { timeout: 300_000 },
  async () => {
    const sourceSha =
      process.env.GIT_COMMIT?.trim() ||
      execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const instance = await createOpenClawTestInstance({
      name: "graceful-controller-native-process",
      stopTimeoutMs: 360_000,
      config: {
        plugins: { enabled: false },
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
    const ownerId = `isolated-process-${randomUUID()}`;
    const server = createServer((request, response) => {
      void (async () => {
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
        const running = child !== undefined && child.exitCode === null && child.signalCode === null;
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
    let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    try {
      await instance.startGateway();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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
        scopes: ["operator.admin", "operator.read", "operator.write"],
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
        const result = await runExec(
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
      await disconnectGatewayClient(client);
      client = undefined;
      const completed = await runController(30);
      expect(completed).toMatchObject({
        code: 0,
        receipt: { outcome: "success", predecessorProcessInstanceId: target.processInstanceId },
      });
      expect(completed.receipt.successorProcessInstanceId).not.toBe(target.processInstanceId);
      expect(await rpc("system.info", {})).toMatchObject({
        processInstanceId: completed.receipt.successorProcessInstanceId,
      });
    } finally {
      if (client) {
        await disconnectGatewayClient(client);
      }
      if (server.listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await instance.cleanup();
    }
  },
);
