import { createHash } from "node:crypto";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { Type } from "typebox";

export const ROOM_READ_FIELDS = {
  view: Type.Optional(
    stringEnum(["full", "placement"] as const, {
      description:
        "For get: placement returns a bounded inventory; follow nextCursor until complete before choosing a section. Full preserves the complete room response.",
    }),
  ),
  cursor: Type.Optional(
    Type.String({
      maxLength: 512,
      description: "For get view=placement: nextCursor from the previous page of this same room.",
    }),
  ),
};

type Row = Record<string, unknown>;
export type PlacementSnapshot = {
  roomVersion?: number;
  room?: Row;
  documents?: Row[];
  tasks?: Row[];
};

const PAGE_CHAR_LIMIT = 8_000;
const FIELDS = {
  documentId: 200,
  id: 200,
  filename: 300,
  displayName: 300,
  roomCategory: 200,
  orderKey: 100,
  visibility: 30,
  title: 300,
  status: 30,
  taskType: 50,
  descriptionMarkdown: 600,
} as const;

function placementRow(row: Row): Row {
  const result: Row = {};
  let detailsTruncated = false;
  for (const [field, limit] of Object.entries(FIELDS)) {
    const value = row[field];
    if (value === null) {
      result[field] = null;
    } else if (typeof value === "string") {
      result[field] = value.slice(0, limit);
      detailsTruncated ||= value.length > limit;
    }
  }
  if (typeof row.isHighlighted === "boolean") {
    result.isHighlighted = row.isHighlighted;
  }
  for (const field of ["documentIds", "tags"] as const) {
    const values = row[field];
    if (!Array.isArray(values)) {
      continue;
    }
    const valid = values.filter((value): value is string => typeof value === "string");
    result[field] = valid.slice(0, 12).map((value) => value.slice(0, 200));
    detailsTruncated ||= valid.length > 12 || valid.some((value) => value.length > 200);
  }
  if (detailsTruncated) {
    result.detailsTruncated = true;
  }
  return result;
}

/** A cursor is a read locator, never a grant. Every page starts with a fresh delegated read. */
export function roomPlacementPage(roomId: string, snapshot: PlacementSnapshot, cursor?: string) {
  if (!Array.isArray(snapshot.documents) || !Array.isArray(snapshot.tasks)) {
    throw new Error(
      "The room placement inventory is incomplete; fetch its documents and checklist before filing. Do not escalate permissions because a read is incomplete.",
    );
  }
  const documents = snapshot.documents.map(placementRow);
  const tasks = snapshot.tasks.map(placementRow);
  const version = snapshot.roomVersion ?? snapshot.room?.roomVersion;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([roomId, version, snapshot.room, snapshot.documents, snapshot.tasks]))
    .digest("hex");
  const count = documents.length + tasks.length;
  let offset = 0;
  if (cursor) {
    try {
      if (cursor.length > 512 || !/^rp1_[A-Za-z0-9_-]+$/.test(cursor)) {
        throw new Error();
      }
      const value: unknown = JSON.parse(Buffer.from(cursor.slice(4), "base64url").toString("utf8"));
      if (!value || typeof value !== "object") {
        throw new Error();
      }
      const decoded = value as Record<string, unknown>;
      if (
        decoded.roomId !== roomId ||
        decoded.fingerprint !== fingerprint ||
        !Number.isSafeInteger(decoded.offset) ||
        Number(decoded.offset) <= 0 ||
        Number(decoded.offset) >= count
      ) {
        throw new Error();
      }
      offset = Number(decoded.offset);
    } catch {
      throw new Error(
        "The room placement cursor is invalid or the room changed. Restart get with view=placement and no cursor; do not combine different room versions.",
      );
    }
  }
  const pageDocuments: Row[] = [];
  const pageTasks: Row[] = [];
  let chars = 0;
  let end = offset;
  while (end < count) {
    const isDocument = end < documents.length;
    const item = isDocument ? documents[end] : tasks[end - documents.length];
    if (!item) {
      throw new Error("The room placement inventory changed while preparing this page.");
    }
    const size = JSON.stringify(item).length;
    if (end > offset && chars + size > PAGE_CHAR_LIMIT) {
      break;
    }
    (isDocument ? pageDocuments : pageTasks).push(item);
    chars += size;
    end++;
  }
  return {
    roomId,
    roomVersion: version,
    view: "placement",
    documents: pageDocuments,
    tasks: pageTasks,
    counts: { documents: documents.length, tasks: tasks.length },
    complete: end === count,
    ...(end < count
      ? {
          nextCursor: `rp1_${Buffer.from(JSON.stringify({ roomId, fingerprint, offset: end })).toString("base64url")}`,
        }
      : {}),
    note: "Placement inventory only. Follow nextCursor until complete; omitted details are not missing documents. Use get with documentId or tasks with taskId for exact full details. Room settings remain in get view=full. Incomplete reads never justify wider grants.",
  };
}

/** Select a projection only after the caller has fetched the authorized snapshot. */
export function roomReadView(
  roomId: string,
  snapshot: PlacementSnapshot,
  input: { view?: "full" | "placement"; cursor?: string; documentId?: string },
) {
  if (input.view === "placement") {
    return roomPlacementPage(roomId, snapshot, input.cursor);
  }
  if (input.cursor) {
    throw new Error("cursor requires get with view=placement");
  }
  if (!input.documentId) {
    return snapshot;
  }
  const version = snapshot.roomVersion ?? snapshot.room?.roomVersion;
  return {
    roomVersion: Number.isSafeInteger(version) ? version : undefined,
    document:
      snapshot.documents?.find((document) => document.documentId === input.documentId) ?? null,
  };
}
