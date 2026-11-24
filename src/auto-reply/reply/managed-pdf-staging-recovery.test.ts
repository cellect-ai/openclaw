import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, assert, describe, expect, it, vi } from "vitest";
import { createReadTool } from "../../agents/sessions/tools/read.js";
import {
  declareAgentWorkspaceAccess,
  registerAgentWorkspaceAccess,
} from "../../agents/workspace-access.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getMediaDir } from "../../media/store.js";
import { getReplyOperationSessionReader } from "../../sessions/session-controller.session-reader.js";
import { getSessionControllerEntryForOperation } from "../../sessions/session-controller.state.js";
import { waitForReplyRunSuccessorAdmission } from "../../sessions/session-controller.wait.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  prepareReplyAttachmentPaths,
  recoverManagedPdfStagingFailure,
} from "./managed-pdf-staging-recovery.js";
import { admitReplyTurn } from "./reply-turn-admission.js";
import { stageReplyMedia } from "./stage-reply-media.js";

const dirs = useSessionStoreTempDirs(afterAll, "openclaw-pdf-recovery-");
afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});
const ioError = () =>
  Object.assign(new Error("staging disk full"), { code: "ENOSPC", syscall: "mkdir" });
async function withFixture(
  run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  configure?: (cfg: OpenClawConfig) => void,
) {
  const fixture = await setup(configure);
  try {
    await run(fixture);
  } finally {
    await fixture.cleanup();
  }
}
async function setup(configure?: (cfg: OpenClawConfig) => void) {
  const root = dirs.make();
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const workspaceDir = path.join(root, "workspace");
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:pdf-recovery",
    storePath: path.join(root, "agents", "main", "sessions", "sessions.json"),
  };
  const cfg: OpenClawConfig = {
    agents: {
      entries: { main: { workspace: workspaceDir } },
      defaults: { sandbox: { mode: "off" } },
    },
    session: { store: scope.storePath },
    tools: { profile: "coding" },
    plugins: { enabled: false },
  };
  configure?.(cfg);
  setRuntimeConfigSnapshot(cfg);
  await replaceSessionEntry(scope, {
    sessionId: "pdf-session",
    lifecycleRevision: "pdf-revision",
    updatedAt: 10,
  });
  const admission = await admitReplyTurn({
    ...scope,
    sessionId: "pdf-session",
    kind: "visible",
    resetTriggered: false,
  });
  assert(admission.status === "owned" && admission.databaseClaim);
  const target = getSessionControllerEntryForOperation(admission.operation).target;
  const cleanup = async () => {
    admission.operation.complete();
    await waitForReplyRunSuccessorAdmission(scope.sessionKey, null, { target });
  };
  try {
    const reader = getReplyOperationSessionReader(admission.operation);
    assert(reader);
    const { entry: sessionEntry } = await reader.readEntry(() => {});
    const filePath = path.join(getMediaDir(), "inbound", "report.pdf");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "%PDF-1.7\nsynthetic document\n%%EOF\n");
    const controller = new AbortController();
    const policy: Parameters<typeof recoverManagedPdfStagingFailure>[0]["policy"] = {
      cfg,
      ...scope,
      workspaceDir,
      stagedAttachmentCount: 0,
      sessionEntry,
      sessionCtx: {
        SessionKey: scope.sessionKey,
        media: [
          { path: filePath, url: "media://inbound/report.pdf", contentType: "application/pdf" },
        ],
      },
      senderIsOwner: true,
      modelProvider: "openai",
      modelId: "gpt-4.1",
    };
    const error = ioError();
    const options = { replyOperation: admission.operation, abortSignal: controller.signal };
    const recover = () =>
      recoverManagedPdfStagingFailure({
        error,
        policy,
        options,
        canDisclose: true,
        assertCurrent() {},
      });
    return {
      cleanup,
      scope,
      cfg,
      policy,
      options,
      controller,
      operation: admission.operation,
      filePath,
      error,
      recover,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

describe("managed PDF staging recovery at the admitted reply owner", () => {
  it("does not reinterpret a failed session baseline as attachment staging", async () =>
    withFixture(async (f) => {
      const stage = vi.fn(async (baseline: (() => Promise<void>) | undefined) => {
        await baseline?.();
        return { staged: new Map<number, string>() };
      });
      const disclose = vi.fn();
      await expect(
        prepareReplyAttachmentPaths({
          beforeStage: async () => {
            throw f.error;
          },
          stage,
          stagedMedia: undefined,
          policy: f.policy,
          options: f.options,
          enableLocalPathSelfServe: disclose,
          contexts: [f.policy.sessionCtx],
          assertCurrent() {},
        }),
      ).rejects.toBe(f.error);
      expect(stage).toHaveBeenCalledOnce();
      expect(disclose).not.toHaveBeenCalled();
    }));

  it("does not disclose partially rewritten inputs", async () =>
    withFixture(async (f) => {
      const disclose = vi.fn();
      await expect(
        prepareReplyAttachmentPaths({
          stage: async () => {
            f.policy.sessionCtx.media![0]!.path = "media/partial/report.pdf";
            throw f.error;
          },
          stagedMedia: undefined,
          policy: f.policy,
          options: f.options,
          enableLocalPathSelfServe: disclose,
          contexts: [f.policy.sessionCtx],
          assertCurrent() {},
        }),
      ).rejects.toBe(f.error);
      expect(disclose).not.toHaveBeenCalled();
    }));

  it("keeps a real managed PDF readable after actual local mkdir failure", async () =>
    withFixture(async (f) => {
      const mkdir = fs.mkdir.bind(fs);
      const stageFailure = vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
        if (String(args[0]) === f.policy.workspaceDir) throw f.error;
        return mkdir(...args);
      });
      const disclose = vi.fn();
      await prepareReplyAttachmentPaths({
        stage: () =>
          stageReplyMedia({
            ctx: f.policy.sessionCtx,
            sessionCtx: f.policy.sessionCtx,
            cfg: f.cfg,
            agentId: f.scope.agentId,
            sessionKey: f.scope.sessionKey,
            workspaceDir: f.policy.workspaceDir,
            sessionEntry: f.policy.sessionEntry,
            abortSignal: f.controller.signal,
          }),
        stagedMedia: undefined,
        policy: f.policy,
        options: f.options,
        enableLocalPathSelfServe: disclose,
        contexts: [f.policy.sessionCtx],
        assertCurrent() {},
      });
      expect(
        stageFailure.mock.calls.some(([target]) => String(target) === f.policy.workspaceDir),
      ).toBe(true);
      expect(disclose).toHaveBeenCalledExactlyOnceWith([f.policy.sessionCtx], undefined);
      const result = await createReadTool(f.policy.workspaceDir).execute("read-pdf", {
        path: f.filePath,
      });
      expect(result.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("binary document [application/pdf]"),
        }),
      ]);
      expect(f.policy.sessionCtx.media?.[0]?.path).toBe(f.filePath);
      expect(await fs.readFile(f.filePath, "utf8")).toContain("%PDF-1.7");
    }));

  it.each(["unknown", "permission", "abort", "wrapped", "missing-syscall"])(
    "preserves the exact %s failure",
    async (kind) =>
      withFixture(async (f) => {
        const error =
          kind === "unknown"
            ? new Error("unknown")
            : kind === "permission"
              ? Object.assign(new Error("permission"), { code: "EACCES", syscall: "mkdir" })
              : kind === "wrapped"
                ? new Error("unclassified wrapper", { cause: f.error })
                : kind === "missing-syscall"
                  ? Object.assign(new Error("unknown origin"), { code: "EIO" })
                  : f.error;
        if (kind === "abort") f.controller.abort(error);
        await expect(
          recoverManagedPdfStagingFailure({
            error,
            policy: f.policy,
            options: f.options,
            canDisclose: true,
            assertCurrent() {},
          }),
        ).rejects.toBe(error);
      }),
  );

  it.each([
    "read-denied",
    "tools-disabled",
    "sandbox",
    "ssh",
    "remote",
    "missing-owner",
    "mixed",
    "wrong-path",
    "non-pdf",
    "no-disclosure",
  ])("refuses %s without disclosing a path", async (kind) =>
    withFixture(
      async (f) => {
        if (kind === "remote") f.policy.sessionCtx.MediaRemoteHost = "remote.example";
        if (kind === "mixed") f.policy.sessionCtx.media!.push({ path: f.filePath });
        if (kind === "wrong-path")
          f.policy.sessionCtx.media![0]!.path = path.join(f.policy.workspaceDir, "unrelated.pdf");
        if (kind === "non-pdf") await fs.writeFile(f.filePath, "plain text masquerading as PDF");
        const disclose = vi.fn();
        await expect(
          prepareReplyAttachmentPaths({
            stage: async () => {
              throw f.error;
            },
            stagedMedia: undefined,
            policy: f.policy,
            options:
              kind === "missing-owner"
                ? {}
                : { ...f.options, disableTools: kind === "tools-disabled" },
            enableLocalPathSelfServe: kind === "no-disclosure" ? undefined : disclose,
            contexts: [f.policy.sessionCtx],
            assertCurrent() {},
          }),
        ).rejects.toBe(f.error);
        expect(disclose).not.toHaveBeenCalled();
      },
      (cfg) => {
        if (kind === "read-denied") cfg.tools = { deny: ["read"] };
        if (kind === "sandbox") cfg.agents = { defaults: { sandbox: { mode: "all" } } };
        if (kind === "ssh") cfg.agents = { defaults: { sandbox: { mode: "off", backend: "ssh" } } };
      },
    ),
  );

  it.each(["declared", "active", "revoked"])(
    "refuses %s remote workspace ownership",
    async (state) =>
      withFixture(async (f) => {
        declareAgentWorkspaceAccess(f.policy.workspaceDir);
        const release =
          state === "declared"
            ? undefined
            : registerAgentWorkspaceAccess(f.policy.workspaceDir, {
                bridge: {
                  readFile: async () => Buffer.from("remote"),
                  writeFile: async () => {},
                  stat: async () => ({ type: "file", size: 6, mtimeMs: 1 }),
                },
              });
        try {
          if (state === "revoked") release?.();
          await expect(f.recover()).rejects.toBe(f.error);
        } finally {
          release?.();
        }
      }),
  );

  it.each(["provider", "config", "config-in-place", "abort", "owner"])(
    "rejects %s revocation during real file validation",
    async (change) =>
      withFixture(async (f) => {
        const open = fs.open.bind(fs);
        let intercepted = false;
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (!intercepted && String(args[0]) === f.filePath) {
            intercepted = true;
            if (change === "provider") declareAgentWorkspaceAccess(f.policy.workspaceDir);
            if (change === "config")
              setRuntimeConfigSnapshot({ ...f.cfg, tools: { deny: ["read"] } });
            if (change === "config-in-place") {
              f.cfg.tools = { deny: ["read"] };
            }
            if (change === "owner") f.operation.complete();
            if (change === "abort") f.controller.abort(new Error("request cancelled"));
          }
          return handle;
        });
        await expect(f.recover()).rejects.toBe(f.error);
        expect(intercepted).toBe(true);
      }),
  );
});
