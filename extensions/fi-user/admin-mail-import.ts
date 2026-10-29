import { createHash } from "node:crypto";
import path from "node:path";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import {
  delegatedFetch,
  FI_ADMIN_DELEGATION_AGENT_ID,
  lookupDelegation,
  readFiResponse,
  type ResolvedPluginConfig,
} from "./fi-delegation.js";

/** Fi's own import limit (`STANDARD_UPLOAD_MAX_BYTES`). */
const MAX_IMPORT_BYTES = 200 * 1024 * 1024;
const OWNER_TYPES = new Set(["project", "company", "fund", "investing_entity"]);
const CATEGORY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FILENAME_DATE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;
const MAX_PROVENANCE_ID = 320;

export type MailImportDestination = {
  objectType: string;
  objectSlug: string;
  category: string;
  dateDoc?: string;
  filenameDate?: string;
  filenameDateBasis?: string;
};

export type ProvenRequester = {
  connection: ResolvedPluginConfig;
  body: { requesterSenderId: string } | { requesterMatrixUserId: string };
};

type DownloadedFile = {
  bytes: Uint8Array;
  fileName: string;
  mimeType?: string;
  origin: {
    provider: string;
    mailbox: string;
    messageId: string;
    attachmentId: string;
    attachmentPath?: number[];
  };
};

type ImportResult = {
  applied?: boolean;
  documentId?: string | null;
  filename?: string;
  sha256?: string;
  sizeBytes?: number;
  owner?: { type?: string; objectType?: string; objectSlug?: string };
  taxonomy?: { category?: string; family?: string; type?: string };
  ocr?: { state?: string };
};

const refuse = (reason: string) => new Error(`${reason} Nothing was downloaded or imported.`);

/** The Fi owner the requester asked to file under; checked before anything is downloaded. */
export function mailImportDestination(value: unknown): MailImportDestination {
  const v = (value ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof v[key] === "string" ? (v[key] as string).trim() : "");
  const destination: MailImportDestination = {
    objectType: text("objectType"),
    objectSlug: text("objectSlug"),
    category: text("category"),
    ...(text("dateDoc") ? { dateDoc: text("dateDoc") } : {}),
    ...(text("filenameDate") ? { filenameDate: text("filenameDate") } : {}),
    ...(text("filenameDateBasis") ? { filenameDateBasis: text("filenameDateBasis") } : {}),
  };
  if (
    !value ||
    typeof value !== "object" ||
    !OWNER_TYPES.has(destination.objectType) ||
    !destination.objectSlug ||
    destination.objectSlug.length > 200 ||
    !CATEGORY.test(destination.category) ||
    (destination.dateDoc !== undefined && !ISO_DATE.test(destination.dateDoc)) ||
    (destination.filenameDate !== undefined && !FILENAME_DATE.test(destination.filenameDate)) ||
    Boolean(destination.filenameDate) !== Boolean(destination.filenameDateBasis) ||
    (!destination.dateDoc && !destination.filenameDate)
  ) {
    throw refuse(
      "Fi-admin files a mail attachment straight into Fi: pass importTo with objectType (project, company, fund or investing_entity), objectSlug, a library category, and dateDoc (YYYY-MM-DD) or filenameDate with filenameDateBasis.",
    );
  }
  return destination;
}

/**
 * Stream one downloaded mail attachment into Fi's document import as the
 * proven requester, under their own Fi-admin delegation. The bytes stay in
 * this call: nothing is written to the agent's workspace, which every
 * session of the admin agent shares. Fi decides the requester's authority
 * on the owner (owner/admin, or a document grant on it).
 */
