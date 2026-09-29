import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import {
  delegatedJson,
  exchange,
  pathSegment,
  type Delegation,
  type RequesterIdentity,
  type ResolvedPluginConfig,
} from "./fi-delegation.js";
import {
  downloadDriveFile,
  downloadedFiles,
  driveFilingExportArgs,
  requireMailbox,
  runGam,
} from "./gam.js";
import {
  downloadSlackFile,
  resolveRequesterSlackFile,
  slackBotToken,
  slackConversation,
} from "./slack-files.js";

/**
 * The data-room operations fi-user performs as the requester. Everything else
 * — members, recipients, public links, reinvites, view-as, room settings and
 * deletion — stays with administrators; there is no pass-through.
 */
export const DATAROOM_ACTIONS = [
  "list",
  "get",
  "tasks",
  "available_docs",
  "add_document",
  "update_document",
  "link_task",
  "complete_task",
  "upload_gmail_attachment",
  "upload_slack_file",
  "upload_drive_file",
  "upload_to_project_library",
] as const;
type DataRoomAction = (typeof DATAROOM_ACTIONS)[number];

/** Project-library categories Fi accepts as a placement hint (mirrors Fi's
 * `[projectSlug]/docs/upload`). The document still lands unclassified. */
export const PROJECT_LIBRARY_CATEGORIES = [
  "construction",
  "financing",
  "acquisition",
  "tax",
  "commercial",
  "governance",
  "hr",
  "insurance",
  "formation",
  "banking",
] as const;

const DataRoomSchema = Type.Object(
  {
    action: stringEnum(DATAROOM_ACTIONS),
    roomId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    documentId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    documentIds: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 50 }),
    ),
    taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    completed: Type.Optional(Type.Boolean()),
    scopeType: Type.Optional(Type.String({ maxLength: 50 })),
    scopeId: Type.Optional(Type.String({ maxLength: 200 })),
    displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    section: Type.Optional(
      Type.String({
        maxLength: 200,
        description:
          "Room section (room category); for upload_to_project_library, the folder within the library category (e.g. permits).",
      }),
    ),
    project: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        description: "Project slug whose document library receives upload_to_project_library.",
      }),
    ),
    category: Type.Optional(
      stringEnum(PROJECT_LIBRARY_CATEGORIES, {
        description:
          "Project-library category for upload_to_project_library. Default construction.",
      }),
    ),
    orderKey: Type.Optional(Type.String({ maxLength: 100 })),
    visibility: Type.Optional(stringEnum(["shared", "internal"] as const)),
    highlighted: Type.Optional(Type.Boolean()),
    acknowledgeRestricted: Type.Optional(Type.Boolean()),
    messageId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]+$" })),
    attachmentName: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    slackFileId: Type.Optional(Type.String({ pattern: "^F[A-Za-z0-9]{6,}$" })),
    slackFileName: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    driveFileId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]+$" })),
  },
  { additionalProperties: false },
);

type DataRoomInput = {
  action: DataRoomAction;
  roomId?: string;
  documentId?: string;
  documentIds?: string[];
  taskId?: string;
  completed?: boolean;
  scopeType?: string;
  scopeId?: string;
  displayName?: string;
  section?: string;
  project?: string;
  category?: (typeof PROJECT_LIBRARY_CATEGORIES)[number];
  orderKey?: string;
  visibility?: "shared" | "internal";
  highlighted?: boolean;
  acknowledgeRestricted?: boolean;
  messageId?: string;
  attachmentName?: string;
  slackFileId?: string;
  slackFileName?: string;
  driveFileId?: string;
};

type RoomSnapshot = {
  roomVersion?: number;
  room?: { roomVersion?: number };
  documents?: Array<Record<string, unknown> & { documentId?: string }>;
  tasks?: Array<Record<string, unknown> & { id?: string; documentIds?: string[] }>;
};

type Ctx = { config: ResolvedPluginConfig; delegation: Delegation; root: string };

