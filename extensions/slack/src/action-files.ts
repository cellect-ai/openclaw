import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { root as fsRoot } from "openclaw/plugin-sdk/file-access-runtime";
import type { SlackActionContext } from "./action-context.js";

export type StagedSlackFile = {
  /** Absolute filesystem path: the `path` contract readers and tests rely on. */
  fsPath: string;
  /** Workspace-relative posix reference for outbound media routing. */
  workspacePath: string;
};

export async function stageDownloadedSlackFile(
  downloadedPath: string,
  context: SlackActionContext | undefined,
  fileId?: string,
): Promise<StagedSlackFile> {
  const workspaceDir = context?.mediaWorkspaceDir?.trim();
  if (!workspaceDir) {
    return { fsPath: downloadedPath, workspacePath: downloadedPath };
  }
  const fileName = fileId
    ? `${fileId}-${path.basename(downloadedPath)}`
    : path.basename(downloadedPath);
  const relativePath = path.join("media", "inbound", fileName);
  const workspace = await fsRoot(workspaceDir);
  await workspace.copyIn(relativePath, downloadedPath, {
    mkdir: true,
    sourceHardlinks: "reject",
  });
  return {
    fsPath: path.join(workspaceDir, relativePath),
    workspacePath: relativePath.split(path.sep).join(path.posix.sep),
  };
}

export async function hashSlackFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}
