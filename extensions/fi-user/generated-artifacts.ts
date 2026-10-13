import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import JSZip from "jszip";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { root } from "openclaw/plugin-sdk/file-access-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { exchange } from "./fi-delegation.js";
import {
  downloadSlackFile,
  MAX_SLACK_FILE_BYTES,
  slackBotToken,
  type SlackFileInfo,
} from "./slack-files.js";

type Artifact = {
  id: string;
  owner: string;
  workspace: string;
  relativePath: string;
  fileName: string;
  sha256: string;
  mimeType: string;
  sessionId: string;
};
type Delivery = { status: "sending" | "delivered" | "unknown"; messageId?: string };

const types: Record<string, string> = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function store(api: OpenClawPluginApi) {
  return api.runtime.state.openKeyedStore<Artifact>({
    namespace: "generated-artifacts",
    retention: "retained",
  });
}

function assertCurrent(context: OpenClawPluginToolContext) {
  if (!context.assertInvocationCurrent) {
    throw new Error("Generated-file operations require a current host-bound invocation");
  }
  context.assertInvocationCurrent();
}

async function scope(api: OpenClawPluginApi, context: OpenClawPluginToolContext) {
  assertCurrent(context);
  if (!context.workspaceDir || !context.sessionId || !context.sessionKey) {
    throw new Error("Generated-file operations require this conversation's workspace and session");
  }
  const { delegation, identity } = await exchange(api, context);
  const owner = createHash("sha256")
    .update(
      JSON.stringify([
        delegation.user.orgId,
        delegation.user.email.toLowerCase(),
        identity.channel,
        identity.channel === "slack"
          ? identity.requesterSenderId
          : identity.channel === "matrix"
            ? identity.requesterMatrixUserId
            : "fi-session",
        context.agentAccountId,
        context.sessionKey,
        context.sessionId,
      ]),
    )
    .digest("hex");
  assertCurrent(context);
  return { owner, directory: `media/outbound/generated-${owner}`, delegation, identity };
}

function fileName(value: string) {
  if (
    !value ||
    value.length > 180 ||
    value !== path.basename(value) ||
    /[\\/\x00-\x1f]/.test(value)
  ) {
    throw new Error("Use a filename only, not a path");
  }
  if (!types[path.extname(value).toLowerCase()]) {
    throw new Error("Supported outputs: XLSX, DOCX, PPTX, PDF, CSV, TXT, PNG, JPEG");
  }
  return value;
}

async function readBytes(workspace: string, relativePath: string) {
  const boundary = await root(workspace);
  const result = await boundary.read(relativePath, {
    maxBytes: MAX_SLACK_FILE_BYTES,
    hardlinks: "reject",
    symlinks: "reject",
  });
  if (!result.buffer.length) {
    throw new Error("The generated file is empty");
  }
  return result.buffer;
}

async function validateFormat(name: string, bytes: Buffer) {
  const ext = path.extname(name).toLowerCase();
  const magic = bytes.subarray(0, 8);
  const valid = [".xlsx", ".docx", ".pptx"].includes(ext)
    ? magic.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    : ext === ".pdf"
      ? magic.subarray(0, 5).toString() === "%PDF-"
      : ext === ".png"
        ? magic.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : [".jpg", ".jpeg"].includes(ext)
          ? magic[0] === 255 && magic[1] === 216
          : !bytes.includes(0);
  if (!valid) {
    throw new Error("Generated file contents do not match its extension");
  }
  if ([".xlsx", ".docx", ".pptx"].includes(ext)) {
    const zip = await JSZip.loadAsync(bytes);
    const main =
      ext === ".xlsx"
        ? "xl/workbook.xml"
        : ext === ".docx"
          ? "word/document.xml"
          : "ppt/presentation.xml";
    if (!zip.file("[Content_Types].xml") || !zip.file("_rels/.rels") || !zip.file(main)) {
      throw new Error("The generated Office file is not a valid document package");
    }
  }
}

