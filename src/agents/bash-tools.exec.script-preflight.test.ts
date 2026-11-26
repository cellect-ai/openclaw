import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { detectUnsafeExecControlShellCommand } from "../infra/exec-control-command-guard.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import type { processGatewayAllowlist } from "./bash-tools.exec-host-gateway.js";
import { createExecTool } from "./bash-tools.exec-run.js";

const processGatewayAllowlistMock = vi.hoisted(() =>
  vi.fn<typeof processGatewayAllowlist>(async () => ({ allowWithoutEnforcedCommand: true })),
);
vi.mock("./bash-tools.exec-host-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bash-tools.exec-host-gateway.js")>()),
  processGatewayAllowlist: processGatewayAllowlistMock,
}));
vi.mock("./bash-tools.exec-host-node.js", () => ({
  executeNodeHostCommand: async () => {
    throw new Error("node host execution is not used by script preflight tests");
  },
}));
vi.mock("../utils/delivery-context.shared.js", () => ({
  normalizeDeliveryContext: (value: unknown) => value,
}));

const isWin = process.platform === "win32";
const describeNonWin = isWin ? describe.skip : describe;
// Commands settle before their fixture cwd is removed.
const createGuardTool = () =>
  createExecTool({ host: "gateway", security: "full", ask: "on-miss", allowBackground: false });
const runExec = (command: string, workdir = process.cwd()) =>
  createGuardTool().execute("call-exec-guard", { command, workdir });
const withScripts = <T>(files: Record<string, string>, run: (workdir: string) => Promise<T>) =>
  withTempDir("openclaw-exec-guard-", async (workdir) => {
    for (const [name, source] of Object.entries(files)) {
      const file = path.join(workdir, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, source, "utf-8");
    }
    return await run(workdir);
  });
const execScripts = (command: string, files: Record<string, string>) =>
  withScripts(files, (workdir) => runExec(command, workdir));

beforeEach(() => {
  processGatewayAllowlistMock.mockReset();
  processGatewayAllowlistMock.mockResolvedValue({ allowWithoutEnforcedCommand: true });
});

it("blocks interactive channel login commands from exec", async () => {
  for (const command of [
    "openclaw channels login --channel whatsapp --verbose",
    "pnpm exec openclaw channels login --channel whatsapp",
    "sudo -u openclaw bash -lc 'openclaw channels login --channel whatsapp'",
    "sudo -EH bash -lc 'openclaw channels login --channel whatsapp'",
    "env env env env env env openclaw channels login --channel whatsapp",
    "env -S 'openclaw channels' login --channel whatsapp",
  ]) {
    await expect(runExec(command)).rejects.toThrow(
      /exec cannot run interactive OpenClaw channel login commands/,
    );
  }
});

describeNonWin("exec launch preparation", () => {
  it("releases prepared launch authority when approval preparation finishes after cancellation", async () => {
    const controller = new AbortController();
    const releaseSpawn = vi.fn();
    processGatewayAllowlistMock.mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled during approval preparation"));
      return { allowWithoutEnforcedCommand: true, releaseSpawn };
    });
    await expect(
      createGuardTool().execute(
        "cancelled-preparation",
        { command: "echo must-not-launch" },
        controller.signal,
      ),
    ).rejects.toThrow("cancelled during approval preparation");
    expect(releaseSpawn).toHaveBeenCalledOnce();
  });

  // The removed script preflight refused these; Python and Node now report their own errors.
  it.each([
    ["python3 bad.py", { "bad.py": "payload = $DM_JSON\n" }],
    ["cat bad.py | python3", { "bad.py": 'print("ok")\n' }],
    ['bash -c "node bad.js"', { "bad.js": 'process.stdout.write("ok")\n' }],
  ])("starts %s without a script preflight refusal", async (command, files) => {
    const result = await execScripts(command, files);
    expect(result.details.status).not.toBe("approval-pending");
    expect(JSON.stringify(result)).not.toContain("exec preflight");
  });
});

