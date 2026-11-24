import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MessageEventContent } from "./sdk.js";

/** One media descriptor for current ingress and later authorized retrieval. */
export function resolveMatrixInboundMediaContent(content: MessageEventContent) {
  const file = content.file && typeof content.file === "object" ? content.file : undefined;
  const info =
    content.info && typeof content.info === "object"
      ? (content.info as { mimetype?: string; size?: number })
      : undefined;
  const body = normalizeOptionalString(content.body);
  return {
    url: normalizeOptionalString(content.url) ?? normalizeOptionalString(file?.url),
    file,
    body: body ?? "",
    contentType: info?.mimetype,
    sizeBytes: typeof info?.size === "number" ? info.size : undefined,
    originalFilename: normalizeOptionalString(content.filename) ?? body,
  };
}