function idempotencyKey(delegation: Delegation, operation: unknown): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([delegation.user.email, operation]))
    .digest("hex");
  return `fi-user:${digest.slice(0, 48)}`;
}

async function snapshot(ctx: Ctx, roomId: string): Promise<RoomSnapshot> {
  return (await delegatedJson(
    ctx.config,
    ctx.delegation,
    `${ctx.root}/${roomId}`,
    { method: "GET" },
    "Fi data-room read",
  )) as RoomSnapshot;
}

function roomVersion(room: RoomSnapshot): number | undefined {
  const version = room.roomVersion ?? room.room?.roomVersion;
  return Number.isSafeInteger(version) ? version : undefined;
}

function preconditions(delegation: Delegation, room: RoomSnapshot, operation: unknown) {
  const version = roomVersion(room);
  return {
    "idempotency-key": idempotencyKey(delegation, operation),
    ...(version ? { "if-match": String(version) } : {}),
  };
}

async function write(
  ctx: Ctx,
  roomId: string,
  pathname: string,
  method: "POST" | "PATCH",
  body: Record<string, unknown>,
): Promise<unknown> {
  const room = await snapshot(ctx, roomId);
  return delegatedJson(
    ctx.config,
    ctx.delegation,
    pathname,
    {
      method,
      headers: {
        "content-type": "application/json",
        ...preconditions(ctx.delegation, room, { method, pathname, body }),
      },
      body: JSON.stringify(body),
    },
    "Fi data-room write",
  );
}

async function readback(ctx: Ctx, roomId: string, documentId?: string, taskId?: string) {
  const room = await snapshot(ctx, roomId);
  return {
    roomVersion: roomVersion(room),
    ...(documentId
      ? { document: room.documents?.find((document) => document.documentId === documentId) ?? null }
      : {}),
    ...(taskId ? { task: room.tasks?.find((task) => task.id === taskId) ?? null } : {}),
  };
}

async function roomTasks(ctx: Ctx, roomId: string) {
  const room = await snapshot(ctx, roomId);
  if (Array.isArray(room.tasks)) {
    return room.tasks;
  }
  const listed = (await delegatedJson(
    ctx.config,
    ctx.delegation,
    `${ctx.root}/${roomId}/tasks`,
    { method: "GET" },
    "Fi data-room tasks",
  )) as { tasks?: RoomSnapshot["tasks"] } | RoomSnapshot["tasks"];
  return (Array.isArray(listed) ? listed : listed?.tasks) ?? [];
}

async function uploadBytes(
  ctx: Ctx,
  roomId: string,
  input: DataRoomInput,
  file: { bytes: Uint8Array; name: string },
  provenance?: { messageId?: string; fileId?: string; url?: string },
) {
  const room = await snapshot(ctx, roomId);
  const form = new FormData();
  const body = file.bytes.buffer.slice(
    file.bytes.byteOffset,
    file.bytes.byteOffset + file.bytes.byteLength,
  ) as ArrayBuffer;
  form.set("file", new Blob([body]), file.name);
  if (input.displayName) {
    form.set("displayName", input.displayName);
  }
  if (input.visibility) {
    form.set("visibility", input.visibility);
  }
  if (input.acknowledgeRestricted) {
    form.set("acknowledgeRestricted", "true");
  }
  if (provenance) {
    form.set("provenanceSource", "slack");
    if (provenance.messageId) {
      form.set("provenanceMessageId", provenance.messageId);
    }
    if (provenance.fileId) {
      form.set("provenanceFileId", provenance.fileId);
    }
    if (provenance.url) {
      form.set("provenanceUrl", provenance.url);
    }
    form.set("provenanceOriginalFilename", file.name);
  }
  const uploaded = (await delegatedJson(
    ctx.config,
    ctx.delegation,
    `${ctx.root}/${roomId}/documents/upload`,
    {
      method: "POST",
      headers: preconditions(ctx.delegation, room, {
        upload: roomId,
        name: file.name,
        size: file.bytes.byteLength,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
      }),
      body: form,
    },
    "Fi data-room upload",
  )) as { document?: { documentId?: string; id?: string } };
  const documentId = uploaded.document?.documentId ?? uploaded.document?.id;
  // Placement (section/order/highlight) is a separate presentation write.
  if (documentId && (input.section || input.orderKey || input.highlighted !== undefined)) {
    await write(
      ctx,
      roomId,
      `${ctx.root}/${roomId}/documents/${pathSegment(documentId, "documentId")}`,
      "PATCH",
      {
        ...(input.section ? { roomCategory: input.section } : {}),
        ...(input.orderKey ? { orderKey: input.orderKey } : {}),
        ...(input.highlighted !== undefined ? { isHighlighted: input.highlighted } : {}),
      },
    );
  }
  return {
    uploaded: file.name,
    documentId: documentId ?? null,
    ...(documentId ? await readback(ctx, roomId, documentId) : {}),
  };
}