describeNonWin("exec live OpenClaw state SQLite guard", () => {
  const quote = (value: string) => JSON.stringify(value);

  async function databaseFixture(root: string, relativePath: string) {
    const databasePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    await fs.writeFile(databasePath, "fixture");
    return databasePath;
  }

  const tempDirs = createTempDirTracker();

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    tempDirs.cleanup();
  });

  describe("target analysis", () => {
    let root: string, stateDir: string, databasePath: string;
    async function check(
      commands: string[],
      expected: "live-state-sqlite" | null = "live-state-sqlite",
      workdir = root,
    ) {
      for (const command of commands) {
        await expect(
          detectUnsafeExecControlShellCommand(command, { stateDir, workdir }),
        ).resolves.toBe(expected);
      }
    }
    beforeEach(async () => {
      root = tempDirs.make("openclaw-exec-live-sqlite-");
      stateDir = path.join(root, "state with spaces");
      databasePath = await databaseFixture(stateDir, "state/openclaw.sqlite");
    });
    it("detects direct and carrier-wrapped SQLite targets under the active state directory", async () => {
      await check([
        `sqlite3 --json ${quote(databasePath)}`,
        `sudo -u openclaw env sqlite3 -header -column ${quote(databasePath)}`,
        'sqlite3 -cmd ".timeout 1000" "$OPENCLAW_STATE_DIR/state/openclaw.sqlite"',
        `sqlite3 :memory: ${quote(`.open ${quote(databasePath)}`)}`,
        `sqlite3 :memory: ${quote(`.op ${quote(databasePath)}`)}`,
        `sqlite3 -cmd ${quote(`.open --readonly ${quote(databasePath)}`)} :memory:`,
      ]);
      await check([`cat ${quote(databasePath)}`], null);
    });

    it("detects relative and symlink-aliased live state targets", async () => {
      const aliasDir = path.join(root, "state-alias");
      await databaseFixture(stateDir, "agents/main/state.sqlite");
      await fs.symlink(stateDir, aliasDir);
      await check([
        'sqlite3 "state with spaces/agents/main/state.sqlite"',
        `sqlite3 --readonly ${quote(path.join(aliasDir, "agents", "main", "state.sqlite"))}`,
      ]);
    });

    it("detects live state targets hidden behind file: URI variable spellings", async () => {
      await check([
        'sqlite3 "file:$OPENCLAW_STATE_DIR/state/openclaw.sqlite?mode=ro" "PRAGMA user_version"',
        'sqlite3 "file:${OPENCLAW_STATE_DIR}/state/openclaw.sqlite" "PRAGMA user_version"',
        `sqlite3 -cmd ${quote(`.open ${quote("file:$OPENCLAW_STATE_DIR/state/openclaw.sqlite")}`)} :memory:`,
        `sqlite3 "file:${databasePath}?mode=ro"`,
        // Empty and localhost authorities also expand to a valid absolute file URI.
        'sqlite3 "file://$OPENCLAW_STATE_DIR/state/openclaw.sqlite?mode=ro" "PRAGMA user_version"',
        'sqlite3 "file://${OPENCLAW_STATE_DIR}/state/openclaw.sqlite" "PRAGMA user_version"',
        'sqlite3 "file://localhost$OPENCLAW_STATE_DIR/state/openclaw.sqlite" "PRAGMA user_version"',
        'sqlite3 "FILE://$OPENCLAW_STATE_DIR/state/openclaw.sqlite" "PRAGMA user_version"',
      ]);
      const copy = await databaseFixture(root, "snapshot/openclaw.sqlite");
      await check([`sqlite3 "file:${copy}?mode=ro"`, `sqlite3 "file://${copy}?mode=ro"`], null);
    });

    it("preserves malformed URI fallback and decodes valid file URLs only once", async () => {
      await check([
        `sqlite3 ${quote(`file:${databasePath}%ZZ`)}`,
        'sqlite3 "file:$OPENCLAW_STATE_DIR/state/%ZZ.sqlite"',
        `sqlite3 ${quote(`file:${encodeURI(databasePath)}`)}`,
      ]);
      await check(
        [
          `sqlite3 ${quote(`file:${root}/%2573tate%20with%20spaces/state/openclaw.sqlite`)}`,
          'sqlite3 "file:"',
          `sqlite3 ${quote(`file:${encodeURI(encodeURI(databasePath))}`)}`,
        ],
        null,
      );
    });

    it("detects file: URI targets spelled with $HOME when state lives under HOME", async () => {
      stateDir = path.join(root, "home", ".openclaw");
      await databaseFixture(stateDir, "state/openclaw.sqlite");
      // The guard reads os.homedir(), not process.env.HOME.
      vi.spyOn(os, "homedir").mockReturnValue(path.join(root, "home"));
      await check([
        'sqlite3 "file:$HOME/.openclaw/state/openclaw.sqlite?mode=ro" "PRAGMA user_version"',
        'sqlite3 "$HOME/.openclaw/state/openclaw.sqlite" "PRAGMA user_version"',
      ]);
      await check(['sqlite3 "file:$HOME/snapshots/openclaw.sqlite?mode=ro"'], null);
      // Relative file URIs are root-relative, not relative to the exec workdir.
      await check(
        [`cd ${quote(root)} && sqlite3 "file:data/app.db?mode=ro" "SELECT 1"`],
        null,
        path.join(stateDir, "workspace"),
      );
      await check(
        [`cd ${quote(root)} && sqlite3 "file:$OPENCLAW_STATE_DIR/state/openclaw.sqlite?mode=ro"`],
        "live-state-sqlite",
        path.join(stateDir, "workspace"),
      );
    });
  });

  it.each([false, true])("rejects live SQLite before spawn (URI=%s)", async (uri) => {
    await withTempDir("openclaw-exec-live-sqlite-spawn-", async (root) => {
      const stateDir = path.join(root, "state");
      const databasePath = path.join(stateDir, "state/openclaw.sqlite");
      // Leave live paths empty: fake database contents would poison the tool's own state access.
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      const sqlitePath = path.join(root, "sqlite3");
      const markerPath = path.join(root, "sqlite-spawned");
      await fs.writeFile(sqlitePath, `#!/bin/sh\nprintf spawned > ${quote(markerPath)}\n`, {
        mode: 0o755,
      });
      await withEnvAsync(
        { HOME: root, USERPROFILE: root, OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: stateDir },
        async () => {
          const tool = createGuardTool();
          const target = uri
            ? '"file:$OPENCLAW_STATE_DIR/state/openclaw.sqlite?mode=ro" "PRAGMA user_version"'
            : `:memory: ${quote(`.open ${quote(databasePath)}`)}`;
          await expect(
            tool.execute("call-live-sqlite-uri", {
              command: `${quote(sqlitePath)} ${target}`,
              workdir: root,
            }),
          ).rejects.toThrow(
            /external sqlite3 cannot open databases under the active OpenClaw state directory/,
          );
          await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
          if (!uri) {
            return;
          }
          const copy = await databaseFixture(root, "snapshot/openclaw.sqlite");
          const privateMarkerPath = path.join(root, "private-spawned");
          await fs.writeFile(
            sqlitePath,
            `#!/bin/sh\nprintf spawned > ${quote(privateMarkerPath)}\n`,
            {
              mode: 0o755,
            },
          );
          await tool.execute("call-private-sqlite-uri", {
            command: `${quote(sqlitePath)} "file:${copy}?mode=ro" "PRAGMA user_version"`,
            workdir: root,
          });
          await expect(fs.stat(privateMarkerPath)).resolves.toBeDefined();
        },
      );
    });
  });
});

