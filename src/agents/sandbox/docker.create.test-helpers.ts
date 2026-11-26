import fs from "node:fs";
import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { computeSandboxConfigHash } from "./config-hash.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { DOCKER_SANDBOX_ENGINE } from "./container-engine.js";
import type { SandboxConfig } from "./types.js";

type SpawnCall = {
  command: string;
  args: string[];
  globalArgs: string[];
  envFileContents?: string;
};

const resolveDockerSourceNamespace =
  vi.fn<typeof import("./docker-mount-source.js").resolveDockerSourceNamespace>();

function freshSpawnState() {
  return {
    calls: [] as SpawnCall[],
    nextContainerId: 1,
    multiContainers: null as null | Map<
      string,
      {
        id: string;
        running: boolean;
        labels: Record<string, string>;
        mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }>;
      }
    >,

    containerExists: true,
    inspectRunning: true,
    readOnlyRoot: true,
    inspectError: "",
    createError: "",
    imageError: "",
    labelHash: "",
    mounts: "[]",
    tmpfs: null as Record<string, string> | null,
    podmanInfo: "true\tfalse\t\t5.0.0\n",
    podmanConnections: "[]\n",
    podmanMachines: "[]\n",
  };
}
const spawnState = freshSpawnState();

const registryMocks = vi.hoisted(() => ({
  readRegistry: vi.fn().mockResolvedValue({ entries: [] }),
  withSandboxRegistryEntryLock: vi.fn(async (_entry, operation) => operation()),
  readRegistryEntry: vi.fn(),
  readRegisteredSandboxRuntimeIds: vi.fn(),
  removeRegistryEntry: vi.fn(),
  updateRegistry: vi.fn(),
  completeSandboxRegistryReservation: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({ log: vi.fn() }));

function usePodmanMachine() {
  const machine = {
    Name: "podman-machine-default",
    Running: true,
    IdentityPath: "/tmp/podman-machine-default",
    Port: 60000,
    RemoteUsername: "core",
  };
  spawnState.podmanInfo = "true\ttrue\t\t5.0.0\n";
  spawnState.podmanConnections = JSON.stringify([
    {
      Name: machine.Name,
      URI: "ssh://core@127.0.0.1:60000/run/user/501/podman/podman.sock",
      Identity: machine.IdentityPath,
      Default: true,
    },
  ]);
  spawnState.podmanMachines = JSON.stringify([machine]);
}

async function createNamespaceMock() {
  const actual = await vi.importActual<typeof import("./docker-mount-source.js")>(
    "./docker-mount-source.js",
  );
  return {
    parseInspectedSandboxMounts: actual.parseInspectedSandboxMounts,
    translateSandboxMountSources: actual.translateSandboxMountSources,
    resolveDockerSourceNamespace,
  };
}

async function spawnDockerProcess(commandAndArgs: string[]) {
  const [command = "", ...rawArgs] = commandAndArgs;
  const globalArgs: string[] = [];
  let args = rawArgs;
  if (command === "podman") {
    while (["--url", "--identity", "--remote=false"].includes(args[0] ?? "")) {
      const width = args[0] === "--remote=false" ? 1 : 2;
      globalArgs.push(...args.slice(0, width));
      args = args.slice(width);
    }
  }
  const envFileIndex = args.indexOf("--env-file");
  const envFile = envFileIndex === -1 ? undefined : args[envFileIndex + 1];
  const call: SpawnCall = { command, args, globalArgs };
  if (args[0] === "create" && envFile) {
    call.envFileContents = fs.readFileSync(envFile, "utf8");
  }
  spawnState.calls.push(call);

  // Opt-in daemon model: retain independent names, IDs and mount snapshots.
  // Existing tests continue to use the simpler single-container fixture.
  if (spawnState.multiContainers && command === "docker") {
    const containers = spawnState.multiContainers;
    const result = (code: number, stdout = "", stderr = "") => ({
      failed: code !== 0,
      isCanceled: false,
      exitCode: code,
      stdout: Buffer.from(stdout),
      stderr: Buffer.from(stderr),
    });
    if (args[0] === "image" && args[1] === "inspect") return result(0);
    if (args[0] === "create") {
      const name = args[args.indexOf("--name") + 1];
      if (!name || containers.has(name)) return result(1, "", "container name is already in use");
      const labels: Record<string, string> = {};
      const mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }> = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--label") {
          const [key, ...value] = (args[++i] ?? "").split("=");
          if (key) labels[key] = value.join("=");
        } else if (args[i] === "-v") {
          const [source, destination, mode = ""] = (args[++i] ?? "").split(":");
          if (source && destination)
            mounts.push({
              Type: "bind",
              Source: source,
              Destination: destination,
              RW: !mode.split(",").includes("ro"),
            });
        }
      }
      const id = (spawnState.nextContainerId++).toString(16).padStart(64, "0");
      containers.set(name, { id, running: false, labels, mounts });
      return result(0, id);
    }
    const name = args.at(-1) ?? "";
    const entry =
      containers.get(name) ?? [...containers.values()].find((container) => container.id === name);
    if (args[0] === "inspect") {
      if (!entry) return result(1, "", "No such object");
      const format = args[2] ?? "";
      if (format === "{{.State.Running}}") return result(0, `${entry.running}\n`);
      if (
        format ===
        '{{.Id}}\n{{.State.Running}}\n{{.HostConfig.ReadonlyRootfs}}\n{{ index .Config.Labels "openclaw.configHash" }}'
      ) {
        return result(
          0,
          `${entry.id}\n${entry.running}\ntrue\n${entry.labels["openclaw.configHash"] ?? ""}\n`,
        );
      }
      if (format === "{{.Id}}") return result(0, `${entry.id}\n`);
      if (format === '{"Mounts":{{json .Mounts}},"Tmpfs":{{json .HostConfig.Tmpfs}}}') {
        return result(0, JSON.stringify({ Mounts: entry.mounts, Tmpfs: null }));
      }
      const label = format.match(/index \.Config\.Labels "([^"]+)"/);
      if (label) return result(0, `${entry.labels[label[1]!] ?? ""}\n`);
      return result(1, "", `unexpected inspect format: ${format}`);
    }
    if (args[0] === "start" && entry) {
      entry.running = true;
      return result(0);
    }
    if (args[0] === "rm" && entry) {
      const registeredName = [...containers.entries()].find(([, value]) => value === entry)?.[0];
      if (registeredName) containers.delete(registeredName);
      return result(0);
    }
    if (args[0] === "exec" && entry) return result(0);
    return result(1, "", `unexpected docker args: ${args.join(" ")}`);
  }

  const result = (code = 0, stdout = "", stderr = "") => ({
    failed: code !== 0,
    isCanceled: false,
    exitCode: code,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  });
  const missing = () => result(1, "", "No such object");
  if (command !== "docker" && command !== "podman") {
    return result(1, "", `unexpected command: ${command}`);
  }
  if (args[0] === "inspect") {
    const format = args[2];
    if (args[1] === "-f" && format === "{{.State.Running}}") {
      if (spawnState.inspectError) {
        return result(125, "", spawnState.inspectError);
      }
      return spawnState.containerExists ? result(0, `${spawnState.inspectRunning}\n`) : missing();
    }
    if (
      format ===
      '{{.Id}}\n{{.State.Running}}\n{{.HostConfig.ReadonlyRootfs}}\n{{ index .Config.Labels "openclaw.configHash" }}'
    ) {
      if (spawnState.inspectError) {
        return result(125, "", spawnState.inspectError);
      }
      return spawnState.containerExists
        ? result(
            0,
            `${"c".repeat(64)}\n${spawnState.inspectRunning}\n${spawnState.readOnlyRoot}\n${spawnState.labelHash}\n`,
          )
        : missing();
    }
    if (format === "{{.Id}}") {
      return result(0, "c".repeat(64));
    }
    if (format === '{"Mounts":{{json .Mounts}},"Tmpfs":{{json .HostConfig.Tmpfs}}}') {
      return result(
        0,
        JSON.stringify({ Mounts: JSON.parse(spawnState.mounts), Tmpfs: spawnState.tmpfs }),
      );
    }
  }
  if (command === "podman") {
    const output = new Map([
      ["info", spawnState.podmanInfo],
      ["system", spawnState.podmanConnections],
      ["machine", spawnState.podmanMachines],
    ]).get(args[0] ?? "");
    if (output !== undefined) {
      return result(0, output);
    }
  }
  if (args[0] === "image" && args[1] === "inspect" && spawnState.imageError) {
    return result(1, "", spawnState.imageError);
  }
  if (args[0] === "exec" && args.at(-1) === "/proc/self/mountinfo") {
    return result(0, "1 0 8:1 / / rw - ext4 /dev/synthetic rw\n");
  }
  if (args[0] === "rm" && args[1] === "-f") {
    spawnState.containerExists = spawnState.inspectRunning = false;
  } else if (args[0] === "create") {
    if (spawnState.createError) {
      return result(125, "", spawnState.createError);
    }
    if (spawnState.containerExists) {
      return result(1, "", "container name is already in use");
    }
    spawnState.containerExists = true;
    spawnState.inspectRunning = false;
    const label = args.find((arg) => arg.startsWith("openclaw.configHash="));
    spawnState.labelHash = label?.slice("openclaw.configHash=".length) ?? "";
    return result(0, "c".repeat(64));
  } else if (args[0] === "start") {
    spawnState.inspectRunning = true;
  } else if (args[0] !== "exec" && !(args[0] === "image" && args[1] === "inspect")) {
    return result(1, "", `unexpected docker args: ${args.join(" ")}`);
  }
  return result();
}

