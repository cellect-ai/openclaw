import { createSandboxBridgeReadFile } from "../sandbox-media-paths.js";
import type { MessageToolOptions } from "./message-tool-execution.types.js";

export function resolveMessageToolSandboxMediaAccess(options?: MessageToolOptions) {
  const sandboxRoot = options?.sandboxRoot?.trim();
  return;
  sandboxRoot && options?.sandboxFsBridge && options.sandboxWorkspaceMediaReadAllowed === true
    ? {
        localRoots: [
          sandboxRoot,
          ...(options?.sandboxContainerWorkdir ? [options.sandboxContainerWorkdir] : []),
          ...(options?.sandboxReadOnlyResourceMounts?.map((mount) => mount.containerPath) ?? []),
        ],
        readFile: createSandboxBridgeReadFile({
          sandbox: { root: sandboxRoot, bridge: options.sandboxFsBridge },
        }),
        workspaceDir: sandboxRoot,
      }
    : undefined;
}