describeNonWin("sandbox exec script preflight for compound commands", () => {
  const createSandboxPreflightTool = (workspaceDir: string) =>
    createExecTool({
      host: "sandbox",
      security: "full",
      ask: "on-miss",
      allowBackground: false,
      sandbox: {
        containerName: "sandbox-preflight-test",
        workspaceDir,
        containerWorkdir: "/workspace",
        buildExecSpec: async () => ({ argv: ["true"], env: {}, stdinMode: "pipe-closed" }),
      },
    });

  async function withScripts(run: (workspaceDir: string) => Promise<void>) {
    await withTempDir("openclaw-exec-sandbox-preflight-", async (tmp) => {
      await fs.mkdir(path.join(tmp, "scripts"));
      await fs.writeFile(path.join(tmp, "good.py"), "print('ok')\n", "utf-8");
      await fs.writeFile(path.join(tmp, "scripts", "good.js"), "console.log('ok');\n", "utf-8");
      await fs.writeFile(path.join(tmp, "bad.py"), "payload = $DM_JSON\n", "utf-8");
      await fs.writeFile(path.join(tmp, "scripts", "bad.py"), "payload = $DM_JSON\n", "utf-8");
      await run(tmp);
    });
  }

  it.each([
    ["an && chain with a known interpreter script", "python3 good.py && libreoffice --version"],
    ["a chain whose interpreter runs after other commands", "ls && python3 good.py"],
    ["a ; chain of interpreters", "python3 good.py; node scripts/good.js"],
    ["a quoted python heredoc", "python3 - <<'PY'\nimport os\nprint(os.environ['HOME'])\nPY"],
    [
      "a node heredoc followed by another command",
      "node <<'NODE'\nconsole.log(1)\nNODE\necho done",
    ],
    [
      "a script written by heredoc and then run",
      "cat > gen.py <<'EOF'\nprint(1)\nEOF\npython3 gen.py",
    ],
    ["a sh -c payload with a script", "bash -lc 'set -e\ncd scripts\nnode good.js'"],
    ["inline code in a command substitution", 'K=$(python3 -c "print(1)") && python3 good.py'],
  ])("allows %s", async (_name, command) => {
    await withScripts(async (workspaceDir) => {
      const result = await createSandboxPreflightTool(workspaceDir).execute("call-sandbox-ok", {
        command,
      });
      const text = result.content.find((c) => c.type === "text")?.text ?? "";
      expect(text).not.toMatch(/exec preflight:/);
      expect((result.details as { status?: string }).status).toBe("completed");
    });
  });

  it.each([
    ["the second script of an && chain", "python3 good.py && python3 bad.py"],
    ["a script run after cd", "cd scripts && python3 bad.py"],
    ["a script inside a sh -c payload", "bash -c 'echo start; python3 bad.py'"],
    ["a script inside a shell heredoc", "bash <<'SH'\npython3 bad.py\nSH"],
    ["a script inside control flow", "if true; then python3 bad.py; fi"],
    ["a script inside a command substitution", "echo $(python3 bad.py)"],
  ])("validates %s", async (_name, command) => {
    await withScripts(async (workspaceDir) => {
      await expect(
        createSandboxPreflightTool(workspaceDir).execute("call-sandbox-bad", { command }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it.each([
    ["piped program source", "ls && cat bad.py | python3"],
    ["program read from a file redirect", "ls && python3 < bad.py"],
    ["process substitution", "python3 <(cat bad.py)"],
    ["a dynamic script path", 'S=bad.py; python3 "$S" && python3 good.py'],
    [
      "an interpreter hidden behind find -exec",
      "find . -name '*.py' -exec python3 {} \\; && python3 good.py",
    ],
    ["a shell reading its program from a pipe", "cat run.sh | bash && python3 good.py"],
  ])("still fails closed for %s", async (_name, command) => {
    await withScripts(async (workspaceDir) => {
      await expect(
        createSandboxPreflightTool(workspaceDir).execute("call-sandbox-ambiguous", { command }),
      ).rejects.toThrow(/exec preflight: complex interpreter invocation detected/);
    });
  });

  it("keeps failing closed for compound commands on non-sandbox hosts", async () => {
    await withScripts(async (workspaceDir) => {
      await expect(runExec("ls && python3 good.py", workspaceDir)).rejects.toThrow(
        /exec preflight: complex interpreter invocation detected/,
      );
    });
  });
});
