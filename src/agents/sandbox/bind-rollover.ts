import path from "node:path";
import { splitSandboxBindSpec } from "./bind-spec.js";
import { isSandboxHostPathAbsolute } from "./host-paths.js";
import type { SandboxDockerConfig } from "./types.js";

export type ReadOnlyBindRollover = { from: string[]; to: string[] };

function destinations(binds: string[]): string[] {
  const seen = new Set<string>();
  return binds
    .map((bind) => {
      const parsed = splitSandboxBindSpec(bind);
      if (
        !parsed ||
        !isSandboxHostPathAbsolute(parsed.host) ||
        parsed.options !== "ro" ||
        !parsed.container.startsWith("/") ||
        path.posix.normalize(parsed.container) !== parsed.container ||
        seen.has(parsed.container)
      ) {
        throw new Error("Sandbox rollover requires unique, exact read-only resource bindings");
      }
      seen.add(parsed.container);
      return parsed.container;
    })
    .sort();
}

/** This is host configuration authority, never a filename or age heuristic. */
export function validateReadOnlyBindRollover(rollover: ReadOnlyBindRollover): void {
  if (
    !rollover.from.length ||
    rollover.from.length > 16 ||
    rollover.to.length > 16 ||
    JSON.stringify(destinations(rollover.from)) !== JSON.stringify(destinations(rollover.to))
  ) {
    throw new Error("Sandbox rollover must preserve every resource destination and read-only mode");
  }
}

/** Reconstruct complete predecessor configurations, preserving all other security settings. */
export function predecessorDockerConfigs(docker: SandboxDockerConfig): SandboxDockerConfig[] {
  const rollovers = docker.readOnlyBindRollovers ?? [];
  if (rollovers.length > 32) throw new Error("Too many sandbox rollover declarations");
  return rollovers.map((rollover) => {
    validateReadOnlyBindRollover(rollover);
    const current = docker.binds ?? [];
    for (const to of rollover.to) {
      const destination = splitSandboxBindSpec(to)!.container;
      if (
        current.filter((bind) => bind === to).length !== 1 ||
        current.filter((bind) => splitSandboxBindSpec(bind)?.container === destination).length !== 1
      ) {
        throw new Error("Sandbox rollover does not match the configured resource bindings");
      }
    }
    const fromByDestination = new Map(
      rollover.from.map((bind) => [splitSandboxBindSpec(bind)!.container, bind]),
    );
    const byCurrent = new Map(
      rollover.to.map((bind) => [
        bind,
        fromByDestination.get(splitSandboxBindSpec(bind)!.container)!,
      ]),
    );
    return { ...docker, binds: current.map((bind) => byCurrent.get(bind) ?? bind) };
  });
}
