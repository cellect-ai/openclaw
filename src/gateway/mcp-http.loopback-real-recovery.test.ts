import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

const createdServers = vi.hoisted(() => [] as Server[]);

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      createdServers.push(server);
      return server;
    },
  };
});

import {
  activateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  resolveMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";
import {
  jsonHeaders,
  mcpToolCallBody,
  readOkMcpPayload,
  sendRaw,
} from "./mcp-http.test-support.js";

const admissions: PreparedAgentRunAdmission[] = [];
let state: OpenClawTestState;
let config: OpenClawConfig;

beforeAll(async () => {
  state = await createOpenClawTestState({
    prefix: "openclaw-mcp-real-recovery-",
    layout: "state-only",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  config = {
    agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } },
    tools: { allow: ["write"], fs: { workspaceOnly: true } },
    plugins: { enabled: false },
  };
  await state.writeConfig(config);
});

afterAll(async () => {
  try {
    await closeMcpLoopbackServer();
  } finally {
    admissions.splice(0).forEach((admission) => admission.close());
    await state?.cleanup();
    createdServers.length = 0;
  }
});

async function captureGrant(runtimeOwnerToken: string, runId: string) {
  const admission = prepareAgentRunAdmission({
    cfg: config,
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "schedule", boundary: "cron.agent", state: "present" },
    },
  });
  admissions.push(admission);
  const grant = mintMcpLoopbackClientGrant({
    runtimeOwnerToken,
    admittedRunContext: await admission.admit("gateway"),
    context: {
      sessionKey: "agent:main:mcp-recovery-proof",
      agentId: "main",
      runId,
      workspaceDir: state.workspaceDir,
      senderIsOwner: true,
      trigger: "cron",
      toolsAllow: ["write"],
    },
  });
  const captureKey = `capture-${runId}`;
  expect(
    activateMcpLoopbackClientGrantCapture({ token: grant.token, runtimeOwnerToken, captureKey }),
  ).toBeTruthy();
  return { token: grant.token, captureKey };
}

function writeRequest(
  port: number,
  grant: { token: string; captureKey: string },
  target: string,
  content: string,
) {
  return sendRaw({
    port,
    token: grant.token,
    headers: jsonHeaders({ "x-openclaw-cli-capture-key": grant.captureKey }),
    body: mcpToolCallBody("write", { path: target, content }),
  });
}

it("recovers a real MCP request after the listener closes unexpectedly", async () => {
  await ensureMcpLoopbackServer();
  const oldRuntime = expectDefined(getActiveMcpLoopbackRuntime(), "old MCP runtime");
  const oldServer = expectDefined(createdServers.at(-1), "old MCP server");
  const oldGrant = await captureGrant(oldRuntime.ownerToken, "mcp-recovery-proof");
  const capturedAuthority = expectDefined(
    resolveMcpLoopbackClientGrant({ ...oldGrant, runtimeOwnerToken: oldRuntime.ownerToken }),
    "captured client authority",
  );
  expect(capturedAuthority.isCurrent()).toBe(true);
  expect(
    await readOkMcpPayload(
      await writeRequest(oldRuntime.port, oldGrant, "before.txt", "before retirement"),
    ),
  ).toMatchObject({ result: { isError: false } });
  expect(await readFile(path.join(state.workspaceDir, "before.txt"), "utf8")).toBe(
    "before retirement",
  );

  const closed = once(oldServer, "close");
  oldServer.close();
  await closed;
  expect(getActiveMcpLoopbackRuntime()).toBeUndefined();
  // A replacement port's token mismatch cannot prove the old authority was revoked.
  expect(capturedAuthority.isCurrent()).toBe(false);
  expect(
    resolveMcpLoopbackClientGrant({ ...oldGrant, runtimeOwnerToken: oldRuntime.ownerToken }),
  ).toBeUndefined();

  await ensureMcpLoopbackServer();
  const newRuntime = expectDefined(getActiveMcpLoopbackRuntime(), "new MCP runtime");
  const newServer = expectDefined(createdServers.at(-1), "new MCP server");
  expect(newRuntime.ownerToken).not.toBe(oldRuntime.ownerToken);
  expect(newServer).not.toBe(oldServer);
  const retiredGrantResponse = await writeRequest(
    newRuntime.port,
    oldGrant,
    "retired.txt",
    "must not be written",
  );
  expect(retiredGrantResponse.status).toBe(401);
  expect(await readdir(state.workspaceDir)).toEqual(["before.txt"]);

  const successorGrant = await captureGrant(newRuntime.ownerToken, "mcp-successor-proof");
  expect(
    await readOkMcpPayload(
      await writeRequest(newRuntime.port, successorGrant, "successor.txt", "authorized successor"),
    ),
  ).toMatchObject({ result: { isError: false } });
  expect(await readFile(path.join(state.workspaceDir, "successor.txt"), "utf8")).toBe(
    "authorized successor",
  );
  expect((await readdir(state.workspaceDir)).toSorted()).toEqual(["before.txt", "successor.txt"]);
});
