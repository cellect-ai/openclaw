import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  LifecycleRecordReceipt,
  LifecycleResultReceipt,
} from "./conversation-lifecycle-record.worker.js";

export function lifecycleWriteFingerprint(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function readLifecycleRecordReceipt(value: unknown): LifecycleRecordReceipt {
  if (
    !isRecord(value) ||
    typeof value.adopted !== "boolean" ||
    !Array.isArray(value.rows) ||
    !Array.isArray(value.overtaken)
  ) {
    throw new Error("Invalid lifecycle record commit receipt");
  }
  const rows = value.rows.map((row: unknown) => {
    if (
      !isRecord(row) ||
      typeof row.id !== "string" ||
      typeof row.live !== "boolean" ||
      typeof row.activeAt !== "number"
    )
      throw new Error("Invalid lifecycle row commit receipt");
    return { id: row.id, live: row.live, activeAt: row.activeAt };
  });
  const overtaken = value.overtaken.map((row: unknown) => {
    if (!isRecord(row) || typeof row.id !== "string" || typeof row.roomId !== "string") {
      throw new Error("Invalid lifecycle terminal commit receipt");
    }
    return { id: row.id, roomId: row.roomId };
  });
  return { rows, overtaken, adopted: value.adopted };
}

export function readLifecycleResultReceipt(value: unknown): LifecycleResultReceipt {
  if (
    !isRecord(value) ||
    (value.roomId !== undefined && typeof value.roomId !== "string") ||
    (value.legacySettled !== undefined && value.legacySettled !== true) ||
    (value.legacySettled === true && value.roomId !== undefined)
  ) {
    throw new Error("Invalid lifecycle result commit receipt");
  }
  return value.legacySettled === true
    ? { legacySettled: true }
    : value.roomId === undefined
      ? {}
      : { roomId: value.roomId };
}
