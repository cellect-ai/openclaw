import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Delegation, ResolvedPluginConfig } from "./fi-delegation.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 512 * 1024;
const COMMAND_TIMEOUT_MS = 60_000;
export const MAX_DRIVE_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_RESULTS = 50;
// GAM exits 60 when a list matches nothing; that is an empty result.
const GAM_NO_ENTITIES_EXIT = 60;

type GamConfig = Pick<ResolvedPluginConfig, "gamBinary" | "gamConfigDir">;

export async function runGam(config: GamConfig, mailbox: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(config.gamBinary, ["user", mailbox, ...args], {
      env: { ...process.env, GAMCFGDIR: config.gamConfigDir },
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return [stdout, stderr].filter(Boolean).join("\n").trim();
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    const output = [failed.stdout, failed.stderr]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join("\n")
      .trim();
    if (failed.code === GAM_NO_ENTITIES_EXIT && /\bGot 0 /.test(output)) {
      return output;
    }
    throw error;
  }
}

/** Accept any positive request and reduce it to GAM's 50-result page. */
export function resultLimit(value: number | undefined): string {
  return String(Math.min(Math.max(Math.trunc(value ?? 10), 1), MAX_RESULTS));
}

export function requireMailbox(delegation: Delegation, service = "Gmail"): string {
  if (!delegation.gmail.enabled || !delegation.gmail.mailbox) {
    throw new Error(`${service} is not available for ${delegation.user.email}`);
  }
  return delegation.gmail.mailbox;
}

export async function downloadedFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

export type DriveFileMetadata = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
};

export async function driveFileMetadata(
  config: GamConfig,
  mailbox: string,
  fileId: string,
): Promise<DriveFileMetadata> {
  const output = await runGam(config, mailbox, [
    "info",
    "drivefile",
    `id:${fileId}`,
    "fields",
    "id,name,mimetype,size",
    "formatjson",
  ]);
  const line = output
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("{"));
  if (!line) {
    throw new Error("Google Drive returned invalid file metadata");
  }
  const metadata = JSON.parse(line) as Partial<DriveFileMetadata>;
  if (!metadata.id || !metadata.name || !metadata.mimeType) {
    throw new Error("Google Drive returned incomplete file metadata");
  }
  return metadata as DriveFileMetadata;
}

export function driveExportArgs(mimeType: string): string[] {
  if (mimeType === "application/vnd.google-apps.document") {
    return ["format", "txt"];
  }
  if (mimeType === "application/vnd.google-apps.presentation") {
    return ["format", "pdf"];
  }
  return [];
}

/**
 * Download one file from the requester's own Drive into a private temp dir.
 * Google Docs/Sheets/Slides are exported to their Office/PDF form so the bytes
 * can be filed or delivered. The caller removes `tempDir`.
 */
export async function downloadDriveFile(params: {
  config: GamConfig;
  mailbox: string;
  fileId: string;
  exportArgs?: (mimeType: string) => string[];
}): Promise<{ tempDir: string; filePath: string; metadata: DriveFileMetadata }> {
  const metadata = await driveFileMetadata(params.config, params.mailbox, params.fileId);
  if (metadata.mimeType === "application/vnd.google-apps.folder") {
    throw new Error("Folders cannot be downloaded; choose a file inside the folder");
  }
  const declaredSize = metadata.size ? Number(metadata.size) : 0;
  if (Number.isFinite(declaredSize) && declaredSize > MAX_DRIVE_FILE_BYTES) {
    throw new Error(`Google Drive file exceeds the ${MAX_DRIVE_FILE_BYTES / 1024 / 1024} MB limit`);
  }
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fi-user-drive-"));
  try {
    await runGam(params.config, params.mailbox, [
      "get",
      "drivefile",
      `id:${params.fileId}`,
      ...(params.exportArgs ?? driveExportArgs)(metadata.mimeType),
      "targetfolder",
      tempDir,
      "overwrite",
      "true",
      "showprogress",
      "false",
    ]);
    const files = await downloadedFiles(tempDir);
    const filePath = files[0];
    if (files.length !== 1 || !filePath) {
      throw new Error(`Expected one downloaded Drive file but found ${files.length}`);
    }
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_DRIVE_FILE_BYTES) {
      throw new Error(
        `Google Drive file exceeds the ${MAX_DRIVE_FILE_BYTES / 1024 / 1024} MB limit`,
      );
    }
    return { tempDir, filePath, metadata };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

/** Office/PDF export for filing a Google-native file as a document. */
export function driveFilingExportArgs(mimeType: string): string[] {
  if (mimeType === "application/vnd.google-apps.document") {
    return ["format", "docx"];
  }
  if (mimeType === "application/vnd.google-apps.spreadsheet") {
    return ["format", "xlsx"];
  }
  if (mimeType === "application/vnd.google-apps.presentation") {
    return ["format", "pdf"];
  }
  return [];
}

const ADDRESS_HEADER = /^\s*(?:from|to|cc|delivered-to)\s*:(.*)$/i;
const ADDR_SPEC = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+$/;

/**
 * The addr-specs of one RFC 5322 address-list header value, lowercased.
 * Display names, quoted strings and comments never count: only the address
 * inside `<…>`, or a bare address when there is no angle address. Malformed
 * entries yield nothing.
 */
export function headerAddresses(value: string): string[] {
  const addresses: string[] = [];
  let bare = "";
  let angle: string | undefined;
  let angleBuffer: string | undefined;
  let quoted = false;
  let comment = 0;
  const flush = () => {
    const candidate = (angle ?? bare).replace(/^.*:/, "").trim().toLowerCase();
    if (angleBuffer === undefined && ADDR_SPEC.test(candidate)) {
      addresses.push(candidate);
    }
    bare = "";
    angle = undefined;
    angleBuffer = undefined;
  };
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quoted || comment > 0) {
      if (char === "\\") {
        index += 1;
      } else if (quoted && char === '"') {
        quoted = false;
      } else if (!quoted && char === "(") {
        comment += 1;
      } else if (!quoted && char === ")") {
        comment -= 1;
      }
    } else if (angleBuffer !== undefined) {
      if (char === ">") {
        angle = angleBuffer;
        angleBuffer = undefined;
      } else {
        angleBuffer += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === "(") {
      comment = 1;
    } else if (char === "<") {
      angleBuffer = "";
    } else if (char === "," || char === ";") {
      flush();
    } else if (char === ":") {
      // A group name ("Team: a@x, b@y;") is not an address.
      bare = "";
    } else {
      bare += char;
    }
  }
  flush();
  return addresses;
}

/**
 * Addresses named by the From, To, Cc and Delivered-To headers in GAM's
 * headers-only `show messages` output. The caller must not request the body:
 * quoted headers in forwarded mail would otherwise count.
 */
export function messageHeaderAddresses(output: string): Set<string> {
  const addresses = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const header = ADDRESS_HEADER.exec(line);
    for (const address of header ? headerAddresses(header[1] ?? "") : []) {
      addresses.add(address);
    }
  }
  return addresses;
}