export async function importMailAttachment(
  context: OpenClawPluginToolContext,
  destination: MailImportDestination,
  proven: () => ProvenRequester | undefined,
  file: DownloadedFile,
) {
  const assertCurrent = () => {
    if (!context.assertInvocationCurrent) {
      throw new Error("Importing a mail attachment requires a current host-bound invocation");
    }
    context.assertInvocationCurrent();
  };
  assertCurrent();
  const name = file.fileName;
  if (
    !name ||
    name.length > 180 ||
    name !== path.basename(name) ||
    name.includes("\\") ||
    name.startsWith(".") ||
    /\p{Cc}/u.test(name)
  ) {
    throw new Error("The attachment has no usable filename; nothing was imported.");
  }
  if (!file.bytes.length || file.bytes.length > MAX_IMPORT_BYTES) {
    throw new Error("Imported files must be between 1 byte and 200 MB; nothing was imported.");
  }
  const requester = proven();
  if (!requester) {
    throw new Error(
      "This turn's requester is no longer verified; nothing was imported. Ask again from the conversation.",
    );
  }
  const delegation = await lookupDelegation(requester.connection, requester.body, {
    agentId: FI_ADMIN_DELEGATION_AGENT_ID,
    signal: AbortSignal.timeout(15_000),
  });
  if (!delegation) {
    throw new Error("The requester is not linked to an active Fi member; nothing was imported.");
  }
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  // A member importing on a document grant may not assert provenance; Fi refuses it.
  const admin = ["owner", "admin"].includes(delegation.user.role);
  const provenance = {
    source: "m365_mail_attachment",
    original_filename: name,
    ...(file.origin.messageId.length <= MAX_PROVENANCE_ID
      ? { message_id: file.origin.messageId }
      : {}),
    ...(file.origin.attachmentId.length <= MAX_PROVENANCE_ID
      ? { file_id: file.origin.attachmentId }
      : {}),
  };
  const form = new FormData();
  const body = file.bytes.buffer.slice(
    file.bytes.byteOffset,
    file.bytes.byteOffset + file.bytes.byteLength,
  ) as ArrayBuffer;
  form.set("file", new Blob([body], { type: file.mimeType || "application/octet-stream" }), name);
  form.set(
    "input",
    JSON.stringify({
      actor: delegation.user.email,
      ...destination,
      ...(admin ? { provenance } : {}),
    }),
  );
  assertCurrent();
  if (JSON.stringify(proven()?.body) !== JSON.stringify(requester.body)) {
    throw new Error(
      "This turn's requester changed during the download; nothing was imported. Ask again from the conversation.",
    );
  }
  const response = await delegatedFetch(
    requester.connection,
    delegation,
    `/api/${encodeURIComponent(delegation.user.orgSlug)}/documents/import`,
    { method: "POST", body: form, signal: AbortSignal.timeout(300_000) },
  );
  const reply = (await readFiResponse(response).catch(() => null)) as {
    ok?: boolean;
    result?: ImportResult;
    warnings?: unknown;
    error?: unknown;
    code?: unknown;
  } | null;
  if (response.status === 409 && reply?.code === "conflict") {
    return {
      status: "already_in_fi",
      fileName: name,
      bytes: file.bytes.length,
      sha256,
      detail: typeof reply.error === "string" ? reply.error.slice(0, 500) : null,
      next: "Fi already holds these exact bytes; use that document. Nothing new was imported and nothing was saved to the workspace.",
    };
  }
  if (!response.ok) {
    const detail = typeof reply?.error === "string" ? `: ${reply.error.slice(0, 500)}` : "";
    throw new Error(
      `Fi refused the import (${response.status})${detail}. Nothing was saved to the workspace.`,
    );
  }
  const result = reply?.result;
  if (
    reply?.ok !== true ||
    result?.applied !== true ||
    typeof result.documentId !== "string" ||
    !result.documentId ||
    result.sha256 !== sha256
  ) {
    throw new Error(
      "The import may have been registered, but Fi did not confirm it. Look the file up in Fi before retrying.",
    );
  }
  return {
    status: "imported_to_fi",
    documentId: result.documentId,
    fileName: result.filename ?? name,
    originalFileName: name,
    bytes: result.sizeBytes ?? file.bytes.length,
    sha256,
    mimeType: file.mimeType || "application/octet-stream",
    owner: result.owner
      ? { objectType: result.owner.objectType, objectSlug: result.owner.objectSlug }
      : { objectType: destination.objectType, objectSlug: destination.objectSlug },
    taxonomy: result.taxonomy ?? null,
    ocr: result.ocr?.state ?? null,
    warnings: Array.isArray(reply.warnings)
      ? reply.warnings.filter((w): w is string => typeof w === "string")
      : [],
    next: "File this documentId into the room with the Fi room commands. The file is in Fi only; nothing was saved to the workspace.",
  };
}