/** A Slack file the verified requester posted in this conversation, with its
 * Slack provenance. Anything else is refused before any bytes are read. */
async function requesterSlackUpload(
  context: OpenClawPluginToolContext,
  identity: RequesterIdentity,
  input: DataRoomInput,
) {
  if (identity.channel !== "slack") {
    throw new Error(`${input.action} is available in Slack conversations only`);
  }
  const conversation = slackConversation(context);
  const token = slackBotToken(context);
  if (!conversation || !token) {
    throw new Error("This Slack conversation cannot be verified for file access");
  }
  const file = await resolveRequesterSlackFile({
    token,
    conversation,
    requesterSenderId: identity.requesterSenderId,
    fileId: input.slackFileId,
    fileName: input.slackFileName,
  });
  const bytes = await downloadSlackFile(token, file);
  return {
    file: { bytes, name: file.name ?? file.id },
    provenance: {
      fileId: file.id,
      ...(file.permalink ? { url: file.permalink } : {}),
      ...(conversation.threadTs ? { messageId: conversation.threadTs } : {}),
    },
  };
}

/**
 * File a Slack file into a project's document library (not a data room) under
 * the requester's own project grant. Fi lands it restricted and unclassified
 * with the Slack provenance and audits it to the requester.
 */
async function uploadToProjectLibrary(
  ctx: Ctx,
  input: DataRoomInput,
  upload: Awaited<ReturnType<typeof requesterSlackUpload>>,
) {
  const project = pathSegment(input.project, "project");
  const form = new FormData();
  const body = upload.file.bytes.buffer.slice(
    upload.file.bytes.byteOffset,
    upload.file.bytes.byteOffset + upload.file.bytes.byteLength,
  ) as ArrayBuffer;
  form.set("file", new Blob([body]), upload.file.name);
  if (input.category) {
    form.set("category", input.category);
  }
  if (input.section) {
    form.set("section", input.section);
  }
  form.set("provenanceSource", "slack");
  form.set("provenanceFileId", upload.provenance.fileId);
  if (upload.provenance.messageId) {
    form.set("provenanceMessageId", upload.provenance.messageId);
  }
  if (upload.provenance.url) {
    form.set("provenanceUrl", upload.provenance.url);
  }
  form.set("provenanceOriginalFilename", upload.file.name);
  const result = (await delegatedJson(
    ctx.config,
    ctx.delegation,
    `/api/${encodeURIComponent(ctx.delegation.user.orgSlug)}/${project}/docs/upload`,
    { method: "POST", body: form },
    "Fi project library upload",
  )) as { duplicate?: boolean; projectSlug?: string; document?: Record<string, unknown> };
  return {
    uploaded: upload.file.name,
    project: result.projectSlug ?? decodeURIComponent(project),
    duplicate: result.duplicate === true,
    document: result.document ?? null,
    note: result.duplicate
      ? "These exact bytes were already in the project's library; no second copy was filed."
      : "Filed restricted and unclassified; Fi classifies it after text extraction. Only people with the project's documents grant see it until then.",
  };
}