function createSandboxConfig(
  dns: string[],
  binds?: string[],
  workspaceAccess: "rw" | "ro" | "none" = "rw",
  env: Record<string, string> = { LANG: "C.UTF-8" },
): SandboxConfig {
  const defaults = resolveSandboxConfigForAgent();
  return {
    ...defaults,
    scope: "shared",
    workspaceAccess,
    docker: {
      ...defaults.docker,
      image: "openclaw-sandbox:test",
      containerPrefix: "oc-test-",
      env,
      dns,
      extraHosts: ["host.docker.internal:host-gateway"],
      binds: binds ?? ["/tmp/workspace:/workspace:rw"],
      dangerouslyAllowReservedContainerTargets: true,
    },
  };
}

export function createSandboxContainerTestHarness() {
  let docker: typeof import("./docker.js");
  let prepareSandboxMountPlan: typeof import("./mount-plan.js").prepareSandboxMountPlan;

  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeAll(async () => {
    // mock-isolation: keep container registration in the suite-owned registry fixture.
    vi.doMock("./registry.js", () => registryMocks);
    // mock-isolation: route runtime logging and exits to fixture spies.
    vi.doMock("../../runtime.js", () => ({ defaultRuntime: runtimeMocks }));
    // mock-isolation: model container namespaces without consulting host mount state.
    vi.doMock("./docker-mount-source.js", createNamespaceMock);
    vi.doMock("../../process/exec.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../process/exec.js")>()),
      spawnCommand: spawnDockerProcess,
    }));
  });

  async function computeTestSandboxHash(input: Parameters<typeof computeSandboxConfigHash>[0]) {
    const plan = await prepareSandboxMountPlan({
      engine: DOCKER_SANDBOX_ENGINE,
      workspaceDir: input.workspaceDir,
      agentWorkspaceDir: input.agentWorkspaceDir,
      workdir: input.docker.workdir,
      workspaceAccess: input.workspaceAccess,
      binds: input.docker.binds,
    });
    return computeSandboxConfigHash({ ...input, managedMounts: plan.binds });
  }

  async function ensureSandboxCreateCallForTest(params: {
    cfg: SandboxConfig;
    workspaceDir?: string;
    scopeKey?: string;
    engine?: import("./docker.js").SandboxContainerEngine;
  }): Promise<SpawnCall> {
    const workspaceDir = params.workspaceDir ?? "/tmp/workspace";
    await docker.ensureSandboxContainer({
      scopeKey: params.scopeKey ?? "shared",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      cfg: params.cfg,
      engine: params.engine ?? DOCKER_SANDBOX_ENGINE,
    });

    const createCall = spawnState.calls.find(
      (call) => call.command === (params.engine?.command ?? "docker") && call.args[0] === "create",
    );
    if (!createCall) {
      throw new Error(`expected ${params.engine?.command ?? "docker"} create call`);
    }
    return createCall;
  }

  beforeEach(async () => {
    vi.resetModules();
    ({ prepareSandboxMountPlan } = await import("./mount-plan.js"));
    docker = await import("./docker.js");
    Object.assign(spawnState, freshSpawnState());
    resolveDockerSourceNamespace.mockResolvedValue(undefined);
    registryMocks.readRegistryEntry.mockClear();
    registryMocks.readRegisteredSandboxRuntimeIds.mockClear().mockResolvedValue([]);
    registryMocks.removeRegistryEntry.mockClear().mockResolvedValue(undefined);
    registryMocks.updateRegistry.mockClear().mockResolvedValue(undefined);
    registryMocks.completeSandboxRegistryReservation.mockClear().mockResolvedValue(undefined);
    registryMocks.readRegistry.mockReset().mockResolvedValue({ entries: [] });
    runtimeMocks.log.mockClear();
  });

  return {
    resolveDockerSourceNamespace,
    spawnState,
    registryMocks,
    tempDirs,
    usePodmanMachine,
    createSandboxConfig,
    computeTestSandboxHash,
    ensureSandboxCreateCallForTest,
    ensureSandboxContainer(
      params: Omit<Parameters<typeof docker.ensureSandboxContainer>[0], "engine"> & {
        engine?: import("./docker.js").SandboxContainerEngine;
      },
    ) {
      return docker.ensureSandboxContainer({ engine: DOCKER_SANDBOX_ENGINE, ...params });
    },
    get resolveDockerEnvPolicyEpoch() {
      return docker.resolveDockerEnvPolicyEpoch;
    },
    get PODMAN_SANDBOX_ENGINE() {
      return docker.PODMAN_SANDBOX_ENGINE;
    },
  };
}
