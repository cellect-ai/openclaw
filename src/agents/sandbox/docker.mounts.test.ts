import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSandboxContainerTestHarness } from "./docker.create.test-helpers.js";
import { collectDockerFlagValues } from "./test-args.js";
import { SANDBOX_MOUNT_FORMAT_VERSION } from "./workspace-mounts.js";

describe("ensureSandboxContainer managed mounts", () => {
  const harness = createSandboxContainerTestHarness();
  const {
    resolveDockerSourceNamespace,
    spawnState,
    registryMocks,
    tempDirs,
    createSandboxConfig,
    ensureSandboxCreateCallForTest,
  } = harness;

  it("creates read-only workspace and agent mounts in the daemon namespace", async () => {
    const root = fs.realpathSync(tempDirs.make("openclaw-dood-"));
    for (const dir of ["private", "agent"]) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    vi.mocked(resolveDockerSourceNamespace).mockResolvedValue([
      { type: "bind", source: "/host/state", destination: root, writable: true },
    ]);
    spawnState.containerExists = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);
    await harness.ensureSandboxContainer({
      scopeKey: "shared",
      workspaceDir: path.join(root, "private"),
      agentWorkspaceDir: path.join(root, "agent"),
      cfg: createSandboxConfig([], [], "ro"),
    });
    const binds = collectDockerFlagValues(
      spawnState.calls.find((call) => call.args[0] === "create")?.args ?? [],
      "-v",
    );
    expect(binds).toContain("/host/state/private:/workspace:ro,z");
    expect(binds).toContain("/host/state/agent:/agent:ro,z");
    expect(binds.some((bind) => bind.startsWith(root))).toBe(false);
  });

  it("preserves a hot container after a source change, then recreates it when stopped", async () => {
    const workspaceDir = fs.realpathSync(tempDirs.make("openclaw-dood-"));
    const cfg = createSandboxConfig([], []);
    const params = { scopeKey: "shared", workspaceDir, agentWorkspaceDir: workspaceDir, cfg };
    vi.mocked(resolveDockerSourceNamespace).mockResolvedValue([
      { type: "bind", source: "/host/first", destination: workspaceDir, writable: true },
    ]);
    spawnState.containerExists = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);
    await harness.ensureSandboxContainer(params);
    const firstHash = spawnState.labelHash;
    spawnState.mounts = JSON.stringify([
      { Type: "bind", Source: "/host/first", Destination: "/workspace", RW: true },
    ]);
    registryMocks.readRegistryEntry.mockResolvedValue({
      containerName: "oc-test-shared",
      lastUsedAtMs: Date.now(),
      configHash: firstHash,
    });
    vi.mocked(resolveDockerSourceNamespace).mockResolvedValue([
      { type: "bind", source: "/host/second", destination: workspaceDir, writable: true },
    ]);
    spawnState.calls.length = 0;
    await expect(harness.ensureSandboxContainer(params)).rejects.toThrow(
      "Recreate first: openclaw sandbox recreate --all",
    );
    expect(spawnState.calls.some((call) => ["rm", "create", "start"].includes(call.args[0]!))).toBe(
      false,
    );
    expect(spawnState.labelHash).toBe(firstHash);
    spawnState.inspectRunning = false;
    await harness.ensureSandboxContainer(params);
    expect(spawnState.calls.some((call) => call.args[0] === "rm")).toBe(true);
    expect(spawnState.labelHash).not.toBe(firstHash);
    expect(
      collectDockerFlagValues(
        spawnState.calls.find((call) => call.args[0] === "create")?.args ?? [],
        "-v",
      ),
    ).toContain("/host/second:/workspace:z");
  });

  it.each(["recent", "unknown", "old timestamp", "strict current"])(
    "admits an immutable CLI generation without removing its %s-work predecessor",
    async (activity) => {
      const workspaceDir = fs.realpathSync(tempDirs.make("openclaw-runtime-rollover-"));
      const oldRoot = path.join(workspaceDir, "runtimes", `${"a".repeat(40)}-${"1".repeat(12)}`);
      const newRoot = path.join(workspaceDir, "runtimes", `${"b".repeat(40)}-${"1".repeat(12)}`);
      for (const root of [oldRoot, newRoot]) {
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, "cellect"), "fixture executable\n");
      }
      const binds = (root: string) => [
        `${root}:/repos/fi-runtime:ro`,
        `${root}/cellect:/usr/local/bin/cellect:ro`,
      ];
      const cfg = createSandboxConfig([], binds(oldRoot));
      const params = {
        scopeKey: "agent:fixture:session",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        cfg,
        requireCurrentConfig: activity === "strict current",
      };
      spawnState.multiContainers = new Map();
      const entries = new Map<string, import("./registry.types.js").SandboxRegistryEntry>();
      registryMocks.readRegistry.mockImplementation(async () => ({
        entries: [...entries.values()],
      }));
      registryMocks.readRegistryEntry.mockImplementation(
        async (name: string) => entries.get(name) ?? null,
      );
      registryMocks.updateRegistry.mockImplementation(async (entry) => {
        entries.set(entry.containerName, entry);
      });
      const predecessor = await harness.ensureSandboxContainer(params);
      const oldContainer = spawnState.multiContainers.get(predecessor.containerName);
      expect(oldContainer?.running).toBe(true);
      const priorEntry = entries.get(predecessor.containerName)!;
      if (activity === "old timestamp") priorEntry.lastUsedAtMs = Date.now() - 24 * 60 * 60 * 1000;
      if (activity === "unknown") Reflect.deleteProperty(priorEntry, "lastUsedAtMs");
      cfg.docker.binds = binds(newRoot);
      cfg.docker.readOnlyBindRollovers = [{ from: binds(oldRoot), to: binds(newRoot) }];
      spawnState.calls.length = 0;

      const successor = await harness.ensureSandboxContainer(params);

      expect(spawnState.calls.some((call) => call.args[0] === "rm")).toBe(false);
      expect(successor.containerId).not.toBe(predecessor.containerId);
      expect(spawnState.multiContainers.get(predecessor.containerName)).toBe(oldContainer);
      expect(oldContainer?.running).toBe(true);
      expect(entries.get(predecessor.containerName)?.rolloverRetained).toBe(true);
      expect(spawnState.multiContainers.get(successor.containerName)?.running).toBe(true);
      const create = spawnState.calls.find((call) => call.args[0] === "create");
      expect(create).toBeDefined();
      const successorBinds = collectDockerFlagValues(create!.args, "-v");
      expect(successorBinds).toContain(`${newRoot}:/repos/fi-runtime:ro,z`);
      expect(successorBinds).toContain(`${newRoot}/cellect:/usr/local/bin/cellect:ro,z`);
      expect(successorBinds.some((bind) => bind.startsWith(`${oldRoot}:`))).toBe(false);
      spawnState.calls.length = 0;
      const reused = await harness.ensureSandboxContainer(params);
      expect(reused.containerId).toBe(successor.containerId);
      expect(spawnState.calls.some((call) => ["rm", "create"].includes(call.args[0]!))).toBe(false);
      // Removing the new policy cannot restore timestamp-based deletion of a
      // persisted predecessor, including after configuration rollback.
      cfg.docker.readOnlyBindRollovers = undefined;
      priorEntry.lastUsedAtMs = Date.now() - 24 * 60 * 60 * 1000;
      spawnState.calls.length = 0;
      await expect(harness.ensureSandboxContainer(params)).rejects.toThrow("custody retained");
      expect(spawnState.calls.some((call) => call.args[0] === "rm")).toBe(false);
    },
  );

  it.each(["revoked bind", "access mode"])(
    "does not roll over a hot sandbox when an unrelated %s changes",
    async (change) => {
      const workspaceDir = fs.realpathSync(tempDirs.make("openclaw-runtime-access-"));
      const extra = path.join(workspaceDir, "protected");
      fs.mkdirSync(extra);
      const oldRoot = path.join(workspaceDir, "runtimes", `${"a".repeat(40)}-${"1".repeat(12)}`);
      const newRoot = path.join(workspaceDir, "runtimes", `${"b".repeat(40)}-${"1".repeat(12)}`);
      for (const root of [oldRoot, newRoot]) {
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, "cellect"), "fixture executable\n");
      }
      const runtimeBinds = (root: string) => [
        `${root}:/repos/fi-runtime:ro`,
        `${root}/cellect:/usr/local/bin/cellect:ro`,
      ];
      const cfg = createSandboxConfig([], [...runtimeBinds(oldRoot), `${extra}:/protected:ro`]);
      const params = {
        scopeKey: "agent:fixture:session",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        cfg,
      };
      spawnState.multiContainers = new Map();
      const entries = new Map<string, import("./registry.types.js").SandboxRegistryEntry>();
      registryMocks.readRegistry.mockImplementation(async () => ({
        entries: [...entries.values()],
      }));
      registryMocks.readRegistryEntry.mockImplementation(
        async (name: string) => entries.get(name) ?? null,
      );
      registryMocks.updateRegistry.mockImplementation(async (entry) => {
        entries.set(entry.containerName, entry);
      });
      const predecessor = await harness.ensureSandboxContainer(params);
      spawnState.mounts = JSON.stringify([
        { Type: "bind", Source: workspaceDir, Destination: "/workspace", RW: true },
        { Type: "bind", Source: oldRoot, Destination: "/repos/fi-runtime", RW: false },
        {
          Type: "bind",
          Source: `${oldRoot}/cellect`,
          Destination: "/usr/local/bin/cellect",
          RW: false,
        },
        { Type: "bind", Source: extra, Destination: "/protected", RW: false },
      ]);
      cfg.docker.binds = [
        ...runtimeBinds(newRoot),
        ...(change === "revoked bind" ? [] : [`${extra}:/protected:rw`]),
      ];
      cfg.docker.readOnlyBindRollovers = [
        { from: runtimeBinds(oldRoot), to: runtimeBinds(newRoot) },
      ];
      spawnState.calls.length = 0;
      await expect(harness.ensureSandboxContainer(params)).rejects.toThrow(
        "Sandbox mounts changed",
      );
      expect(
        spawnState.calls.some((call) => ["rm", "create", "start"].includes(call.args[0]!)),
      ).toBe(false);
    },
  );

  it("preserves hot Podman tmpfs removal and replaces it only after stopping", async () => {
    const workspaceDir = tempDirs.make("openclaw-tmpfs-lifecycle-");
    const cfg = createSandboxConfig([], [], "rw");
    cfg.backend = "podman";
    cfg.docker.tmpfs = ["/workspace/cache:rw"];
    const params = {
      scopeKey: "shared",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      cfg,
      engine: harness.PODMAN_SANDBOX_ENGINE,
    };
    spawnState.containerExists = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);
    await harness.ensureSandboxContainer(params);
    const firstHash = spawnState.labelHash;
    spawnState.mounts = JSON.stringify([
      { Type: "bind", Source: workspaceDir, Destination: "/workspace", RW: true },
    ]);
    spawnState.tmpfs = { "/workspace/cache": "rw,nosuid,nodev" };
    cfg.docker.env = { CHANGED: "1" };
    await expect(harness.ensureSandboxContainer(params)).resolves.toBeDefined();
    cfg.docker.tmpfs = [];
    spawnState.calls.length = 0;
    await expect(harness.ensureSandboxContainer(params)).rejects.toThrow("Sandbox mounts changed");
    expect(spawnState.calls.some((call) => ["rm", "create", "start"].includes(call.args[0]!))).toBe(
      false,
    );
    expect(spawnState.labelHash).toBe(firstHash);
    spawnState.inspectRunning = false;
    await harness.ensureSandboxContainer(params);
    const create = spawnState.calls.find((call) => call.args[0] === "create");
    expect(create).toBeDefined();
    expect(collectDockerFlagValues(create!.args, "--tmpfs")).not.toContain("/workspace/cache:rw");
    expect(spawnState.labelHash).not.toBe(firstHash);
  });

  it("applies custom binds after workspace mounts so overlapping binds can override", async () => {
    const workspaceDir = tempDirs.make("openclaw-docker-mounts-");
    const customRoot = tempDirs.make("openclaw-docker-mounts-");
    const customUserFile = path.join(customRoot, "USER.md");
    const cfg = createSandboxConfig(["1.1.1.1"], [`${customUserFile}:/workspace/USER.md:ro`]);
    cfg.docker.dangerouslyAllowExternalBindSources = true;
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const createCall = await ensureSandboxCreateCallForTest({ cfg, workspaceDir });

    const bindArgs = collectDockerFlagValues(createCall.args, "-v");
    const workspaceMountIdx = bindArgs.indexOf(`${workspaceDir}:/workspace:z`);
    const customMountIdx = bindArgs.indexOf(`${customUserFile}:/workspace/USER.md:ro`);
    expect(workspaceMountIdx).toBeGreaterThanOrEqual(0);
    expect(customMountIdx).toBeGreaterThan(workspaceMountIdx);
  });

  it("skips user binds that conflict with protected skill overlays for Podman", async () => {
    const workspaceDir = tempDirs.make("openclaw-docker-mounts-");
    const customRoot = tempDirs.make("openclaw-docker-mounts-");
    fs.mkdirSync(path.join(workspaceDir, "skills", "demo"), { recursive: true });
    const customMount = `${customRoot}:/workspace/skills:rw`;
    const cfg = createSandboxConfig([], [customMount]);
    cfg.backend = "podman";
    cfg.docker.workdir = "/workspace/.";
    cfg.docker.dangerouslyAllowExternalBindSources = true;
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const createCall = await ensureSandboxCreateCallForTest({
      cfg,
      workspaceDir,
      engine: harness.PODMAN_SANDBOX_ENGINE,
    });
    const bindArgs = collectDockerFlagValues(createCall.args, "-v");

    expect(createCall.command).toBe("podman");
    expect(bindArgs).not.toContain(customMount);
    expect(bindArgs).toContain(`${path.join(workspaceDir, "skills")}:/workspace/skills:ro,z`);
  });

  it("stamps the mount format version label on created containers", async () => {
    const workspaceDir = "/tmp/workspace";
    const cfg = createSandboxConfig([]);

    spawnState.inspectRunning = false;
    spawnState.labelHash = "";
    spawnState.mounts = "[]";
    vi.mocked(resolveDockerSourceNamespace).mockResolvedValue(undefined);
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const createCall = await ensureSandboxCreateCallForTest({ cfg, workspaceDir });
    expect(createCall.args).toContain(
      `openclaw.mountFormatVersion=${SANDBOX_MOUNT_FORMAT_VERSION}`,
    );
  });
});
