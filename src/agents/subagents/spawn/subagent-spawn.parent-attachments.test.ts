// Native subagent spawns forward the requester turn's attachments: the files are
// copied into the Gateway-owned attachment store and listed in the child's task
// message, so the child transcript names them and the child can open them itself.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

const callGatewayMock = vi.fn();
const updateSessionStoreMock = vi.fn();

let configOverride: Record<string, unknown> = { ...createSubagentSpawnTestConfig() };
let workspaceDir = "";
let stateDir = "";
let subagentSpawnModule: Awaited<ReturnType<typeof loadSubagentSpawnModuleForTest>>;

beforeAll(async () => {
  subagentSpawnModule = await loadSubagentSpawnModuleForTest({
    callGatewayMock,
    getRuntimeConfig: () => configOverride,
    updateSessionStoreMock,
    workspaceDir: os.tmpdir(),
  });
});

const ctx = {
  agentSessionKey: "agent:main:main",
  agentChannel: "slack" as const,
  agentAccountId: "acct",
  agentTo: "channel:C1",
};

function childTaskMessage(): string {
  const agentCall = callGatewayMock.mock.calls.find(
    (call) => (call[0] as { method?: string }).method === "agent",
  )?.[0] as { params?: { message?: string } } | undefined;
  return agentCall?.params?.message ?? "";
}

describe("spawnSubagentDirect parent-turn attachments", () => {
  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-subagent-parent-media-"));
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-subagent-parent-media-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    configOverride = createSubagentSpawnTestConfig(workspaceDir);
    subagentSpawnModule.resetSubagentRegistryForTests();
    callGatewayMock.mockClear();
    updateSessionStoreMock.mockReset();
    const store: Record<string, Record<string, unknown>> = {};
    updateSessionStoreMock.mockImplementation(async (_storePath: unknown, mutator: unknown) => {
      if (typeof mutator !== "function") {
        throw new Error("missing session store mutator");
      }
      await mutator(store);
      return store;
    });
    setupAcceptedSubagentGatewayMock(callGatewayMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    workspaceDir = "";
    stateDir = "";
  });

  it("copies the parent turn's PDFs into the attachment store and lists them in the child task", async () => {
    const inbound = path.join(workspaceDir, "parent-inbound");
    fs.mkdirSync(inbound);
    const absolutePdf = path.join(inbound, "Terra Legacy plumbing A.pdf");
    fs.writeFileSync(absolutePdf, "%PDF-1.7 A");
    // Sandbox-staged facts carry a workspace-relative path plus their workspace.
    fs.mkdirSync(path.join(workspaceDir, "parent-sandbox", "inputs"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, "parent-sandbox", "inputs", "input-file_b.pdf"),
      "%PDF-1.7 B",
    );

    const result = await subagentSpawnModule.spawnSubagentDirect(
      { task: "Compare the plumbing scope in the attached PDFs." },
      {
        ...ctx,
        parentTurnMedia: [
          {
            path: absolutePdf,
            contentType: "application/pdf",
            fileName: "Terra Legacy plumbing A.pdf",
          },
          {
            path: "inputs/input-file_b.pdf",
            workspaceDir: path.join(workspaceDir, "parent-sandbox"),
            contentType: "application/pdf",
            fileName: "Terra Legacy plumbing B.pdf",
          },
          {
            path: "../escape.pdf",
            workspaceDir: path.join(workspaceDir, "parent-sandbox"),
            fileName: "escape.pdf",
          },
        ],
      },
    );

    expect(result.status).toBe("accepted");
    const message = childTaskMessage();
    expect(message).toContain("Compare the plumbing scope in the attached PDFs.");
    expect(message).toContain("2 file(s) copied for you");
    const refs = [
      ...message.matchAll(
        /(\/\S*\/attachments\/subagents\/main\/[0-9a-f]{32}\/[0-9a-f-]{36}\/(Terra Legacy plumbing [AB]\.pdf)) \(application\/pdf\)/g,
      ),
    ];
    expect(refs.map((ref) => ref[2])).toEqual([
      "Terra Legacy plumbing A.pdf",
      "Terra Legacy plumbing B.pdf",
    ]);
    expect(refs[0]![1].startsWith(stateDir)).toBe(true);
    expect(fs.readFileSync(refs[0]![1], "utf8")).toBe("%PDF-1.7 A");
    expect(fs.readFileSync(refs[1]![1], "utf8")).toBe("%PDF-1.7 B");
    expect(fs.existsSync(path.join(workspaceDir, ".openclaw", "attachments"))).toBe(false);
    expect(message).toContain("not forwarded: escape.pdf: not readable by the gateway");
  });

  it("leaves the child task unchanged when the parent turn has no attachments", async () => {
    const result = await subagentSpawnModule.spawnSubagentDirect({ task: "plain task" }, ctx);

    expect(result.status).toBe("accepted");
    expect(childTaskMessage()).not.toContain("Attachments from the requester's message");
    expect(fs.existsSync(path.join(stateDir, "attachments"))).toBe(false);
  });
});
