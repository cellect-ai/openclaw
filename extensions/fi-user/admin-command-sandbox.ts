import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/** The parameters OpenClaw's own exec tool takes; a native harness shell names others. */
const EXEC_PARAMS = new Set([
  "title",
  "command",
  "workdir",
  "env",
  "yieldMs",
  "awaitResults",
  "background",
  "closeProcessTree",
  "timeoutSeconds",
  "pty",
  "elevated",
  "host",
  "ask",
  "node",
]);

/**
 * Whether these are OpenClaw exec parameters for a command in the sandbox. A
 * Codex `gateway_exec` or `node_exec` reaches the hook as `exec` with its host
 * pinned, and elevation leaves the sandbox too. A harness's native shell
 * (Codex, Claude Code) is also called `exec` here but takes no `env`; one that
 * sends only `command` cannot be told apart, and the host refuses the rewrite
 * of such a call, so the token never reaches it. A terminal or a command sent
 * to the background outlives the call that was given the token.
 *
 * With no `host` the effective one is configuration's, which a plugin cannot
 * see, so a call that gets a token is also pinned to the sandbox by the caller.
 */
export function runsInSandbox(params: Record<string, unknown>): boolean {
  return (
    typeof params.command === "string" &&
    Object.keys(params).every((key) => EXEC_PARAMS.has(key)) &&
    (params.awaitResults === undefined || typeof params.awaitResults === "boolean") &&
    (params.host === undefined || params.host === "sandbox") &&
    params.node === undefined &&
    !params.elevated &&
    !params.pty &&
    !params.background
  );
}

/** The command's own Fi origin, when it names one that is not `appUrl`. */
export function namesAnotherFi(params: Record<string, unknown>, appUrl: string): boolean {
  const env = isRecord(params.env) ? params.env : {};
  return Object.entries(env).some(
    ([key, value]) =>
      key.toUpperCase() === "FI_APP_URL" &&
      (typeof value !== "string" || value.trim().replace(/\/+$/, "") !== appUrl),
  );
}

/**
 * The host's physical command posture from one current config: agent settings,
 * then defaults, as resolveSandboxConfigForAgent/resolveExecTarget read them.
 * This owner cannot observe a per-session override.
 */
export function adminCommandPosture(cfg: OpenClawPluginApi["config"], adminAgentId: string) {
  // SAFETY: the SDK supplies validated frozen config; this resolver only reads it.
  const agent = resolveAgentConfig(cfg as OpenClawConfig, adminAgentId);
  const defaults = cfg.agents?.defaults?.sandbox;
  const execHost = agent?.tools?.exec?.host ?? cfg.tools?.exec?.host ?? "auto";
  const scope = agent?.sandbox?.scope ?? defaults?.scope ?? "agent";
  const binds = [...(defaults?.docker?.binds ?? []), ...(agent?.sandbox?.docker?.binds ?? [])];
  const readonlyCli = ["/usr/local/bin/cellect", "/repos/fi-runtime"].every((target) => {
    const matches = binds.map((bind) => bind.split(":")).filter((parts) => parts[1] === target);
    return matches.length === 1 && matches[0]?.length === 3 && matches[0][2] === "ro";
  });
  return {
    /** Naming the sandbox and no elevation is what every command already gets. */
    pinIsHarmless:
      (agent?.sandbox?.mode ?? defaults?.mode ?? "off") === "all" &&
      // A sandbox shared with other agents cannot be held for one person.
      scope !== "shared" &&
      (execHost === "auto" || execHost === "sandbox") &&
      (cfg.tools?.elevated?.enabled === false || agent?.tools?.elevated?.enabled === false),
    servesTalk: cfg.talk?.agentId?.trim().toLowerCase() === adminAgentId.toLowerCase(),
    scope,
    readonlyCli,
  };
}
