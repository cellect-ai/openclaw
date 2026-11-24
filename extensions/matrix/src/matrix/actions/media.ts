import { stat } from "node:fs/promises";
import path from "node:path";
import { imageResultFromFile, jsonResult } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { captureChannelReadAuthority } from "openclaw/plugin-sdk/fetch-runtime";
import { root as fsRoot } from "openclaw/plugin-sdk/file-access-runtime";
import { resolveMatrixInboundMediaContent } from "../media-content.js";
import { resolveMatrixMessageAttachment, resolveMatrixReplacementContent } from "../media-text.js";
import { downloadMatrixMedia, resolveMatrixInboundMediaMaxBytes } from "../monitor/media.js";
import type { MatrixClient } from "../sdk.js";

/** Called only inside the ordinary Matrix room-read policy boundary. */
export async function downloadMatrixMessageAttachment(params: {
  client: MatrixClient;
  roomId: string;
  messageId: string;
  mediaMaxMb?: number;
  context: ChannelMessageActionContext;
  original: boolean;
}) {
  const assertCurrent = captureChannelReadAuthority();
  assertCurrent?.();
  const event = await params.client.getEvent(params.roomId, params.messageId);
  assertCurrent?.();
  if (
    event.event_id !== params.messageId ||
    (event.room_id !== undefined && event.room_id !== params.roomId) ||
    event.unsigned?.redacted_because !== undefined ||
    (event.type !== "m.room.message" && event.type !== "m.sticker")
  ) {
    throw new Error("The requested Matrix attachment is unavailable.");
  }
  const content = resolveMatrixReplacementContent(event) ?? event.content;
  if (event.type !== "m.sticker" && !resolveMatrixMessageAttachment(content)) {
    throw new Error("This Matrix message has no downloadable attachment.");
  }
  const media = resolveMatrixInboundMediaContent(content);
  if (!media.url?.startsWith("mxc://")) {
    throw new Error("This Matrix message has no downloadable attachment.");
  }
  // The media URI comes from the exact authorized event, never a tool argument.
  const downloaded = await downloadMatrixMedia({
    client: params.client,
    mxcUrl: media.url,
    file: media.file,
    contentType: media.contentType,
    originalFilename: media.originalFilename,
    sizeBytes: media.sizeBytes,
    maxBytes: resolveMatrixInboundMediaMaxBytes(params.mediaMaxMb),
  });
  assertCurrent?.();
  let filePath = downloaded.path;
  let workspacePath = filePath;
  const workspaceDir = params.context.mediaAccess?.workspaceDir;
  if (workspaceDir) {
    const relativePath = path.join("media", "inbound", path.basename(filePath));
    const workspace = await fsRoot(workspaceDir);
    assertCurrent?.();
    await workspace.copyIn(relativePath, filePath, {
      mkdir: true,
      sourceHardlinks: "reject",
      assertBeforeMutation: assertCurrent,
    });
    assertCurrent?.();
    filePath = path.join(workspaceDir, relativePath);
    workspacePath = relativePath.split(path.sep).join("/");
  }
  const size = (await stat(filePath)).size;
  assertCurrent?.();
  const details = {
    ok: true,
    roomId: params.roomId,
    messageId: params.messageId,
    path: filePath,
    contentType: downloaded.contentType,
    size,
    original: true,
    media: { mediaUrl: workspacePath, outbound: false },
  };
  if (params.original || !downloaded.contentType?.toLowerCase().startsWith("image/")) {
    return jsonResult(details);
  }
  const result = await imageResultFromFile({
    label: "matrix-file",
    path: filePath,
    extraText:
      "The original attachment is staged for this conversation; the inline preview may be resized.",
    details,
    imageSanitization: { maxDimensionPx: params.context.cfg.agents?.defaults?.imageMaxDimensionPx },
  });
  assertCurrent?.();
  return result;
}