export function createDataRoomTool(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    name: "fi_user_dataroom",
    label: "My Fi Data Rooms",
    description:
      "Work in Fi data rooms as the current verified requester, under their own room grants: list rooms, read a room and its checklist, add an existing Fi document, set a document's section/order/visibility within the room, link a document to a checklist task or complete a task, and upload a file from the requester's own Gmail, from a Slack file they posted in this conversation, or from their own Google Drive. upload_to_project_library files a Slack file the requester posted in this conversation into a PROJECT's document library (project slug, optional category and section) under their own project grant — it lands restricted and unclassified, not in any room. Every write is read back from Fi. Members, recipients, public links and room settings are administrator actions and are not available here.",
    parameters: DataRoomSchema,
    async execute(_toolCallId, raw) {
      const input = raw as DataRoomInput;
      const { delegation, config, identity } = await exchange(api, context);
      const ctx: Ctx = {
        config,
        delegation,
        root: `/api/${encodeURIComponent(delegation.user.orgSlug)}/datarooms`,
      };

      if (input.action === "list") {
        const params = new URLSearchParams();
        if (input.scopeType) {
          params.set("scopeType", input.scopeType);
        }
        if (input.scopeId) {
          params.set("scopeId", input.scopeId);
        }
        const search = params.toString();
        return jsonResult(
          await delegatedJson(
            config,
            delegation,
            search ? `${ctx.root}?${search}` : ctx.root,
            {},
            "Fi data-room list",
          ),
        );
      }
      if (input.action === "available_docs") {
        // Library documents in the room's scope that are not in the room yet.
        const params = new URLSearchParams();
        if (input.scopeType) {
          params.set("scopeType", input.scopeType);
        }
        if (input.scopeId) {
          params.set("scopeId", input.scopeId);
        }
        if (input.roomId) {
          params.set("excludeRoomId", input.roomId);
        }
        const search = params.toString();
        return jsonResult(
          await delegatedJson(
            config,
            delegation,
            `${ctx.root}/available-docs${search ? `?${search}` : ""}`,
            {},
            "Fi available documents",
          ),
        );
      }

      if (input.action === "upload_to_project_library") {
        pathSegment(input.project, "project");
        return jsonResult(
          await uploadToProjectLibrary(
            ctx,
            input,
            await requesterSlackUpload(context, identity, input),
          ),
        );
      }

      const roomId = pathSegment(input.roomId, "roomId");
      if (input.action === "get") {
        return jsonResult(await snapshot(ctx, roomId));
      }
      if (input.action === "tasks") {
        return jsonResult({ tasks: await roomTasks(ctx, roomId) });
      }
      if (input.action === "add_document") {
        const documentId = pathSegment(input.documentId, "documentId");
        await write(ctx, roomId, `${ctx.root}/${roomId}/documents`, "POST", {
          documentId: decodeURIComponent(documentId),
          ...(input.displayName ? { displayName: input.displayName } : {}),
          ...(input.visibility ? { visibility: input.visibility } : {}),
          ...(input.acknowledgeRestricted ? { acknowledgeRestricted: true } : {}),
        });
        if (input.section || input.orderKey || input.highlighted !== undefined) {
          await write(ctx, roomId, `${ctx.root}/${roomId}/documents/${documentId}`, "PATCH", {
            ...(input.section ? { roomCategory: input.section } : {}),
            ...(input.orderKey ? { orderKey: input.orderKey } : {}),
            ...(input.highlighted !== undefined ? { isHighlighted: input.highlighted } : {}),
          });
        }
        return jsonResult({
          added: decodeURIComponent(documentId),
          ...(await readback(ctx, roomId, decodeURIComponent(documentId))),
        });
      }
      if (input.action === "update_document") {
        const documentId = pathSegment(input.documentId, "documentId");
        const body = {
          ...(input.displayName ? { displayName: input.displayName } : {}),
          ...(input.section !== undefined ? { roomCategory: input.section || null } : {}),
          ...(input.orderKey !== undefined ? { orderKey: input.orderKey || null } : {}),
          ...(input.visibility ? { visibility: input.visibility } : {}),
          ...(input.highlighted !== undefined ? { isHighlighted: input.highlighted } : {}),
        };
        if (Object.keys(body).length === 0) {
          throw new Error("Provide displayName, section, orderKey, visibility or highlighted");
        }
        await write(ctx, roomId, `${ctx.root}/${roomId}/documents/${documentId}`, "PATCH", body);
        return jsonResult({
          updated: decodeURIComponent(documentId),
          ...(await readback(ctx, roomId, decodeURIComponent(documentId))),
        });
      }
      if (input.action === "link_task") {
        const taskId = pathSegment(input.taskId, "taskId");
        const add = input.documentIds ?? (input.documentId ? [input.documentId] : []);
        if (add.length === 0) {
          throw new Error("documentId or documentIds is required to link a task");
        }
        const task = (await roomTasks(ctx, roomId)).find(
          (entry) => entry.id === decodeURIComponent(taskId),
        );
        if (!task) {
          throw new Error("That checklist task is not in this room");
        }
        const documentIds = [...new Set([...(task.documentIds ?? []), ...add])];
        await write(ctx, roomId, `${ctx.root}/${roomId}/tasks/${taskId}`, "PATCH", { documentIds });
        return jsonResult({
          linked: add,
          ...(await readback(ctx, roomId, undefined, decodeURIComponent(taskId))),
        });
      }
      if (input.action === "complete_task") {
        const taskId = pathSegment(input.taskId, "taskId");
        await write(ctx, roomId, `${ctx.root}/${roomId}/tasks/${taskId}`, "PATCH", {
          completed: input.completed ?? true,
        });
        return jsonResult({
          completed: input.completed ?? true,
          ...(await readback(ctx, roomId, undefined, decodeURIComponent(taskId))),
        });
      }

      if (input.action === "upload_slack_file") {
        const upload = await requesterSlackUpload(context, identity, input);
        return jsonResult(await uploadBytes(ctx, roomId, input, upload.file, upload.provenance));
      }

      const mailbox = requireMailbox(
        delegation,
        input.action === "upload_drive_file" ? "Google Drive" : "Gmail",
      );
      if (input.action === "upload_drive_file") {
        if (!input.driveFileId) {
          throw new Error("driveFileId is required for upload_drive_file");
        }
        const downloaded = await downloadDriveFile({
          config,
          mailbox,
          fileId: input.driveFileId,
          exportArgs: driveFilingExportArgs,
        });
        try {
          const bytes = new Uint8Array(await fs.readFile(downloaded.filePath));
          return jsonResult({
            source: { drive: downloaded.metadata },
            ...(await uploadBytes(ctx, roomId, input, {
              bytes,
              name: path.basename(downloaded.filePath),
            })),
          });
        } finally {
          await fs.rm(downloaded.tempDir, { recursive: true, force: true });
        }
      }

      // upload_gmail_attachment
      if (!input.messageId) {
        throw new Error("roomId and messageId are required for attachment upload");
      }
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fi-user-mail-"));
      try {
        await runGam(config, mailbox, [
          "show",
          "messages",
          "ids",
          input.messageId,
          "saveattachments",
          "targetfolder",
          tempDir,
        ]);
        const files = await downloadedFiles(tempDir);
        const selected = input.attachmentName
          ? files.find(
              (file) => path.basename(file).toLowerCase() === input.attachmentName?.toLowerCase(),
            )
          : files.length === 1
            ? files[0]
            : undefined;
        if (!selected) {
          throw new Error(
            input.attachmentName
              ? `Attachment not found: ${input.attachmentName}`
              : `Expected one attachment but found ${files.length}; provide attachmentName`,
          );
        }
        const bytes = new Uint8Array(await fs.readFile(selected));
        return jsonResult({
          mailbox,
          attachment: path.basename(selected),
          ...(await uploadBytes(ctx, roomId, input, { bytes, name: path.basename(selected) })),
        });
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
  };
}