export async function readGeneratedArtifact(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
  artifactId: string,
) {
  const current = await scope(api, context);
  if (!/^ga_[0-9a-f-]{36}$/.test(artifactId)) {
    throw new Error("Invalid generated artifact ID");
  }
  const record = await store(api).lookup(artifactId);
  if (!record || record.owner !== current.owner || record.workspace !== context.workspaceDir) {
    throw new Error("That generated artifact does not belong to this requester and session");
  }
  const bytes = await readBytes(record.workspace, record.relativePath);
  if (createHash("sha256").update(bytes).digest("hex") !== record.sha256) {
    throw new Error("The output changed after registration; validate and register the new version");
  }
  assertCurrent(context);
  return {
    bytes,
    fileName: record.fileName,
    sha256: record.sha256,
    mimeType: record.mimeType,
    provenance: { artifactId, sha256: record.sha256, sessionId: record.sessionId },
  };
}

export async function generatedFileAction(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
  input: {
    action?: string;
    fileName?: string;
    artifactId?: string;
    message?: string;
    via?: string;
  },
) {
  const current = await scope(api, context);
  if (input.action === "prepare") {
    const boundary = await root(context.workspaceDir!);
    // Safe write establishes the output directory without trusting model-supplied paths.
    await boundary.write(`${current.directory}/.output-directory`, "", { mkdir: true });
    return jsonResult({
      status: "ready",
      outputDirectory: `/workspace/${current.directory}`,
      next: "Generate the requested file here, validate its contents, then register with fileName. Saving is not delivery.",
    });
  }
  if (input.action === "register" || input.action === "inspect") {
    const name = fileName(input.fileName ?? "");
    const relativePath = `${current.directory}/${name}`;
    const bytes = await readBytes(context.workspaceDir!, relativePath);
    await validateFormat(name, bytes);
    const mimeType = types[path.extname(name).toLowerCase()]!;
    if (input.action === "inspect") {
      if (!mimeType.startsWith("image/") || bytes.length > 10 * 1024 * 1024) {
        throw new Error(
          "Inspect accepts PNG/JPEG previews up to 10 MB; render a bounded page or crop into the output directory",
        );
      }
      return {
        content: [{ type: "image" as const, data: bytes.toString("base64"), mimeType }],
        details: { inspected: name, bytes: bytes.length },
      };
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const id = `ga_${randomUUID()}`;
    assertCurrent(context);
    await store(api).register(
      id,
      {
        id,
        owner: current.owner,
        workspace: context.workspaceDir!,
        relativePath,
        fileName: name,
        sha256,
        mimeType,
        sessionId: context.sessionId!,
      },
      { assertCurrent: () => assertCurrent(context) },
    );
    return jsonResult({
      status: "generated_not_delivered",
      artifactId: id,
      fileName: name,
      bytes: bytes.length,
      sha256,
      next: "Deliver this artifactId; report completion only after a delivery receipt.",
    });
  }
  const artifact = await readGeneratedArtifact(api, context, input.artifactId ?? "");
  if (current.identity.channel !== "slack" || input.via === "link") {
    throw new Error(
      "Generated artifacts can be attached by Slack DM. For a Fi link, file the artifact in an authorized Library/room first.",
    );
  }
  const deliveryStore = api.runtime.state.openKeyedStore<Delivery>({
    namespace: "generated-artifact-deliveries",
    retention: "retained",
  });
  if (!deliveryStore.withCurrent) {
    throw new Error("Generated-file delivery requires action-bound durable storage");
  }
  const deliveries = deliveryStore.withCurrent({ assertCurrent: () => assertCurrent(context) });
  const key = createHash("sha256")
    .update(`${current.owner}:${artifact.sha256}:${artifact.fileName}`)
    .digest("hex");
  const receipt = await deliveries.lookup(key);
  if (receipt?.status === "delivered") {
    return jsonResult({
      delivered: "slack_dm",
      artifactId: input.artifactId,
      file: artifact.fileName,
      messageId: receipt.messageId,
      reusedReceipt: true,
    });
  }
  if (input.action === "reconcile") {
    const token = slackBotToken(context);
    if (!token) {
      throw new Error("The current Slack account is unavailable for delivery reconciliation");
    }
    async function slackRead<T>(method: string, parameters: Record<string, string>) {
      const response = await fetch(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(parameters),
      });
      const body = (await response.json()) as { ok?: boolean; error?: string } & T;
      if (!response.ok || !body.ok) {
        throw new Error(`Slack delivery check failed: ${body.error ?? response.status}`);
      }
      return body;
    }
    const opened = await slackRead<{ channel?: { id?: string } }>("conversations.open", {
      users: current.identity.requesterSenderId,
    });
    if (!opened.channel?.id) {
      throw new Error("Slack returned no requester DM");
    }
    const history = await slackRead<{ messages?: Array<{ ts?: string; files?: SlackFileInfo[] }> }>(
      "conversations.history",
      {
        channel: opened.channel.id,
        limit: "100",
      },
    );
    let checked = 0;
    for (const message of history.messages ?? []) {
      for (const file of message.files ?? []) {
        if (
          file.name !== artifact.fileName ||
          file.size !== artifact.bytes.length ||
          ++checked > 5
        ) {
          continue;
        }
        const bytes = await downloadSlackFile(token, file);
        if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
          continue;
        }
        if (!message.ts) {
          continue;
        }
        await deliveries.register(key, { status: "delivered", messageId: message.ts });
        return jsonResult({
          delivered: "slack_dm",
          artifactId: input.artifactId,
          file: artifact.fileName,
          messageId: message.ts,
          reconciled: true,
        });
      }
    }
    return jsonResult({
      status: receipt?.status ?? "not_delivered",
      artifactId: input.artifactId,
      next: receipt
        ? "No matching attachment was verified in recent history. Delivery remains uncertain; do not resend or regenerate until reconciled."
        : "The retained artifact can be delivered without regenerating it.",
    });
  }
  const adapter = await api.runtime.channel.outbound.loadAdapter("slack");
  if (!adapter?.sendMedia) {
    throw new Error(
      "Slack file delivery is unavailable; the generated artifact is retained for retry",
    );
  }
  assertCurrent(context);
  if (!(await deliveries.registerIfAbsent(key, { status: "sending" }))) {
    throw new Error(
      "Delivery is already in progress or its outcome is uncertain. Check Slack before retrying; do not regenerate the file.",
    );
  }
  const cfg = context.getRuntimeConfig?.() ?? context.runtimeConfig ?? context.config ?? api.config;
  try {
    assertCurrent(context);
    const sent = await adapter.sendMedia({
      cfg,
      to: `user:${current.identity.requesterSenderId}`,
      text: input.message?.trim() || "Here is the file you asked for.",
      mediaUrl: path.join(context.workspaceDir!, current.directory, artifact.fileName),
      mediaLocalRoots: [path.join(context.workspaceDir!, current.directory)],
      mediaReadFile: async () => artifact.bytes,
      forceDocument: true,
      ...(context.agentAccountId ? { accountId: context.agentAccountId } : {}),
    });
    if (!sent.messageId) {
      throw new Error("Slack returned no delivery receipt");
    }
    await deliveries.register(key, { status: "delivered", messageId: sent.messageId });
    return jsonResult({
      delivered: "slack_dm",
      artifactId: input.artifactId,
      file: artifact.fileName,
      bytes: artifact.bytes.length,
      messageId: sent.messageId,
    });
  } catch (error) {
    // Only a definitive platform rejection permits a new send. A transport
    // timeout may follow a successful upload and must not produce duplicates.
    const rejected =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "slack_webapi_platform_error" &&
      "data" in error &&
      error.data !== null &&
      typeof error.data === "object" &&
      "error" in error.data &&
      [
        "invalid_auth",
        "missing_scope",
        "account_inactive",
        "channel_not_found",
        "not_in_channel",
        "file_uploads_disabled",
      ].includes(String(error.data.error));
    if (rejected) {
      await deliveries.delete(key);
    } else {
      await deliveryStore.register(key, { status: "unknown" });
    }
    throw error;
  }
}

/** Local file links cannot be opened by a chat recipient. Never publish them as downloads. */
export function withoutInternalDownloadLinks(content: string) {
  return content
    .replace(
      /\[([^\]]+)\]\(<?(?:\/workspace\/|\/tmp\/|file:\/\/)[^\n)]*>?\)/gi,
      "$1 — file delivery has not been verified; no accessible download link is available.",
    )
    .replace(
      /(^|[\s`<(])(?:\/workspace\/|\/tmp\/|file:\/\/)[^\s<>)]*/gi,
      "$1[internal file location — not a download link]",
    );
}
