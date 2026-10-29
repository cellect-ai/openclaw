import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import JSZip from "jszip";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { root } from "openclaw/plugin-sdk/file-access-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import {
  importMailAttachment,
  mailImportDestination,
  type ProvenRequester,
} from "./admin-mail-import.js";
import { exchange, FI_USER_AGENT_ID } from "./fi-delegation.js";
import {
  downloadSlackFile,
  MAX_SLACK_FILE_BYTES,
  slackBotToken,
  slackConversation,
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
  source?: "downloaded_file";
  origin?: {
    provider: string;
    mailbox: string;
    messageId: string;
    attachmentId: string;
    attachmentPath?: number[];
  };
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

function unsafeFileName(value: string) {
  return (
    !value ||
    value.length > 180 ||
    value !== path.basename(value) ||
    value.includes("\\") ||
    value.includes("/") ||
    /\p{Cc}/u.test(value)
  );
}

function fileName(value: string) {
  if (unsafeFileName(value)) {
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
    provenance: {
      source: record.source ?? ("generated_artifact" as const),
      artifactId,
      sha256: record.sha256,
      sessionId: record.sessionId,
    },
  };
}

/**
 * Provider plugins hand original bytes to the existing requester/session artifact owner.
 * Protocol: a provider calls `capture` before it fetches anything, so a refusal
 * there means nothing was downloaded. Fi-user holds the bytes for its own
 * filing; Fi-admin imports them straight into Fi (`request.importTo`).
 */
export function registerFileArtifactRuntime(
  api: OpenClawPluginApi,
  admin?: {
    isAdminAgent: (agentId: string | undefined) => boolean;
    provenToolRequester: (context: OpenClawPluginToolContext) => ProvenRequester | undefined;
  },
) {
  for (const channelId of ["matrix", "slack", "webchat"]) {
    api.runtime.channel.runtimeContexts.register({
      channelId,
      capability: "fi-file-artifacts",
      context: {
        protocol: "fi-file-artifacts-v1",
        capture(context: OpenClawPluginToolContext, request?: { importTo?: unknown }) {
          if (context.agentId === FI_USER_AGENT_ID) {
            return {
              registerDownload: (input: Parameters<typeof registerDownloadedArtifact>[2]) =>
                registerDownloadedArtifact(api, context, input),
            };
          }
          // Fi-admin's workspace is shared across its sessions, so it never
          // holds a requester's file: the bytes go to Fi in the same call.
          if (admin?.isAdminAgent(context.agentId)) {
            const destination = mailImportDestination(request?.importTo);
            if (!admin.provenToolRequester(context)) {
              throw new Error(
                "Importing a mail attachment needs this turn's verified requester. Nothing was downloaded or imported.",
              );
            }
            return {
              registerDownload: (input: Parameters<typeof importMailAttachment>[3]) =>
                importMailAttachment(
                  context,
                  destination,
                  () => admin.provenToolRequester(context),
                  input,
                ),
            };
          }
          throw new Error(
            "Downloading a mail attachment for filing is available only to Fi-user and Fi-admin; this agent cannot download or file it. Nothing was downloaded.",
          );
        },
      },
    });
  }
}

export async function registerDownloadedArtifact(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
  input: {
    bytes: Uint8Array;
    fileName: string;
    mimeType?: string;
    origin: NonNullable<Artifact["origin"]>;
  },
) {
  const current = await scope(api, context);
  const name = input.fileName;
  if (unsafeFileName(name) || name.startsWith(".")) {
    throw new Error("Use the attachment's filename only, not a path");
  }
  if (!input.bytes.length || input.bytes.length > MAX_SLACK_FILE_BYTES) {
    throw new Error("Downloaded files must be between 1 byte and 200 MB");
  }
  const bytes = Buffer.from(input.bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const mimeType = input.mimeType || "application/octet-stream";
  // An interrupted download repeats the same custody, not a second upload identity.
  const key = createHash("sha256")
    .update(JSON.stringify([current.owner, input.origin, name, mimeType, sha256]))
    .digest("hex");
  const id = `ga_${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20, 32)}`;
  const relativePath = `${current.directory}/${id}/${name}`;
  const boundary = await root(context.workspaceDir!);
  assertCurrent(context);
  await boundary.write(relativePath, bytes, { mkdir: true });
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
      source: "downloaded_file",
      origin: input.origin,
    },
    { assertCurrent: () => assertCurrent(context) },
  );
  return {
    status: "downloaded_not_filed",
    artifactId: id,
    fileName: name,
    bytes: bytes.length,
    sha256,
    source: "downloaded_file",
    next: "Upload this artifactId with fi_user_dataroom action=upload_file; retain it until filing is confirmed.",
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
      "Generated artifacts can be attached in the current Slack conversation. For a Fi link, file the artifact in an authorized Library/room first.",
    );
  }
  const inDirect = /^agent:[^:]+:slack:direct:/i.test(context.sessionKey ?? "");
  const toDm = input.via === "dm" || inDirect;
  const conversation = toDm ? null : slackConversation(context);
  if (!toDm && (!conversation || conversation.kind === "direct")) {
    throw new Error(
      "The current Slack conversation is unavailable; no file was sent. Do not fall back to a DM.",
    );
  }
  const target: {
    delivered: "slack_dm" | "slack_channel" | "slack_thread";
    to: string;
    channelId?: string;
    threadId?: string;
  } = toDm
    ? { delivered: "slack_dm", to: `user:${current.identity.requesterSenderId}` }
    : {
        delivered: conversation!.threadTs ? "slack_thread" : "slack_channel",
        to: `channel:${conversation!.channelId}`,
        channelId: conversation!.channelId,
        ...(conversation!.threadTs ? { threadId: conversation!.threadTs } : {}),
      };
  const recovery =
    input.action === "reconcile" && !inDirect && toDm
      ? {
          recoveryOnly: true,
          next: "The prior DM is reconciled. Deliver the retained artifact in the originating conversation; use via=dm only if the requester explicitly asked for DM delivery.",
        }
      : {};
  const deliveryStore = api.runtime.state.openKeyedStore<Delivery>({
    namespace: "generated-artifact-deliveries",
    retention: "retained",
  });
  if (!deliveryStore.withCurrent) {
    throw new Error("Generated-file delivery requires action-bound durable storage");
  }
  const deliveries = deliveryStore.withCurrent({ assertCurrent: () => assertCurrent(context) });
  const dmKey = createHash("sha256")
    .update(`${current.owner}:${artifact.sha256}:${artifact.fileName}`)
    .digest("hex");
  // Preserve receipts for the shipped DM path. A receipt from that destination
  // must never count as delivery to the collaborative source conversation.
  const key = toDm
    ? dmKey
    : createHash("sha256")
        .update(`${dmKey}:${target.to}:${target.threadId ?? ""}`)
        .digest("hex");
  if (!toDm) {
    const previousDm = await deliveries.lookup(dmKey);
    if (previousDm && previousDm.status !== "delivered") {
      throw new Error(
        "A prior DM delivery remains uncertain. Reconcile it with via=dm before sending this artifact to the conversation.",
      );
    }
  }
  const receipt = await deliveries.lookup(key);
  if (receipt?.status === "delivered") {
    return jsonResult({
      delivered: target.delivered,
      ...(target.channelId ? { channelId: target.channelId } : {}),
      ...(target.threadId ? { threadId: target.threadId } : {}),
      artifactId: input.artifactId,
      file: artifact.fileName,
      messageId: receipt.messageId,
      reusedReceipt: true,
      ...recovery,
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
    let channelId = target.channelId;
    if (toDm) {
      const opened = await slackRead<{ channel?: { id?: string } }>("conversations.open", {
        users: current.identity.requesterSenderId,
      });
      if (!opened.channel?.id) {
        throw new Error("Slack returned no requester DM");
      }
      channelId = opened.channel.id;
    }
    const sender = await slackRead<{ user_id?: string }>("auth.test", {});
    if (!sender.user_id) {
      throw new Error("Slack did not identify the current account for delivery reconciliation");
    }
    let checked = 0;
    let cursor: string | undefined;
    for (let page = 0; page < 10 && checked <= 5; page++) {
      assertCurrent(context);
      const history = await slackRead<{
        messages?: Array<{
          ts?: string;
          thread_ts?: string;
          user?: string;
          files?: SlackFileInfo[];
        }>;
        response_metadata?: { next_cursor?: string };
      }>(target.threadId ? "conversations.replies" : "conversations.history", {
        channel: channelId!,
        ...(target.threadId ? { ts: target.threadId } : {}),
        ...(cursor ? { cursor } : {}),
        limit: "100",
      });
      for (const message of history.messages ?? []) {
        // A matching requester upload or another thread is not evidence of our send.
        if (message.user !== sender.user_id) {
          continue;
        }
        if (
          target.threadId &&
          message.ts !== target.threadId &&
          message.thread_ts !== target.threadId
        ) {
          continue;
        }
        for (const file of message.files ?? []) {
          if (
            file.name !== artifact.fileName ||
            file.size !== artifact.bytes.length ||
            ++checked > 5
          ) {
            continue;
          }
          const bytes = await downloadSlackFile(token, file);
          if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256 || !message.ts) {
            continue;
          }
          await deliveries.register(key, { status: "delivered", messageId: message.ts });
          return jsonResult({
            delivered: target.delivered,
            channelId,
            ...(target.threadId ? { threadId: target.threadId } : {}),
            artifactId: input.artifactId,
            file: artifact.fileName,
            messageId: message.ts,
            reconciled: true,
            ...recovery,
          });
        }
      }
      const next = history.response_metadata?.next_cursor?.trim();
      if (!next || next === cursor) {
        break;
      }
      cursor = next;
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
      to: target.to,
      ...(target.threadId ? { threadId: target.threadId } : {}),
      // One physical attachment send: a later caption chunk failure must not
      // erase the claim for a file Slack has already accepted.
      text: "",
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
      delivered: target.delivered,
      ...(target.channelId ? { channelId: target.channelId } : {}),
      ...(target.threadId ? { threadId: target.threadId } : {}),
      artifactId: input.artifactId,
      file: artifact.fileName,
      bytes: artifact.bytes.length,
      messageId: sent.messageId,
    });
  } catch (error) {
    // Only the delivery owner can prove no recipient-visible dispatch began.
    // Even a platform rejection code can follow an ambiguous completion call.
    if (error instanceof PlatformMessageNotDispatchedError) {
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
      /(?:<|&lt;)(?:\/workspace\/|\/tmp\/|file:\/\/)[^|\n>]*\|([^\n]*?)(?:>|&gt;)/gi,
      "$1 — file delivery has not been verified; no accessible download link is available.",
    )
    .replace(
      /\[([^\]]+)\]\(<?(?:\/workspace\/|\/tmp\/|file:\/\/)[^\n)]*>?\)/gi,
      "$1 — file delivery has not been verified; no accessible download link is available.",
    )
    .replace(
      /(^|[\s`<(])(?:\/workspace\/|\/tmp\/|file:\/\/)[^\s<>)]*/gi,
      "$1[internal file location — not a download link]",
    );
}
