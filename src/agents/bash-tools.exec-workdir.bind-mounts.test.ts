/**
 * Exec workdir resolver tests for configured sandbox bind mounts.
 * A bind such as `/app/fi:/repos/fi` makes container paths under `/repos/fi`
 * valid exec workdirs while paths outside the workspace and binds stay refused.
 */
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveExecWorkdir } from "./bash-tools.exec-workdir.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-exec-workdir-bind-"));
  try {
    await run(await realpath(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sandboxConfig(workspaceDir: string): BashSandboxConfig {
  return {
    containerName: "sandbox-workdir-bind-test",
    workspaceDir,
    containerWorkdir: "/workspace",
  };
}

describe("resolveExecWorkdir with sandbox bind mounts", () => {
  it("resolves workdirs under configured sandbox bind mounts", async () => {
    await withTempDir(async (workspaceDir) => {
      await withTempDir(async (repoDir) => {
        const scriptsDir = path.join(repoDir, "scripts");
        await mkdir(scriptsDir);
        const sandbox = {
          ...sandboxConfig(workspaceDir),
          bindMounts: [{ containerPath: "/repos/fi", hostPath: repoDir }],
        };

        await expect(
          resolveExecWorkdir({ host: "sandbox", workdir: "/repos/fi", sandbox }),
        ).resolves.toEqual({
          kind: "sandbox",
          hostCwd: repoDir,
          containerCwd: "/repos/fi",
          scriptPreflightCwd: repoDir,
        });
        await expect(
          resolveExecWorkdir({ host: "sandbox", workdir: "/repos/fi/scripts/", sandbox }),
        ).resolves.toEqual({
          kind: "sandbox",
          hostCwd: scriptsDir,
          containerCwd: "/repos/fi/scripts",
          scriptPreflightCwd: scriptsDir,
        });
        await expect(
          resolveExecWorkdir({ host: "sandbox", workdir: "/repos/fi/missing", sandbox }),
        ).resolves.toEqual({ kind: "unavailable", requestedCwd: "/repos/fi/missing" });
        await expect(
          resolveExecWorkdir({ host: "sandbox", workdir: "/repos/fi/../etc", sandbox }),
        ).resolves.toEqual({ kind: "unavailable", requestedCwd: "/repos/fi/../etc" });
        await expect(
          resolveExecWorkdir({ host: "sandbox", workdir: "/repos/fix", sandbox }),
        ).resolves.toEqual({ kind: "unavailable", requestedCwd: "/repos/fix" });
        await expect(
          resolveExecWorkdir({ host: "sandbox", workdir: "/repos", sandbox }),
        ).resolves.toEqual({ kind: "unavailable", requestedCwd: "/repos" });
      });
    });
  });

  it("rejects bind-mount workdir symlinks that escape the bind source", async () => {
    await withTempDir(async (workspaceDir) => {
      await withTempDir(async (repoDir) => {
        await withTempDir(async (outsideDir) => {
          await symlink(outsideDir, path.join(repoDir, "escape"));
          await expect(
            resolveExecWorkdir({
              host: "sandbox",
              workdir: "/repos/fi/escape",
              sandbox: {
                ...sandboxConfig(workspaceDir),
                bindMounts: [{ containerPath: "/repos/fi", hostPath: repoDir }],
              },
            }),
          ).resolves.toEqual({ kind: "unavailable", requestedCwd: "/repos/fi/escape" });
        });
      });
    });
  });

  it("passes bind-mount workdirs through when the bind source is not visible to the gateway", async () => {
    await withTempDir(async (workspaceDir) => {
      const hiddenHostPath = path.join(workspaceDir, "..", "openclaw-absent-bind-source-xyz");
      const sandbox = {
        ...sandboxConfig(workspaceDir),
        bindMounts: [{ containerPath: "/repos/fi", hostPath: hiddenHostPath }],
      };

      await expect(
        resolveExecWorkdir({ host: "sandbox", workdir: "/repos/fi/src", sandbox }),
      ).resolves.toEqual({
        kind: "sandbox",
        hostCwd: workspaceDir,
        containerCwd: "/repos/fi/src",
        scriptPreflightCwd: null,
      });
      await expect(
        resolveExecWorkdir({ host: "sandbox", workdir: "/srv/other", sandbox }),
      ).resolves.toEqual({ kind: "unavailable", requestedCwd: "/srv/other" });
    });
  });
});
